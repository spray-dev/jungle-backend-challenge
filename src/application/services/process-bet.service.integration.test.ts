import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config.js";
import { Money } from "../../domain/money.js";
import { Wallet } from "../../domain/wallet.js";
import { ConcurrencyConflictError } from "../../domain/ports/concurrency-conflict.error.js";
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from "../../domain/wager-transaction.js";
import { MikroOrmWalletRepository } from "../../persistence/repositories/mikro-orm-wallet.repository.js";
import { MikroOrmWagerTransactionRepository } from "../../persistence/repositories/mikro-orm-wager-transaction.repository.js";
import { ProcessBetService, createBetRepositories, type BetRepositoryFactory } from "./process-bet.service.js";

let orm: MikroORM;
const walletIds = new Set<string>();
beforeAll(async () => { orm = await MikroORM.init(config); });
afterEach(async () => {
    for (const id of walletIds) {
        await orm.em.getConnection().execute("delete from wallet_ledger_entries where wallet_id = ?", [id]);
        await orm.em.getConnection().execute("delete from wager_transactions where wallet_id = ?", [id]);
        await orm.em.getConnection().execute("delete from wallets where id = ?", [id]);
    }
    walletIds.clear();
});
afterAll(async () => { await orm?.close(); });

async function setupWallet() {
    const id = crypto.randomUUID();
    walletIds.add(id);
    const wallet = Wallet.open({ id, playerId: `player-${id}`, initialBalance: Money.from({ amount: "100.00", currency: "BRL" }) });
    await new MikroOrmWalletRepository(orm.em.fork()).create(wallet);
    return wallet;
}

async function setupBet(wallet: Wallet, amount = "20.00", overrides: { currency?: string; playerId?: string; kind?: Kind } = {}) {
    const id = crypto.randomUUID();
    const bet = WagerTransaction.create({
        id, providerId: "integration", externalTransactionId: id, idempotencyKey: id, payloadHash: id,
        walletId: wallet.id, playerId: overrides.playerId ?? wallet.playerId, roundId: id, gameId: "game",
        kind: overrides.kind ?? Kind.Bet, money: Money.from({ amount, currency: overrides.currency ?? "BRL" }), createdAt: new Date(),
    });
    await new MikroOrmWagerTransactionRepository(orm.em.fork()).insert(bet);
    return bet;
}

async function verify(walletId: string, balance: string, version: number, entries: number) {
    const wallet = await new MikroOrmWalletRepository(orm.em.fork()).findById(walletId);
    expect(wallet?.balance.toJSON().amount).toBe(balance);
    expect(wallet?.version).toBe(version);
    const rows = await orm.em.getConnection().execute("select * from wallet_ledger_entries where wallet_id = ?", [walletId]);
    expect(rows).toHaveLength(entries);
    // O saldo inicial desta fixture é 100; os débitos devem reconciliar com ele.
    const [sum] = await orm.em.getConnection().execute("select (100.00 - coalesce(sum(amount), 0))::numeric(18,2)::text as balance from wallet_ledger_entries where wallet_id = ?", [walletId]);
    expect(sum.balance).toBe(balance);
    return rows;
}

describe("ProcessBetService integration", () => {
    it("commits the debit, ledger and processed status together", async () => {
        const wallet = await setupWallet();
        const bet = await setupBet(wallet);
        const result = await new ProcessBetService(orm.em.fork()).execute(bet.id);
        expect(result.status).toBe(Status.Processed);
        const stored = await new MikroOrmWagerTransactionRepository(orm.em.fork()).findById(bet.id);
        expect(stored?.status).toBe(Status.Processed);
        expect(stored?.processedAt).toBeInstanceOf(Date);
        const rows = await verify(wallet.id, "80.00", 2, 1);
        expect(rows[0].transaction_id).toBe(bet.id);
        expect(rows[0].direction).toBe("DEBIT");
        expect(rows[0].amount).toBe("20.00");
        expect(rows[0].balance_before).toBe("100.00");
        expect(rows[0].balance_after).toBe("80.00");
    });

    it("persists insufficient funds as a terminal rejection without a debit", async () => {
        const wallet = await setupWallet();
        const bet = await setupBet(wallet, "120.00");
        const service = new ProcessBetService(orm.em.fork());
        const result = await service.execute(bet.id);
        expect(result.status).toBe(Status.Rejected);
        expect(result.failureCode).toBe("INSUFFICIENT_FUNDS");
        expect((await service.execute(bet.id)).failureCode).toBe("INSUFFICIENT_FUNDS");
        await verify(wallet.id, "100.00", 1, 0);
    });

    for (const [overrides, amount, code] of [
        [{ currency: "USD" }, "20.00", "CURRENCY_MISMATCH"],
        [{ playerId: "another-player" }, "20.00", "PLAYER_MISMATCH"],
        [{}, "0.00", "INVALID_AMOUNT"],
    ] as const) {
        it(`rejects ${code} without modifying wallet or ledger`, async () => {
            const wallet = await setupWallet();
            const bet = await setupBet(wallet, amount, overrides);
            const result = await new ProcessBetService(orm.em.fork()).execute(bet.id);
            expect(result.status).toBe(Status.Rejected);
            expect(result.failureCode).toBe(code);
            await verify(wallet.id, "100.00", 1, 0);
        });
    }

    for (const failurePoint of ["ledger", "status"] as const) {
        it(`rolls back all writes on failure after ${failurePoint} insert/update and can retry`, async () => {
            const wallet = await setupWallet();
            const bet = await setupBet(wallet);
            let attempts = 0;
            const factory: BetRepositoryFactory = (tx) => {
                attempts++;
                const repositories = createBetRepositories(tx);
                if (failurePoint === "ledger") {
                    const insert = repositories.ledger.insert.bind(repositories.ledger);
                    repositories.ledger.insert = async (entry) => { await insert(entry); throw new Error("injected failure"); };
                } else {
                    const update = repositories.wagers.update.bind(repositories.wagers);
                    repositories.wagers.update = async (...args) => { await update(...args); throw new Error("injected failure"); };
                }
                return repositories;
            };
            await expect(new ProcessBetService(orm.em.fork(), factory).execute(bet.id)).rejects.toThrow("injected failure");
            expect(attempts).toBe(1);
            expect((await new MikroOrmWagerTransactionRepository(orm.em.fork()).findById(bet.id))?.status).toBe(Status.Pending);
            await verify(wallet.id, "100.00", 1, 0);
            await new ProcessBetService(orm.em.fork()).execute(bet.id);
            await verify(wallet.id, "80.00", 2, 1);
        });
    }

    it("processes 50 parallel deliveries of the same BET only once", async () => {
        const wallet = await setupWallet();
        const bet = await setupBet(wallet);
        const results = await Promise.all(Array.from({ length: 50 }, () => new ProcessBetService(orm.em.fork()).execute(bet.id)));
        expect(results.every(result => result.status === Status.Processed)).toBe(true);
        expect(new Set(results.map(result => result.processedAt?.getTime())).size).toBe(1);
        await verify(wallet.id, "80.00", 2, 1);
    });

    it("retries a real stale wallet snapshot: two BETs of 80 leave 20 and one rejection", async () => {
        const wallet = await setupWallet();
        const bets = await Promise.all([setupBet(wallet, "80.00"), setupBet(wallet, "80.00")]);
        let reads = 0;
        let release!: () => void;
        const bothRead = new Promise<void>(resolve => { release = resolve; });
        const factory: BetRepositoryFactory = tx => {
            const repositories = createBetRepositories(tx);
            const find = repositories.wallets.findById.bind(repositories.wallets);
            repositories.wallets.findById = async id => {
                const snapshot = await find(id);
                reads++;
                if (reads <= 2) {
                    if (reads === 2) release();
                    await bothRead;
                }
                return snapshot;
            };
            return repositories;
        };
        const results = await Promise.all(bets.map(bet => new ProcessBetService(orm.em.fork(), factory).execute(bet.id)));
        expect(results.filter(result => result.status === Status.Processed)).toHaveLength(1);
        expect(results.filter(result => result.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(1);
        expect(reads).toBe(3);
        await verify(wallet.id, "20.00", 2, 1);
    });

    it("bounds optimistic retries and leaves all state unchanged on exhaustion", async () => {
        const wallet = await setupWallet();
        const bet = await setupBet(wallet);
        let attempts = 0;
        const factory: BetRepositoryFactory = tx => {
            attempts++;
            const repositories = createBetRepositories(tx);
            const update = repositories.wallets.update.bind(repositories.wallets);
            repositories.wallets.update = async (...args) => {
                await update(...args);
                throw new ConcurrencyConflictError("forced conflict");
            };
            return repositories;
        };
        await expect(new ProcessBetService(orm.em.fork(), factory, 3).execute(bet.id)).rejects.toThrow("forced conflict");
        expect(attempts).toBe(3);
        expect((await new MikroOrmWagerTransactionRepository(orm.em.fork()).findById(bet.id))?.status).toBe(Status.Pending);
        await verify(wallet.id, "100.00", 1, 0);
    });

    it("processes three independent wallets concurrently", async () => {
        const wallets = await Promise.all(Array.from({ length: 3 }, () => setupWallet()));
        const bets = await Promise.all(wallets.map(wallet => setupBet(wallet)));
        await Promise.all(bets.map(bet => new ProcessBetService(orm.em.fork()).execute(bet.id)));
        for (const wallet of wallets) await verify(wallet.id, "80.00", 2, 1);
    });

    it("replays the original transaction after another BET changes the balance", async () => {
        const wallet = await setupWallet();
        const first = await setupBet(wallet);
        const second = await setupBet(wallet);
        const service = new ProcessBetService(orm.em.fork());
        const original = await service.execute(first.id);
        await service.execute(second.id);
        const replay = await service.execute(first.id);
        expect(replay.processedAt).toEqual(original.processedAt);
        await verify(wallet.id, "60.00", 3, 2);
    });

    it("does not process other kinds or unknown transaction IDs", async () => {
        const wallet = await setupWallet();
        const win = await setupBet(wallet, "20.00", { kind: Kind.Win });
        const service = new ProcessBetService(orm.em.fork());
        await expect(service.execute(win.id)).rejects.toThrow("only BET");
        await expect(service.execute(crypto.randomUUID())).rejects.toThrow("not found");
        await verify(wallet.id, "100.00", 1, 0);
    });
});

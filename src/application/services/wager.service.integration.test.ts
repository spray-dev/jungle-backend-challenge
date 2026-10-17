import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm, closeTestOrm } from "../../testing/integration-database.js";
import { Money } from "../../domain/money.js";
import { Wallet } from "../../domain/wallet.js";
import { FailureCode, WagerTransactionStatus as Status, WagerTransactionKind as Kind } from "../../domain/wager-transaction.js";
import { MikroOrmWalletRepository } from "../../persistence/repositories/mikro-orm-wallet.repository.js";
import { AcceptWagerService, IdempotencyConflictError, type AcceptWagerCommand } from "./accept-wager.service.js";
import { ProcessWagerService, createWagerRepositories, type WagerRepositoryFactory } from "./process-wager.service.js";
import { HandleWagerMessageService, handleWagerMessageInTransaction } from "./handle-wager-message.service.js";

let orm: MikroORM;
beforeAll(async () => { orm = await createTestOrm(); }, 30000);
afterAll(async () => { await closeTestOrm(orm); });

async function input(kind: AcceptWagerCommand["kind"]): Promise<AcceptWagerCommand> {
    const id = crypto.randomUUID();
    await new MikroOrmWalletRepository(orm.em.fork()).create(Wallet.open({
        id, playerId: id, initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    }));
    return { kind, providerId: "provider", externalTransactionId: id, idempotencyKey: id,
        walletId: id, playerId: id, roundId: "round", gameId: "game", money: { amount: "200.00", currency: "BRL" } };
}
function message(wager: AcceptWagerCommand) {
    return { wager, consumerName: "new-kinds", messageId: crypto.randomUUID(), payloadHash: "a".repeat(64) };
}
async function rows(table: string, field: string, id: string) {
    return orm.em.getConnection().execute(`select * from ${table} where ${field} = ?`, [id]);
}
async function verify(command: AcceptWagerCommand, balance: string, version: number, entries: number) {
    const wallet = await new MikroOrmWalletRepository(orm.em.fork()).findById(command.walletId);
    expect(wallet?.balance.toJSON().amount).toBe(balance);
    expect(wallet?.version).toBe(version);
    const ledger = await rows("wallet_ledger_entries", "wallet_id", command.walletId);
    expect(ledger).toHaveLength(entries);
    const [sum] = await orm.em.getConnection().execute(
        "select (100.00 + coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0))::numeric(18,2)::text as balance from wallet_ledger_entries where wallet_id = ?", [command.walletId]);
    expect(sum?.balance).toBe(balance);
    return ledger;
}

for (const kind of ["WIN", "LOSS"] as const) {
    it(`${kind}: 20 concurrent deliveries, canonical replay after reconnect and original event`, async () => {
        const command = await input(kind);
        const envelope = message(command);
        const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
            new HandleWagerMessageService(orm.em.fork()).execute(i % 2 ? envelope : { ...envelope, messageId: crypto.randomUUID() })));
        expect(new Set(results.map(r => r.transaction.id)).size).toBe(1);
        const original = results[0]!.transaction;
        expect(original.status).toBe(Status.Processed);
        const balance = kind === "WIN" ? "300.00" : "100.00";
        expect(results.every(r => r.transaction.observedBalance?.toJSON().amount === balance)).toBe(true);
        const ledger = await verify(command, balance, kind === "WIN" ? 2 : 1, kind === "WIN" ? 1 : 0);
        if (kind === "WIN") {
            expect(ledger[0]).toMatchObject({ direction: "CREDIT", amount: "200.00", balance_before: "100.00", balance_after: "300.00", transaction_id: original.id });
        }
        const events = await orm.em.getConnection().execute("select * from outbox_messages where payload->'data'->>'transactionId' = ?", [original.id]);
        expect(events).toHaveLength(1);
        expect(events[0]?.payload.data).toMatchObject({ kind, balance: { amount: balance, currency: "BRL" } });
        expect((await rows("inbox_messages", "message_id", envelope.messageId))[0]?.processed_at).not.toBeNull();
        const another = { ...command, kind: "BET" as const, externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), money: { amount: "20.00", currency: "BRL" } };
        await new HandleWagerMessageService(orm.em.fork()).execute(message(another));
        const fresh = await MikroORM.init(orm.config.getAll());
        try {
            const replay = await new AcceptWagerService(fresh.em.fork()).execute({ ...command, money: { amount: "0200.00", currency: "brl" } });
            expect(replay.id).toBe(original.id);
            expect(replay.observedBalance?.toJSON().amount).toBe(balance);
            expect(replay.processedAt).toEqual(original.processedAt);
        } finally { await fresh.close(); }
    });

    for (const [overrides, code] of [
        [{ playerId: "other" }, FailureCode.PlayerMismatch],
        [{ money: { amount: "1.00", currency: "USD" } }, FailureCode.CurrencyMismatch],
        [{ money: { amount: "0.00", currency: "BRL" } }, FailureCode.InvalidAmount],
    ] as const) {
        it(`${kind}: rejects ${code} without ledger or wallet update`, async () => {
            const command = { ...await input(kind), ...overrides };
            const result = await new HandleWagerMessageService(orm.em.fork()).execute(message(command));
            expect(result.transaction.status).toBe(Status.Rejected);
            expect(result.transaction.failureCode).toBe(code);
            await verify(command, "100.00", 1, 0);
        });
    }

    it(`${kind}: negative input and missing wallet leave no inbox or wager`, async () => {
        const command = await input(kind);
        for (const invalid of [ { ...command, money: { amount: "-1.00", currency: "BRL" } }, { ...command, walletId: crypto.randomUUID() } ]) {
            const envelope = message(invalid);
            await expect(new HandleWagerMessageService(orm.em.fork()).execute(envelope)).rejects.toThrow();
            expect(await rows("inbox_messages", "message_id", envelope.messageId)).toHaveLength(0);
        }
        expect(await rows("wager_transactions", "wallet_id", command.walletId)).toHaveLength(0);
        await verify(command, "100.00", 1, 0);
    });

    it(`${kind}: rolls back inbox, operation, movement, ledger and event on outer failure`, async () => {
        const command = await input(kind);
        const envelope = message(command);
        await expect(orm.em.fork().transactional(async tx => {
            await handleWagerMessageInTransaction(tx, envelope);
            throw new Error("after outbox");
        })).rejects.toThrow("after outbox");
        await verify(command, "100.00", 1, 0);
        expect(await rows("inbox_messages", "message_id", envelope.messageId)).toHaveLength(0);
        expect(await rows("wager_transactions", "wallet_id", command.walletId)).toHaveLength(0);
        expect(await orm.em.getConnection().execute("select * from outbox_messages where payload->'data'->>'walletId' = ?", [command.walletId])).toHaveLength(0);
        await new HandleWagerMessageService(orm.em.fork()).execute(envelope);
        await verify(command, kind === "WIN" ? "300.00" : "100.00", kind === "WIN" ? 2 : 1, kind === "WIN" ? 1 : 0);
    });
}

it("kind participates in canonical hash and BET keeps its original hash", async () => {
    const command = await input("BET");
    const service = new AcceptWagerService(orm.em.fork());
    const original = await service.execute(command);
    const { providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money } = command;
    expect(original.payloadHash).toBe(createHash("sha256").update(JSON.stringify({ providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money })).digest("hex"));
    for (const changedKind of ["WIN", "LOSS"] as const) {
        await expect(service.execute({ ...command, kind: changedKind })).rejects.toBeInstanceOf(IdempotencyConflictError);
    }
});

for (const secondKind of ["WIN", "BET"] as const) {
    it(`retries deterministic stale snapshots for WIN + ${secondKind}`, async () => {
        const command = await input("WIN");
        const accept = new AcceptWagerService(orm.em.fork());
        const a = await accept.execute(command);
        const b = await accept.execute({ ...command, kind: secondKind, externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), money: { amount: "20.00", currency: "BRL" } });
        let reads = 0;
        let release!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        const factory: WagerRepositoryFactory = tx => {
            const repos = createWagerRepositories(tx);
            const find = repos.wallets.findById.bind(repos.wallets);
            repos.wallets.findById = async id => {
                const snapshot = await find(id);
                if (++reads <= 2) { if (reads === 2) release(); await barrier; }
                return snapshot;
            };
            return repos;
        };
        const results = await Promise.all([a, b].map(wager => new ProcessWagerService(orm.em.fork(), factory).execute(wager.id)));
        expect(results.every(r => r.status === "PROCESSED")).toBe(true);
        expect(reads).toBe(3);
        await verify(command, secondKind === "WIN" ? "320.00" : "280.00", 3, 2);
    });
}

it("LOSS does not call wallet update or ledger insert", async () => {
    const command = await input("LOSS");
    const accepted = await new AcceptWagerService(orm.em.fork()).execute(command);
    const factory: WagerRepositoryFactory = tx => {
        const repos = createWagerRepositories(tx);
        repos.wallets.update = async () => { throw new Error("unexpected wallet write"); };
        repos.ledger.insert = async () => { throw new Error("unexpected ledger write"); };
        return repos;
    };
    expect((await new ProcessWagerService(orm.em.fork(), factory).execute(accepted.id)).status).toBe(Status.Processed);
    await verify(command, "100.00", 1, 0);
});

for (const kind of [Kind.Opening, Kind.Refund, Kind.Rollback]) {
    it(`does not admit ${kind}`, async () => {
        const command = await input("WIN");
        await expect(new AcceptWagerService(orm.em.fork()).execute({ ...command, kind: kind as AcceptWagerCommand["kind"] })).rejects.toThrow("Only BET/WIN/LOSS");
    });
}

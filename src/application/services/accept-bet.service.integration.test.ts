import { afterAll, beforeAll, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm, closeTestOrm } from "../../testing/integration-database.js";
import { Money } from "../../domain/money.js";
import { Wallet } from "../../domain/wallet.js";
import { WagerTransactionStatus } from "../../domain/wager-transaction.js";
import { MikroOrmWalletRepository } from "../../persistence/repositories/mikro-orm-wallet.repository.js";
import { AcceptBetService, IdempotencyConflictError, type AcceptBetCommand } from "./accept-bet.service.js";
import { ProcessBetService } from "./process-bet.service.js";

let orm: MikroORM;
beforeAll(async () => { orm = await createTestOrm(); }, 30000);
afterAll(async () => { await closeTestOrm(orm); });

async function command(): Promise<AcceptBetCommand> {
    const id = crypto.randomUUID();
    await new MikroOrmWalletRepository(orm.em.fork()).create(Wallet.open({
        id, playerId: "player-" + id, initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    }));
    return { providerId: "provider", externalTransactionId: id, idempotencyKey: id,
        walletId: id, playerId: "player-" + id, roundId: "round", gameId: "game", money: { amount: "20.00", currency: "BRL" } };
}

it("admits 50 concurrent equivalent requests once and debits once", async () => {
    const input = await command();
    const transactions = await Promise.all(Array.from({ length: 50 }, () => new AcceptBetService(orm.em.fork()).execute(input)));
    expect(new Set(transactions.map(t => t.id)).size).toBe(1);
    const results = await Promise.all(transactions.map(t => new ProcessBetService(orm.em.fork()).execute(t.id)));
    expect(results.every(t => t.observedBalance?.toJSON().amount === "80.00")).toBe(true);
    expect(await orm.em.getConnection().execute("select id from wager_transactions where wallet_id = ?", [input.walletId])).toHaveLength(1);
    expect(await orm.em.getConnection().execute("select id from wallet_ledger_entries where wallet_id = ?", [input.walletId])).toHaveLength(1);
});

it("replays persisted identity and original result after reconnecting and another debit", async () => {
    const input = await command();
    const first = await new AcceptBetService(orm.em.fork()).execute(input);
    await new ProcessBetService(orm.em.fork()).execute(first.id);
    const second = await new AcceptBetService(orm.em.fork()).execute({ ...input, externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
    await new ProcessBetService(orm.em.fork()).execute(second.id);
    const fresh = await MikroORM.init(orm.config.getAll());
    try {
        const replay = await new AcceptBetService(fresh.em.fork()).execute({ ...input, money: { amount: "020.00", currency: "brl" } });
        expect(replay.id).toBe(first.id);
        expect(replay.status).toBe(WagerTransactionStatus.Processed);
        expect(replay.observedBalance?.toJSON()).toEqual({ amount: "80.00", currency: "BRL" });
    } finally { await fresh.close(); }
});

for (const field of ["money", "playerId", "roundId", "gameId", "walletId", "externalTransactionId", "idempotencyKey"] as const) {
    it("treats changed " + field + " as conflict without modifying the original", async () => {
        const input = await command();
        const service = new AcceptBetService(orm.em.fork());
        const original = await service.execute(input);
        const changed = field === "money" ? { ...input, money: { amount: "21.00", currency: "BRL" } }
            : { ...input, [field]: field === "walletId" ? (await command()).walletId : "different" };
        await expect(service.execute(changed)).rejects.toBeInstanceOf(IdempotencyConflictError);
        expect((await service.execute(input)).payloadHash).toBe(original.payloadHash);
        expect(await orm.em.getConnection().execute("select id from wager_transactions where wallet_id = ?", [input.walletId])).toHaveLength(1);
        expect(await orm.em.getConnection().execute("select id from wallet_ledger_entries where wallet_id = ?", [input.walletId])).toHaveLength(0);
    });
}

it("scopes both unique identities to the provider", async () => {
    const input = await command();
    const a = await new AcceptBetService(orm.em.fork()).execute(input);
    const b = await new AcceptBetService(orm.em.fork()).execute({ ...input, providerId: "another-provider" });
    expect(a.id).not.toBe(b.id);
});

it("resolves a concurrent divergent payload to one acceptance and one conflict", async () => {
    const input = await command();
    const results = await Promise.allSettled([
        new AcceptBetService(orm.em.fork()).execute(input),
        new AcceptBetService(orm.em.fork()).execute({ ...input, money: { amount: "30.00", currency: "BRL" } }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(r => r.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(IdempotencyConflictError);
});

it("rejects crossing an existing external ID with another transaction's key", async () => {
    const input = await command();
    const service = new AcceptBetService(orm.em.fork());
    await service.execute(input);
    const other = { ...input, externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    await service.execute(other);
    await expect(service.execute({ ...input, idempotencyKey: other.idempotencyKey })).rejects.toBeInstanceOf(IdempotencyConflictError);
});

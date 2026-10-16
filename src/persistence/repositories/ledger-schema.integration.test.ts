import { afterAll, beforeAll, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm, closeTestOrm } from "../../testing/integration-database.js";
import { Money } from "../../domain/money.js";
import { Wallet } from "../../domain/wallet.js";
import { createWagerFixture } from "../../testing/create-wager-fixture.js";
import { MikroOrmWalletRepository } from "./mikro-orm-wallet.repository.js";
import { ProcessBetService } from "../../application/services/process-bet.service.js";

let orm: MikroORM;
beforeAll(async () => { orm = await createTestOrm(); }, 30000);
afterAll(async () => { await closeTestOrm(orm); });

async function fixture() {
    const id = crypto.randomUUID();
    await new MikroOrmWalletRepository(orm.em.fork()).create(Wallet.open({
        id, playerId: "player-" + id, initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    }));
    const transactionId = crypto.randomUUID();
    await createWagerFixture(orm.em.fork(), id, transactionId);
    await new ProcessBetService(orm.em.fork()).execute(transactionId);
    return { id, transactionId };
}

it("rejects a second ledger ID for the same wallet and transaction through direct SQL", async () => {
    const { id, transactionId } = await fixture();
    await expect(orm.em.getConnection().execute(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at)
         values (?, ?, ?, 'DEBIT', 20, 100, 80, now())`, [crypto.randomUUID(), id, transactionId],
    )).rejects.toMatchObject({ code: "23505", constraint: "ledger_wallet_transaction_unique" });
    expect(await orm.em.getConnection().execute("select id from wallet_ledger_entries where wallet_id = ?", [id])).toHaveLength(1);
});

for (const operation of ["update", "delete", "truncate"] as const) {
    it("blocks " + operation + " in PostgreSQL and preserves the original row", async () => {
        const { id } = await fixture();
        const connection = orm.em.getConnection();
        const before = await connection.execute("select * from wallet_ledger_entries where wallet_id = ?", [id]);
        const sql = operation === "update"
            ? "update wallet_ledger_entries set amount = 10, balance_after = 90 where wallet_id = ?"
            : operation === "delete" ? "delete from wallet_ledger_entries where wallet_id = ?"
            : "truncate wallet_ledger_entries";
        await expect(connection.execute(sql, operation === "truncate" ? [] : [id]))
            .rejects.toMatchObject({ code: "55000" });
        expect(await connection.execute("select * from wallet_ledger_entries where wallet_id = ?", [id])).toEqual(before);
    });
}

it("reverses and reapplies the migration without losing ledger data; backfills only known history", async () => {
    const { id, transactionId } = await fixture();
    const connection = orm.em.getConnection();
    const before = await connection.execute("select * from wallet_ledger_entries where wallet_id = ?", [id]);
    await orm.migrator.down({ to: "Migration20261016144310" });
    // This no-op UPDATE succeeds only when the protection has been removed by down().
    await connection.execute("update wallet_ledger_entries set amount = amount where wallet_id = ?", [id]);
    const legacyRejected = crypto.randomUUID();
    await connection.execute(`insert into wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, status, amount, currency, failure_code, created_at)
        values (?, 'legacy', ?, ?, 'legacy', ?, 'legacy', 'legacy', 'legacy', 'BET', 'REJECTED', 120, 'BRL', 'INSUFFICIENT_FUNDS', now())`,
        [legacyRejected, legacyRejected, legacyRejected, id]);
    await orm.migrator.up();
    expect(await connection.execute("select * from wallet_ledger_entries where wallet_id = ?", [id])).toEqual(before);
    const [processed] = await connection.execute("select observed_balance, observed_currency from wager_transactions where id = ?", [transactionId]);
    expect(processed).toEqual({ observed_balance: "80.00", observed_currency: "BRL" });
    const [rejected] = await connection.execute("select observed_balance, observed_currency from wager_transactions where id = ?", [legacyRejected]);
    expect(rejected).toEqual({ observed_balance: null, observed_currency: null });
    await expect(connection.execute("delete from wallet_ledger_entries where wallet_id = ?", [id])).rejects.toMatchObject({ code: "55000" });
    await expect(connection.execute(`insert into wallet_ledger_entries select ?, wallet_id, transaction_id, direction, amount, balance_before, balance_after, created_at
        from wallet_ledger_entries where wallet_id = ?`, [crypto.randomUUID(), id])).rejects.toMatchObject({ code: "23505" });
});

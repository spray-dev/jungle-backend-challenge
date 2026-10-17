import { afterAll, beforeAll, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { createTestOrm, closeTestOrm } from "../../testing/integration-database.js";
import { Money } from "../../domain/money.js";
import { Wallet } from "../../domain/wallet.js";
import { FailureCode, WagerTransactionStatus as Status } from "../../domain/wager-transaction.js";
import { MikroOrmWalletRepository } from "../../persistence/repositories/mikro-orm-wallet.repository.js";
import { MikroOrmReferenceRetryRepository } from "../../persistence/repositories/mikro-orm-reference-retry.repository.js";
import { AcceptWagerService, IdempotencyConflictError, type AcceptWagerCommand } from "./accept-wager.service.js";
import { ProcessWagerService, processWagerInTransaction } from "./process-wager.service.js";
import { HandleWagerMessageService, handleWagerMessageInTransaction } from "./handle-wager-message.service.js";
import { RetryPendingReferenceService } from "./retry-pending-reference.service.js";

let orm: MikroORM;
beforeAll(async () => { orm = await createTestOrm(); }, 30_000);
afterAll(async () => { await closeTestOrm(orm); });
const sql = (query: string, params: unknown[] = []) => orm.em.getConnection().execute(query, params);
const money = (amount = "20.00") => ({ amount, currency: "BRL" });
function next(base: AcceptWagerCommand, overrides: Partial<AcceptWagerCommand> = {}): AcceptWagerCommand {
    const id = crypto.randomUUID();
    return { ...base, externalTransactionId: id, idempotencyKey: id, referenceExternalTransactionId: undefined, ...overrides };
}
function envelope(wager: AcceptWagerCommand) {
    return { wager, consumerName: "reversals", messageId: crypto.randomUUID(), payloadHash: "a".repeat(64) };
}
async function run(wager: AcceptWagerCommand) {
    return (await new HandleWagerMessageService(orm.em.fork()).execute(envelope(wager))).transaction;
}
async function fixture(): Promise<AcceptWagerCommand> {
    const id = crypto.randomUUID();
    // Zero opening plus a real WIN credit means reconstruction uses only the ledger.
    await new MikroOrmWalletRepository(orm.em.fork()).create(Wallet.open({ id, playerId: id, initialBalance: Money.zero("BRL") }));
    const command: AcceptWagerCommand = { providerId: id, externalTransactionId: id, idempotencyKey: id,
        walletId: id, playerId: id, roundId: "round", gameId: "game", kind: "WIN", money: money("100.00") };
    await run(command);
    return next(command, { kind: "BET", money: money() });
}
async function verify(command: AcceptWagerCommand, expected: string, entries: number) {
    const [wallet] = await sql("select balance, version from wallets where id = ?", [command.walletId]);
    const [ledger] = await sql(`select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(18,2)::text as balance,
        count(*)::int as entries from wallet_ledger_entries where wallet_id = ?`, [command.walletId]);
    if (!wallet || !ledger) throw new Error("Missing reconciliation rows");
    expect(wallet.balance).toBe(expected);
    expect(ledger.balance).toBe(wallet.balance);
    expect(ledger.entries).toBe(entries);
    expect(wallet.version).toBe(entries + 1);
}
async function row(id: string) {
    const found = (await sql("select * from wager_transactions where id = ?", [id]))[0];
    if (!found) throw new Error("Missing wager row");
    return found;
}
async function events(id: string) {
    const all = await sql("select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by created_at, id", [id]);
    const transaction = await row(id);
    expect(all.filter((e: any) => e.event_type === 'WalletBalanceChanged')).toHaveLength(transaction.status === Status.Processed ? 1 : 0);
    return all.filter((e: any) => e.event_type !== 'WalletBalanceChanged');
}

for (const [kind, referenceKind, finalBalance] of [
    ["REFUND", "BET", "100.00"], ["ROLLBACK", "BET", "100.00"],
    ["ROLLBACK", "WIN", "100.00"], ["ROLLBACK", "REFUND", "80.00"],
] as const) {
    it(`${kind} of ${referenceKind}: exact inverse, replay and historical balance after another movement`, async () => {
        const base = await fixture();
        let reference = next(base, { kind: referenceKind });
        if (referenceKind === "REFUND") {
            await run(base);
            reference.referenceExternalTransactionId = base.externalTransactionId;
        }
        const original = await run(reference);
        const reversal = next(base, { kind, referenceExternalTransactionId: reference.externalTransactionId });
        const result = await run(reversal);
        expect(result.status).toBe(Status.Processed);
        expect(result.referenceTransactionId).toBe(original.id);
        expect(result.observedBalance?.toJSON().amount).toBe(finalBalance);
        const [entry] = await sql("select * from wallet_ledger_entries where transaction_id = ?", [result.id]);
        if (!entry) throw new Error("Missing ledger entry");
        expect(entry.direction).toBe(referenceKind === "BET" ? "CREDIT" : "DEBIT");
        expect(entry.amount).toBe("20.00");
        const entries = referenceKind === "REFUND" ? 4 : 3;
        await verify(base, finalBalance, entries);
        await run(next(base, { kind: "WIN", money: money("1.00") }));
        const fresh = await MikroORM.init(orm.config.getAll());
        try {
            const replay = await new HandleWagerMessageService(fresh.em).execute(envelope(reversal));
            expect(replay.idempotentReplay).toBe(true);
            expect(replay.transaction.processedAt).toEqual(result.processedAt);
            expect(replay.transaction.observedBalance?.toJSON().amount).toBe(finalBalance);
        } finally { await fresh.close(); }
        expect(await events(result.id)).toEqual([{ event_type: "WagerTransactionProcessed" }]);
        await verify(base, Money.from(money(finalBalance)).add(Money.from(money("1.00"))).toJSON().amount, entries + 1);
    });
}

for (const kind of ["WIN", "REFUND"] as const) {
    it(`ROLLBACK of ${kind} rejects overdraw and replays rejection even after later credit`, async () => {
        const base = await fixture();
        const reference = next(base, { kind });
        if (kind === "REFUND") { await run(base); reference.referenceExternalTransactionId = base.externalTransactionId; }
        await run(reference);
        await run(next(base, { money: money(kind === "WIN" ? "120.00" : "100.00") }));
        const reversal = next(base, { kind: "ROLLBACK", referenceExternalTransactionId: reference.externalTransactionId });
        const result = await run(reversal);
        expect(result.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
        expect(result.status).toBe(Status.Rejected);
        expect(result.observedBalance?.toJSON().amount).toBe("0.00");
        await verify(base, "0.00", kind === "WIN" ? 3 : 4);
        expect(await events(result.id)).toEqual([{ event_type: "WagerTransactionRejected" }]);
        await run(next(base, { kind: "WIN", money: money("100.00") }));
        expect((await run(reversal)).failureCode).toBe(FailureCode.ReversalWouldOverdraw);
        await verify(base, "100.00", kind === "WIN" ? 4 : 5);
    });
}

for (const kind of ["REFUND", "ROLLBACK"] as const) {
    it(`${kind} delivered before reference: persistent schedule, redelivery, restart and eventual success`, async () => {
        const base = await fixture();
        const reversal = next(base, { kind, referenceExternalTransactionId: base.externalTransactionId });
        const message = envelope(reversal);
        const handler = new HandleWagerMessageService(orm.em.fork());
        const { transaction } = await handler.execute(message);
        expect(transaction.status).toBe(Status.PendingReference);
        await verify(base, "100.00", 1);
        const pending = await row(transaction.id);
        expect(pending.reference_attempts).toBe(0);
        expect(pending.reference_next_attempt_at).not.toBeNull();
        const retry = new RetryPendingReferenceService(orm.em);
        expect(await retry.retryPending(10, new Date(new Date(pending.reference_next_attempt_at).getTime() - 1))).toBe(0);
        await handler.execute(message);
        await handler.execute(envelope(reversal));
        expect(await row(transaction.id)).toEqual(pending);
        expect(await events(transaction.id)).toEqual([{ event_type: "WagerTransactionPendingReference" }]);
        await run(base);
        const fresh = await MikroORM.init(orm.config.getAll());
        try {
            expect(await new RetryPendingReferenceService(fresh.em).retryPending(1, new Date(pending.reference_next_attempt_at))).toBe(1);
        } finally { await fresh.close(); }
        expect((await row(transaction.id)).status).toBe(Status.Processed);
        expect((await row(transaction.id)).reference_attempts).toBe(1);
        expect((await row(transaction.id)).reference_next_attempt_at).toBeNull();
        await handler.execute(message);
        expect(await events(transaction.id)).toEqual([{ event_type: "WagerTransactionPendingReference" }, { event_type: "WagerTransactionProcessed" }]);
        await verify(base, "100.00", 3);
    });
}

it("five persistent retries use exponential backoff, then reject with exactly one rejected event", async () => {
    const base = await fixture();
    const reversal = next(base, { kind: "REFUND", referenceExternalTransactionId: "never-arrives" });
    const result = await run(reversal);
    for (let attempt = 1; attempt <= 5; attempt++) {
        const before = await row(result.id);
        const now = new Date(before.reference_next_attempt_at);
        // New instance every attempt: no in-memory retry counter.
        expect(await new RetryPendingReferenceService(orm.em.fork()).retryPending(1, now)).toBe(1);
        const after = await row(result.id);
        expect(after.reference_attempts).toBe(attempt);
        expect(after.status).toBe(attempt === 5 ? Status.Rejected : Status.PendingReference);
        if (attempt < 5) expect(new Date(after.reference_next_attempt_at).getTime() - now.getTime()).toBe(1000 * 2 ** attempt);
        else { expect(after.reference_next_attempt_at).toBeNull(); expect(after.failure_code).toBe("REFERENCE_NOT_FOUND"); }
    }
    expect(await new RetryPendingReferenceService(orm.em).retryPending(10, new Date(Date.now() + 600_000))).toBe(0);
    await run(reversal);
    expect(await events(result.id)).toEqual([{ event_type: "WagerTransactionPendingReference" }, { event_type: "WagerTransactionRejected" }]);
    await verify(base, "100.00", 1);
});

for (const mismatch of ["player", "wallet", "currency", "round", "amount", "kind", "self"] as const) {
    it(`rejects invalid reference: ${mismatch}`, async () => {
        const base = await fixture();
        const reference = next(base, { kind: mismatch === "kind" ? "WIN" : "BET" });
        await run(reference);
        const reversal = next(base, { kind: "REFUND", referenceExternalTransactionId: reference.externalTransactionId });
        if (mismatch === "player") reversal.playerId = "other";
        if (mismatch === "currency") reversal.money = { amount: "20.00", currency: "USD" };
        if (mismatch === "round") reversal.roundId = "other";
        if (mismatch === "amount") reversal.money = money("19.99");
        if (mismatch === "wallet") reversal.walletId = (await fixture()).walletId;
        if (mismatch === "self") reversal.referenceExternalTransactionId = reversal.externalTransactionId;
        const result = await run(reversal);
        expect(result.status).toBe(Status.Rejected);
        expect(result.failureCode).toBe(FailureCode.InvalidReference);
        expect(await sql("select id from wallet_ledger_entries where transaction_id = ?", [result.id])).toHaveLength(0);
        expect(await events(result.id)).toEqual([{ event_type: "WagerTransactionRejected" }]);
        await verify(base, mismatch === "kind" ? "120.00" : "80.00", 2);
    });
}

it("provider-scoped reference resolution never resolves an external ID from another provider", async () => {
    const base = await fixture();
    await run(base);
    const result = await run(next(base, { providerId: "other", kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId }));
    expect(result.status).toBe(Status.PendingReference);
    await verify(base, "80.00", 2);
    // Finish this row so subsequent worker tests have no unrelated due work.
    for (let n = 0; n < 5; n++) await new RetryPendingReferenceService(orm.em).retryPending(1, new Date((await row(result.id)).reference_next_attempt_at));
    expect((await row(result.id)).failure_code).toBe("REFERENCE_NOT_FOUND");
});

for (const kind of ["REFUND", "ROLLBACK"] as const) {
    it(`${kind}: three independent instances race with distinct IDs and keys; only one reversal commits`, async () => {
        const base = await fixture();
        await run(base);
        const instances = await Promise.all(Array.from({ length: 3 }, () => MikroORM.init(orm.config.getAll())));
        try {
            const results = await Promise.all(instances.map(instance => new HandleWagerMessageService(instance.em).execute(
                envelope(next(base, { kind, referenceExternalTransactionId: base.externalTransactionId })),
            )));
            expect(results.filter(r => r.transaction.status === Status.Processed)).toHaveLength(1);
            expect(results.filter(r => r.transaction.failureCode === FailureCode.ReferenceAlreadyReversed)).toHaveLength(2);
            for (const result of results) expect(await events(result.transaction.id)).toHaveLength(1);
        } finally { await Promise.all(instances.map(instance => instance.close())); }
        await verify(base, "100.00", 3);
    });
}

it("REFUND and ROLLBACK may each reverse the same BET once", async () => {
    const base = await fixture();
    await run(base);
    const results = await Promise.all((["REFUND", "ROLLBACK"] as const).map(kind => run(next(base, { kind, referenceExternalTransactionId: base.externalTransactionId }))));
    expect(results.every(r => r.status === Status.Processed)).toBe(true);
    await verify(base, "120.00", 4);
});

it("50 concurrent replays of a REFUND do not duplicate credit or outbox", async () => {
    const base = await fixture();
    await run(base);
    const reversal = next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId });
    const results = await Promise.all(Array.from({ length: 50 }, () => run(reversal)));
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect(results.every(r => r.status === Status.Processed)).toBe(true);
    expect(await events(results[0]!.id)).toHaveLength(1);
    await verify(base, "100.00", 3);
    await expect(new AcceptWagerService(orm.em.fork()).execute({ ...reversal, referenceExternalTransactionId: "changed" })).rejects.toBeInstanceOf(IdempotencyConflictError);
});

it("SKIP LOCKED skips a claimed row while another wallet progresses, then releases on rollback", async () => {
    const first = await fixture();
    const second = await fixture();
    const a = await run(next(first, { kind: "REFUND", referenceExternalTransactionId: first.externalTransactionId }));
    const b = await run(next(second, { kind: "ROLLBACK", referenceExternalTransactionId: second.externalTransactionId }));
    await run(first); await run(second);
    const now = new Date(Date.now() + 120_000);
    let signalClaim!: () => void;
    let releaseClaim!: () => void;
    const claimedSignal = new Promise<void>(resolve => { signalClaim = resolve; });
    const release = new Promise<void>(resolve => { releaseClaim = resolve; });
    const heldTransaction = orm.em.fork().transactional(async tx => {
        const repo = new MikroOrmReferenceRetryRepository(tx);
        const claimed = await repo.claimDue(now);
        expect(claimed?.id).toBe(a.id);
        signalClaim();
        await release;
        await processWagerInTransaction(tx, a.id, undefined, undefined, { attempts: 1, now });
        throw new Error("abort after retry event");
    });
    const rolledBack = heldTransaction.catch((error: unknown) => error);
    await claimedSignal;
    try {
        expect(await new RetryPendingReferenceService(orm.em).retryPending(10, now)).toBe(1);
        expect((await row(b.id)).status).toBe(Status.Processed);
    } finally { releaseClaim(); expect(await rolledBack).toMatchObject({ message: "abort after retry event" }); }
    expect((await row(a.id)).status).toBe(Status.PendingReference);
    expect((await row(a.id)).reference_attempts).toBe(0);
    expect(await events(a.id)).toHaveLength(1);
    expect(await new RetryPendingReferenceService(orm.em).retryPending(10, now)).toBe(1);
    await verify(first, "100.00", 3); await verify(second, "100.00", 3);
});

it("three workers racing on one missing reference count one attempt per due date", async () => {
    const base = await fixture();
    const result = await run(next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId }));
    const now = new Date((await row(result.id)).reference_next_attempt_at);
    const counts = await Promise.all(Array.from({ length: 3 }, () => new RetryPendingReferenceService(orm.em.fork()).retryPending(10, now)));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await row(result.id)).reference_attempts).toBe(1);
    await run(base);
    await new RetryPendingReferenceService(orm.em).retryPending(1, new Date((await row(result.id)).reference_next_attempt_at));
    await verify(base, "100.00", 3);
});

for (const missing of [false, true]) {
    it(`outer rollback removes reversal, inbox, event, schedule and financial effects (missing=${missing})`, async () => {
        const base = await fixture();
        if (!missing) await run(base);
        const reversal = next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId });
        const message = envelope(reversal);
        await expect(orm.em.fork().transactional(async tx => {
            await handleWagerMessageInTransaction(tx, message);
            throw new Error("outer rollback");
        })).rejects.toThrow("outer rollback");
        expect(await sql("select id from wager_transactions where external_transaction_id = ?", [reversal.externalTransactionId])).toHaveLength(0);
        expect(await sql("select message_id from inbox_messages where message_id = ?", [message.messageId])).toHaveLength(0);
        expect(await sql("select id from outbox_messages where payload->'data'->>'externalTransactionId' = ?", [reversal.externalTransactionId])).toHaveLength(0);
        await verify(base, missing ? "100.00" : "80.00", missing ? 1 : 2);
    });
}

it("database unique reversal index rejects direct SQL duplicates; manual down/up preserves ledger and triggers", async () => {
    const base = await fixture();
    await run(base);
    const original = await run(next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId }));
    const duplicate = await new AcceptWagerService(orm.em.fork()).execute(next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId }));
    await expect(sql("update wager_transactions set status = 'PROCESSED', reference_transaction_id = ? where id = ?", [original.referenceTransactionId!, duplicate.id]))
        .rejects.toMatchObject({ code: "23505", constraint: "wager_processed_reversal_unique" });
    await expect(sql("update wager_transactions set status = 'PROCESSED' where id = ?", [duplicate.id]))
        .rejects.toMatchObject({ code: "23514", constraint: "wager_processed_reversal_reference" });
    await expect(sql("update wager_transactions set reference_attempts = -1 where id = ?", [duplicate.id]))
        .rejects.toMatchObject({ code: "23514", constraint: "wager_reference_attempts_valid" });
    const before = await sql("select * from wallet_ledger_entries order by id");
    await orm.migrator.down({ to: "Migration20261016210000" });
    expect(await sql("select * from wallet_ledger_entries order by id")).toEqual(before);
    await expect(sql("update wallet_ledger_entries set amount = amount where wallet_id = ?", [base.walletId])).rejects.toMatchObject({ code: "55000" });
    await orm.migrator.up();
    expect(await sql("select * from wallet_ledger_entries order by id")).toEqual(before);
    expect((await new ProcessWagerService(orm.em).execute(duplicate.id)).failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    await verify(base, "100.00", 3);
});

for (const status of ["REJECTED", "FAILED"] as const) {
    it(`ROLLBACK rejects an existing ${status} reference`, async () => {
        const base = await fixture();
        const reference = await new AcceptWagerService(orm.em.fork()).execute(base);
        // Isolated persisted-state fixture, with no financial movement to fabricate.
        await sql("update wager_transactions set status = ? where id = ?", [status, reference.id]);
        const result = await run(next(base, { kind: "ROLLBACK", referenceExternalTransactionId: base.externalTransactionId }));
        expect(result.failureCode).toBe(FailureCode.InvalidReference);
        await verify(base, "100.00", 1);
    });
}

it("ROLLBACK rejects LOSS and ROLLBACK references", async () => {
    const base = await fixture();
    const loss = next(base, { kind: "LOSS" });
    await run(loss);
    await run(base);
    const reversal = next(base, { kind: "ROLLBACK", referenceExternalTransactionId: base.externalTransactionId });
    await run(reversal);
    for (const reference of [loss, reversal]) {
        const result = await run(next(base, { kind: "ROLLBACK", referenceExternalTransactionId: reference.externalTransactionId }));
        expect(result.failureCode).toBe(FailureCode.InvalidReference);
    }
    await verify(base, "100.00", 3);
});

it("retry infrastructure failure rolls back attempt, event, wager, wallet and ledger; next worker succeeds", async () => {
    const base = await fixture();
    const result = await run(next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId }));
    await run(base);
    const before = await row(result.id);
    const now = new Date(before.reference_next_attempt_at);
    await sql(`create function test_reject_reversal_event() returns trigger language plpgsql as $$
        begin if new.event_type = 'WagerTransactionProcessed' then
            raise exception 'injected outbox failure'; end if; return new; end $$`);
    await sql("create trigger test_reject_reversal_event before insert on outbox_messages for each row execute function test_reject_reversal_event()");
    try {
        expect(await new RetryPendingReferenceService(orm.em).retryPending(1, now)).toBe(1);
    } finally {
        await sql("drop trigger test_reject_reversal_event on outbox_messages");
        await sql("drop function test_reject_reversal_event()");
    }
    const after = await row(result.id);
    expect(before).toEqual({ ...after, reference_next_attempt_at: before.reference_next_attempt_at });
    expect(new Date(after.reference_next_attempt_at).getTime()).toBe(now.getTime() + 5_000);
    expect(await events(result.id)).toHaveLength(1);
    await verify(base, "80.00", 2);
    expect(await new RetryPendingReferenceService(orm.em).retryPending(1, new Date(now.getTime() + 5_000))).toBe(1);
    await verify(base, "100.00", 3);
});

it("a reference appearing on the fifth retry is processed instead of rejected", async () => {
    const base = await fixture();
    const result = await run(next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId }));
    // Scope the clock to this row; unrelated invalid-state fixtures have no due date.
    for (let attempt = 1; attempt < 5; attempt++) {
        await new RetryPendingReferenceService(orm.em).retryPending(1, new Date((await row(result.id)).reference_next_attempt_at));
    }
    await run(base);
    await new RetryPendingReferenceService(orm.em).retryPending(1, new Date((await row(result.id)).reference_next_attempt_at));
    expect((await row(result.id)).status).toBe(Status.Processed);
    expect((await row(result.id)).reference_attempts).toBe(5);
    await verify(base, "100.00", 3);
});

it("scheduled worker processes due references and stops cleanly", async () => {
    const { PendingReferenceWorker } = await import("../../infrastructure/messaging/pending-reference.worker.js");
    const base = await fixture();
    const result = await run(next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId }));
    await run(base);
    const worker = new PendingReferenceWorker(new RetryPendingReferenceService(orm.em));
    worker.onModuleInit();
    try {
        const deadline = Date.now() + 3_000;
        while ((await row(result.id)).status !== Status.Processed && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect((await row(result.id)).status).toBe(Status.Processed);
    } finally { await worker.onModuleDestroy(); }
    await verify(base, "100.00", 3);
});


it("out-of-order ROLLBACK waits for pending REFUND then worker processes both exactly once", async () => {
    const base = await fixture();
    const refundCommand = next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId });
    const refund = await run(refundCommand);
    const rollbackCommand = next(base, { kind: "ROLLBACK", referenceExternalTransactionId: refundCommand.externalTransactionId });
    const rollback = await run(rollbackCommand);
    expect(rollback.status).toBe(Status.PendingReference);
    await verify(base, "100.00", 1);
    // Force dependent first, independently of UUID ordering or wall clock timing.
    const now = new Date(Date.now() + 10_000);
    await sql("update wager_transactions set reference_next_attempt_at = ? where id = ?", [new Date(now.getTime() - 1), rollback.id]);
    await sql("update wager_transactions set reference_next_attempt_at = ? where id = ?", [now, refund.id]);
    await run(base);
    expect(await new RetryPendingReferenceService(orm.em).retryPending(10, now)).toBe(2);
    expect((await row(refund.id)).status).toBe(Status.Processed);
    expect((await row(rollback.id)).status).toBe(Status.PendingReference);
    await new RetryPendingReferenceService(orm.em).retryPending(10, new Date((await row(rollback.id)).reference_next_attempt_at));
    expect((await row(rollback.id)).status).toBe(Status.Processed);
    await run(refundCommand); await run(rollbackCommand);
    for (const id of [refund.id, rollback.id]) {
        expect(await events(id)).toEqual([{ event_type: "WagerTransactionPendingReference" }, { event_type: "WagerTransactionProcessed" }]);
        expect(await sql("select id from wallet_ledger_entries where transaction_id = ?", [id])).toHaveLength(1);
    }
    await verify(base, "80.00", 4);
});

it("concurrent processing of PENDING reference does not block or prematurely reject dependent", async () => {
    const base = await fixture();
    const reference = await new AcceptWagerService(orm.em.fork()).execute(base);
    let signal!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { signal = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const processing = orm.em.fork().transactional(async tx => {
        await processWagerInTransaction(tx, reference.id);
        signal();
        await gate;
    });
    await ready;
    let dependent;
    try {
        // Reference holds its write locks until release; dependent must complete first.
        dependent = await run(next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId }));
        expect(dependent.status).toBe(Status.PendingReference);
    } finally { release(); await processing; }
    await new RetryPendingReferenceService(orm.em).retryPending(10, new Date((await row(dependent!.id)).reference_next_attempt_at));
    expect((await row(dependent!.id)).status).toBe(Status.Processed);
    await verify(base, "100.00", 3);
});

it("compatible existing pending reference exhausts as NOT_READY, never NOT_FOUND", async () => {
    const base = await fixture();
    await new AcceptWagerService(orm.em.fork()).execute(base);
    const result = await run(next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId }));
    for (let i = 0; i < 5; i++) await new RetryPendingReferenceService(orm.em).retryPending(1, new Date((await row(result.id)).reference_next_attempt_at));
    expect((await row(result.id)).failure_code).toBe("REFERENCE_NOT_READY");
    expect((await row(result.id)).reference_attempts).toBe(5);
    await verify(base, "100.00", 1);
});

it("incompatible pending reference and cyclic kinds reject without waiting", async () => {
    const base = await fixture();
    await new AcceptWagerService(orm.em.fork()).execute(base);
    const invalid = await run(next(base, { kind: "REFUND", money: money("19.00"), referenceExternalTransactionId: base.externalTransactionId }));
    expect(invalid.failureCode).toBe(FailureCode.InvalidReference);
    const a = next(base, { kind: "REFUND" });
    const b = next(base, { kind: "ROLLBACK", referenceExternalTransactionId: a.externalTransactionId });
    a.referenceExternalTransactionId = b.externalTransactionId;
    await new AcceptWagerService(orm.em.fork()).execute(a);
    await new AcceptWagerService(orm.em.fork()).execute(b);
    expect((await run(a)).failureCode).toBe(FailureCode.InvalidReference);
    expect((await run(b)).failureCode).toBe(FailureCode.InvalidReference);
    await verify(base, "100.00", 1);
});

it("real PostgreSQL 22003 rolls back first item and second wallet progresses in same round", async () => {
    const first = await fixture();
    const second = await fixture();
    const a = await run(next(first, { kind: "REFUND", referenceExternalTransactionId: first.externalTransactionId }));
    const b = await run(next(second, { kind: "REFUND", referenceExternalTransactionId: second.externalTransactionId }));
    await run(first); await run(second);
    await run(next(first, { kind: "WIN", money: money("9999999999999919.99") }));
    const now = new Date(Date.now() + 10_000);
    await sql("update wager_transactions set reference_next_attempt_at = ? where id = ?", [new Date(now.getTime() - 1), a.id]);
    await sql("update wager_transactions set reference_next_attempt_at = ? where id = ?", [now, b.id]);
    const before = await row(a.id);
    // Demonstrate actual numeric overflow, not a synthetic error.
    await expect(orm.em.fork().transactional(tx => processWagerInTransaction(tx, a.id, undefined, undefined, { attempts: 1, now })))
        .rejects.toMatchObject({ code: "22003" });
    expect(await new RetryPendingReferenceService(orm.em).retryPending(2, now)).toBe(2);
    const after = await row(a.id);
    expect(before).toEqual({ ...after, reference_next_attempt_at: before.reference_next_attempt_at });
    expect(new Date(after.reference_next_attempt_at).getTime()).toBe(now.getTime() + 60_000);
    expect((await row(b.id)).status).toBe(Status.Processed);
    expect(await events(a.id)).toHaveLength(1);
    await verify(first, "9999999999999999.99", 3);
    await verify(second, "100.00", 3);
    // Correct the operational cause and prove retry remains recoverable across instances.
    await run(next(first));
    expect(await new RetryPendingReferenceService(orm.em.fork()).retryPending(1, new Date(now.getTime() + 60_000))).toBe(1);
    expect((await row(a.id)).reference_attempts).toBe(1);
    expect((await row(a.id)).status).toBe(Status.Processed);
    await verify(first, "9999999999999999.99", 5);
});


for (const failReschedule of [false, true]) {
    it(`transient item failure isolates second wallet even when reschedule fails=${failReschedule}`, async () => {
        const first = await fixture();
        const second = await fixture();
        const a = await run(next(first, { kind: "REFUND", referenceExternalTransactionId: first.externalTransactionId }));
        const b = await run(next(second, { kind: "REFUND", referenceExternalTransactionId: second.externalTransactionId }));
        await run(first); await run(second);
        const now = new Date(Date.now() + 10_000);
        await sql("update wager_transactions set reference_next_attempt_at = ? where id = ?", [new Date(now.getTime() - 1), a.id]);
        await sql("update wager_transactions set reference_next_attempt_at = ? where id = ?", [now, b.id]);
        const before = await row(a.id);
        // Per-operation database fault; unrelated operations and normal constraints remain active.
        await sql(`create function test_retry_item_fault() returns trigger language plpgsql as $$
            begin if new.id::text = '${a.id}' and
                (new.status = 'PROCESSED' or (${failReschedule} and new.reference_next_attempt_at > old.reference_next_attempt_at)) then
                raise exception 'injected transient fault' using errcode = '40001';
            end if; return new; end $$`);
        await sql("create trigger test_retry_item_fault before update on wager_transactions for each row execute function test_retry_item_fault()");
        try {
            expect(await new RetryPendingReferenceService(orm.em).retryPending(2, now)).toBe(2);
            const after = await row(a.id);
            expect(before).toEqual({ ...after, reference_next_attempt_at: before.reference_next_attempt_at });
            expect(new Date(after.reference_next_attempt_at).getTime()).toBe(failReschedule ? now.getTime() - 1 : now.getTime() + 5_000);
            expect((await row(b.id)).status).toBe(Status.Processed);
            expect(await events(a.id)).toHaveLength(1);
            await verify(first, "80.00", 2);
            await verify(second, "100.00", 3);
        } finally {
            await sql("drop trigger test_retry_item_fault on wager_transactions");
            await sql("drop function test_retry_item_fault()");
        }
        await new RetryPendingReferenceService(orm.em.fork()).retryPending(1, new Date(now.getTime() + 5_000));
        expect((await row(a.id)).reference_attempts).toBe(1);
        await verify(first, "100.00", 3);
    });
}

it("technical recovery does not overwrite a concurrent schedule or terminal success", async () => {
    const base = await fixture();
    const a = await run(next(base, { kind: "REFUND", referenceExternalTransactionId: base.externalTransactionId }));
    const now = new Date((await row(a.id)).reference_next_attempt_at);
    await orm.em.fork().transactional(tx => new MikroOrmReferenceRetryRepository(tx).deferTechnicalFailure(a.id, now, 5_000));
    const deferred = await row(a.id);
    await orm.em.fork().transactional(tx => new MikroOrmReferenceRetryRepository(tx).deferTechnicalFailure(a.id, now, 60_000));
    expect(await row(a.id)).toEqual(deferred);
    await run(base);
    await new RetryPendingReferenceService(orm.em).retryPending(1, new Date(now.getTime() + 5_000));
    const completed = await row(a.id);
    await orm.em.fork().transactional(tx => new MikroOrmReferenceRetryRepository(tx).deferTechnicalFailure(a.id, new Date(now.getTime() + 60_000), 60_000));
    expect(await row(a.id)).toEqual(completed);
    await verify(base, "100.00", 3);
});

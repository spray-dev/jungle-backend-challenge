import 'reflect-metadata';
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, closeTestOrm } from '../testing/integration-database.js';
import { WalletController } from './wallet.controller.js';
import { WagerController } from './wager.controller.js';
import { HealthController } from '../health.controller.js';
import { openWalletInTransaction } from '../application/services/open-wallet.service.js';
import { Money } from '../domain/money.js';

let orm: MikroORM, app: INestApplication, base: string;
@Module({})
class TestModule {}
beforeAll(async () => {
    orm = await createTestOrm();
    app = await NestFactory.create({ module: TestModule, controllers: [WalletController, WagerController, HealthController],
        providers: [{ provide: MikroORM, useValue: orm }] }, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
}, 30000);
afterAll(async () => { await app?.close(); await closeTestOrm(orm); });
async function request(path: string, body?: unknown, key?: string) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
}
async function wallet() {
    const playerId = crypto.randomUUID();
    const result = await request('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    expect(result.status).toBe(201);
    return result.data;
}
function wager(w: any, changes = {}) {
    return { providerId: 'http-test', externalTransactionId: crypto.randomUUID(), playerId: w.playerId,
        walletId: w.id, roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' }, ...changes };
}
it('HTTP opening persists wallet, processed OPENING, exactly one credit, version 1 and outbox', async () => {
    const w = await wallet();
    expect(w.version).toBe(1);
    const rows = await orm.em.execute('select * from wager_transactions where wallet_id = ?', [w.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'OPENING', status: 'PROCESSED' });
    const ledger = await request(`/wallets/${w.id}/ledger`);
    expect(ledger.status).toBe(200);
    expect(ledger.data.items).toHaveLength(1);
    expect(ledger.data.items[0]).toMatchObject({ direction: 'CREDIT', balanceBefore: '0.00', balanceAfter: '100.00' });
    expect((await request(`/wallets/${w.id}`)).data).toEqual(w);
    const events = await orm.em.execute("select * from outbox_messages where payload->'data'->>'transactionId' = ?", [rows[0]!.id]);
    expect(events).toHaveLength(1);
});
it('opening rolls back all records if the SQL transaction fails', async () => {
    const player = crypto.randomUUID();
    let id = '';
    await expect(orm.em.fork().transactional(async tx => {
        const w = await openWalletInTransaction(tx, player, Money.from({ amount: '10.00', currency: 'BRL' }));
        id = w.id;
        await tx.execute('select 1 / 0');
    })).rejects.toThrow();
    expect(await orm.em.execute('select * from wallets where player_id = ?', [player])).toHaveLength(0);
    expect(await orm.em.execute('select * from wager_transactions where wallet_id = ?', [id])).toHaveLength(0);
    expect(await orm.em.execute('select * from wallet_ledger_entries where wallet_id = ?', [id])).toHaveLength(0);
    expect(await orm.em.execute("select * from outbox_messages where payload->'data'->>'walletId' = ?", [id])).toHaveLength(0);
});
it('duplicate player/currency returns 409 and invalid opening amounts return 400', async () => {
    const w = await wallet();
    expect((await request('/wallets', { playerId: w.playerId, initialBalance: w.balance })).status).toBe(409);
    for (const amount of ['0.00', '-1.00', '1.001', '10000000000000000.00', 10]) {
        expect((await request('/wallets', { playerId: 'invalid', initialBalance: { amount, currency: 'BRL' } })).status).toBe(400);
    }
});
it('HTTP wager uses persistent replay, preserves original balance and supports both lookups', async () => {
    const w = await wallet(), command = wager(w), key = crypto.randomUUID();
    const first = await request('/wagering/transactions', command, key);
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
    await request('/wagering/transactions', wager(w), crypto.randomUUID());
    const replay = await request('/wagering/transactions', command, key);
    expect(replay.data).toEqual({ ...first.data, idempotentReplay: true });
    expect((await request(`/wagering/transactions/${first.data.transactionId}`)).data.transactionId).toBe(first.data.transactionId);
    expect((await request(`/wagering/transactions/provider/http-test/external/${command.externalTransactionId}`)).data.transactionId).toBe(first.data.transactionId);
    expect((await request('/wagering/transactions', { ...command, money: { amount: '30.00', currency: 'BRL' } }, key)).status).toBe(409);
    expect((await request(`/wallets/${w.id}/reconciliation`)).data).toMatchObject({ consistent: true, checkedEntries: 3, calculatedBalance: { amount: '50.00', currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' } });
    const page1 = await request(`/wallets/${w.id}/ledger?limit=1`);
    const page2 = await request(`/wallets/${w.id}/ledger?limit=1&cursor=${page1.data.nextCursor}`);
    expect(page2.data.items[0].id).not.toBe(page1.data.items[0].id);
    expect((await request(`/wallets/${w.id}/ledger?cursor=bad`)).status).toBe(400);
});
it('HTTP distinguishes invalid, rejected, pending, missing and concurrent replay', async () => {
    const w = await wallet();
    expect((await request('/wagering/transactions', wager(w))).status).toBe(400);
    expect((await request('/wagering/transactions', wager(w, { kind: 'OPENING' }), 'invalid')).status).toBe(400);
    expect((await request('/wagering/transactions', wager(w, { money: { amount: '200.00', currency: 'BRL' } }), 'rejected')).status).toBe(422);
    expect((await request('/wagering/transactions', wager(w, { kind: 'REFUND', referenceExternalTransactionId: 'missing' }), 'pending')).status).toBe(202);
    expect((await request(`/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    const command = wager(w), key = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => request('/wagering/transactions', command, key)));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(results.filter(r => !r.data.idempotentReplay)).toHaveLength(1);
    expect((await request(`/wallets/${w.id}/reconciliation`)).data.consistent).toBe(true);
});
it('readiness checks real PostgreSQL and MiniStack; liveness remains independent', async () => {
    expect((await request('/health/live')).status).toBe(200);
    expect(await request('/health/ready')).toEqual({ status: 200, data: { status: 'ready', dependencies: { postgres: true, sqs: true } } });
    const original = process.env.SQS_ENDPOINT;
    process.env.SQS_ENDPOINT = 'http://127.0.0.1:1';
    const unavailable = new HealthController(orm);
    if (original === undefined) delete process.env.SQS_ENDPOINT; else process.env.SQS_ENDPOINT = original;
    try { await expect(unavailable.ready()).rejects.toMatchObject({ status: 503 }); }
    finally { unavailable.onModuleDestroy(); }
});

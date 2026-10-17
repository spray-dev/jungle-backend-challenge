import { expect, test } from 'bun:test';
import { WagerSqsWorker } from './wager-sqs.worker.js';
import { OutboxPublisherWorker } from './outbox-publisher.worker.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Worker did not run'); await wait(5); }
}
const factories = [
    { name: 'SQS', make: (run: () => Promise<void>, dispose: () => void) => new WagerSqsWorker({
        pollOnce: async () => { await run(); return 'EMPTY'; } }, 5, dispose) },
    { name: 'Outbox', make: (run: () => Promise<void>, dispose: () => void) => new OutboxPublisherWorker({
        publishPending: async () => { await run(); return { processed: 0, published: 0, failed: 0 }; } }, 5, dispose) },
];
for (const { name, make } of factories) {
    test(name + ' never overlaps; shutdown drains active work before disposal and stops rescheduling', async () => {
        let calls = 0, disposed = false, closed = false;
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const worker = make(async () => { calls++; await blocked; }, () => { disposed = true; });
        worker.onModuleInit(); worker.onModuleInit();
        try {
            await until(() => calls === 1);
            await wait(30);
            expect(calls).toBe(1);
            const closing = worker.onModuleDestroy().then(() => { closed = true; });
            await wait(20);
            expect(closed).toBe(false); expect(disposed).toBe(false);
            release(); await closing;
            expect(disposed).toBe(true);
            await wait(20); expect(calls).toBe(1);
        } finally { release(); await worker.onModuleDestroy(); }
    });
    test(name + ' retries after failures and cancels an idle timer on shutdown', async () => {
        let calls = 0;
        const worker = make(async () => { if (++calls === 1) throw new Error('sensitive payload must not be logged'); }, () => {});
        worker.onModuleInit();
        try { await until(() => calls >= 2); }
        finally { await worker.onModuleDestroy(); }
        const stoppedAt = calls;
        await wait(25); expect(calls).toBe(stoppedAt);
    });
}
test('workers without queue configuration are safe to initialize and close', async () => {
    for (const worker of [new WagerSqsWorker(), new OutboxPublisherWorker()]) {
        worker.onModuleInit(); await worker.onModuleDestroy();
    }
});

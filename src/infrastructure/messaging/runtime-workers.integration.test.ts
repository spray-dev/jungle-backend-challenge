import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { AppModule } from '../../app.module.js';
import { createTestOrm, closeTestOrm } from '../../testing/integration-database.js';
import { createSqsClient } from './sqs-client.js';
import { openWalletInTransaction } from '../../application/services/open-wallet.service.js';
import { Money } from '../../domain/money.js';

@Module({})
class RuntimeTestModule {}

test('AppModule workers automatically consume and publish with real PostgreSQL/SQS, then close gracefully', async () => {
    const orm = await createTestOrm(), client = createSqsClient();
    const urls: string[] = [];
    const oldInput = process.env.WAGER_SQS_QUEUE_URL, oldEvents = process.env.WAGER_SQS_EVENTS_QUEUE_URL;
    let app: INestApplication | undefined;
    try {
        for (const name of ['input', 'events']) {
            const result = await client.send(new CreateQueueCommand({ QueueName: `runtime-${name}-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true' } }));
            urls.push(result.QueueUrl!);
        }
        process.env.WAGER_SQS_QUEUE_URL = urls[0]!;
        process.env.WAGER_SQS_EVENTS_QUEUE_URL = urls[1]!;
        const wallet = await orm.em.fork().transactional(tx => openWalletInTransaction(tx, crypto.randomUUID(), Money.from({ amount: '100.00', currency: 'BRL' })));
        // Use the actual AppModule factories; only replace its database with an isolated real database.
        const providers = Reflect.getMetadata('providers', AppModule);
        app = await NestFactory.create({ module: RuntimeTestModule, providers: [{ provide: MikroORM, useValue: orm }, ...providers] }, { logger: false });
        await app.init();
        const id = crypto.randomUUID();
        await client.send(new SendMessageCommand({ QueueUrl: urls[0], MessageGroupId: wallet.id, MessageDeduplicationId: id,
            MessageBody: JSON.stringify({ messageId: id, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: {
                providerId: 'runtime-test', externalTransactionId: id, idempotencyKey: id, walletId: wallet.id, playerId: wallet.playerId,
                roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
            } }) }));
        const deadline = Date.now() + 12000;
        let published = 0;
        while (Date.now() < deadline) {
            const rows = await orm.em.execute('select id from outbox_messages where published_at is not null');
            published = rows.length;
            if (published === 4) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(published).toBe(4); // OPENING + BET, each has decision and balance event.
        const rows = await orm.em.execute('select balance from wallets where id = ?', [wallet.id]);
        expect(rows[0]?.balance).toBe('75.00');
        const delivered = await client.send(new ReceiveMessageCommand({ QueueUrl: urls[1], MaxNumberOfMessages: 10 }));
        expect(delivered.Messages?.length).toBe(4);
        const events = delivered.Messages!.map(m => JSON.parse(m.Body!));
        expect(events.filter(e => e.type === 'WalletBalanceChanged')).toHaveLength(2);
        await app.close(); app = undefined;
        const remaining = await client.send(new ReceiveMessageCommand({ QueueUrl: urls[0], WaitTimeSeconds: 1 }));
        expect(remaining.Messages ?? []).toHaveLength(0);
    } finally {
        await app?.close();
        if (oldInput === undefined) delete process.env.WAGER_SQS_QUEUE_URL; else process.env.WAGER_SQS_QUEUE_URL = oldInput;
        if (oldEvents === undefined) delete process.env.WAGER_SQS_EVENTS_QUEUE_URL; else process.env.WAGER_SQS_EVENTS_QUEUE_URL = oldEvents;
        for (const QueueUrl of urls) await client.send(new DeleteQueueCommand({ QueueUrl }));
        client.destroy(); await closeTestOrm(orm);
    }
}, 30000);

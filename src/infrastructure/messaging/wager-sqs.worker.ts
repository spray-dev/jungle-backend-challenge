import { Logger } from '@nestjs/common';
import type { WagerSqsConsumer } from './wager-sqs-consumer.js';
import { PollingWorker } from './polling.worker.js';

export class WagerSqsWorker extends PollingWorker {
    constructor(consumer?: Pick<WagerSqsConsumer, 'pollOnce'>, intervalMs = 100, dispose?: () => void) {
        const logger = new Logger(WagerSqsWorker.name);
        super(WagerSqsWorker.name, consumer ? async () => {
            const result = await consumer.pollOnce();
            if (result === 'TRANSIENT_FAILURE' || result === 'PERMANENT_FAILURE') {
                logger.warn({ event: 'wager_consume_failed', category: result });
            }
        } : undefined, intervalMs, dispose);
    }
}

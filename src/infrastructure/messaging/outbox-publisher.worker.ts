import { Logger } from '@nestjs/common';
import type { OutboxPublisherService } from '../../application/services/outbox-publisher.service.js';
import { PollingWorker } from './polling.worker.js';

export class OutboxPublisherWorker extends PollingWorker {
    constructor(service?: Pick<OutboxPublisherService, 'publishPending'>, intervalMs = 1000, dispose?: () => void) {
        const logger = new Logger(OutboxPublisherWorker.name);
        super(OutboxPublisherWorker.name, service ? async () => {
            const result = await service.publishPending();
            if (result.failed) logger.warn({ event: 'outbox_publish_failed', failed: result.failed });
        } : undefined, intervalMs, dispose);
    }
}

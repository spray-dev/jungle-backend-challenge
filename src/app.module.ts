import { WagerSqsWorker } from './infrastructure/messaging/wager-sqs.worker.js';
import { OutboxPublisherWorker } from './infrastructure/messaging/outbox-publisher.worker.js';
import { WagerSqsConsumer } from './infrastructure/messaging/wager-sqs-consumer.js';
import { SqsIntegrationEventPublisher } from './infrastructure/messaging/sqs-integration-event.publisher.js';
import { createSqsClient } from './infrastructure/messaging/sqs-client.js';
import { OutboxPublisherService } from './application/services/outbox-publisher.service.js';
import { WalletController } from './http/wallet.controller.js';
import { WagerController } from './http/wager.controller.js';
import { MikroORM } from "@mikro-orm/postgresql";
import { RetryPendingReferenceService } from "./application/services/retry-pending-reference.service.js";
import { PendingReferenceWorker } from "./infrastructure/messaging/pending-reference.worker.js";
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

import { MikroOrmModule } from "@mikro-orm/nestjs";
import mikroOrmConfig from "./mikro-orm.config.js";

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
  ],
  providers: [{ provide: PendingReferenceWorker, inject: [MikroORM],
    useFactory: (orm: MikroORM) => new PendingReferenceWorker(new RetryPendingReferenceService(orm.em)) },
    { provide: WagerSqsWorker, inject: [MikroORM], useFactory: (orm: MikroORM) => {
      const url = process.env.WAGER_SQS_QUEUE_URL?.trim();
      if (!url) return new WagerSqsWorker();
      const client = createSqsClient();
      return new WagerSqsWorker(new WagerSqsConsumer(client, url, orm.em), 100, () => client.destroy());
    } },
    { provide: OutboxPublisherWorker, inject: [MikroORM], useFactory: (orm: MikroORM) => {
      const url = process.env.WAGER_SQS_EVENTS_QUEUE_URL?.trim();
      if (!url) return new OutboxPublisherWorker();
      const client = createSqsClient();
      return new OutboxPublisherWorker(new OutboxPublisherService(orm.em,
        new SqsIntegrationEventPublisher(client, url)), 1000, () => client.destroy());
    } } ],
  controllers: [HealthController, WalletController, WagerController],
})

export class AppModule {}

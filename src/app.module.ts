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
    useFactory: (orm: MikroORM) => new PendingReferenceWorker(new RetryPendingReferenceService(orm.em)) }],
  controllers: [HealthController, WalletController, WagerController],
})

export class AppModule {}

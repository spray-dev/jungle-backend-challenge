import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

import { MikroOrmModule } from "@mikro-orm/nestjs";
import mikroOrmConfig from "./mikro-orm.config.js";

@Module({
  controllers: [HealthController],
})

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
  ],
  controllers: [HealthController],
})

export class AppModule {}

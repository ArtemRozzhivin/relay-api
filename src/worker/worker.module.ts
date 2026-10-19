import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import { PrismaModule } from '../prisma/prisma.module.js';
import { JobCoreModule } from '../jobs/job-core.module.js';
import { JOBS_QUEUE } from '../jobs/job-queue.js';
import { JobsProcessor } from './jobs.processor.js';
import { workerEnvSchema, type WorkerEnv } from '../config/env.schema.js';
import { buildWorkerLoggerParams } from '../common/logging/logger.params.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      validationSchema: workerEnvSchema,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildWorkerLoggerParams,
    }),
    PrismaModule,
    JobCoreModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnv, true>) => ({
        connection: { url: config.get('REDIS_URL', { infer: true }) },
      }),
    }),
    BullModule.registerQueue({ name: JOBS_QUEUE }),
  ],
  providers: [JobsProcessor],
})
export class WorkerModule {}

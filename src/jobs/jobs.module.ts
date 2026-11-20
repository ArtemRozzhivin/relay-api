import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { JobCoreModule } from './job-core.module.js';
import { AI_QUEUE, JOBS_QUEUE } from './job-queue.js';
import { JobQueues } from './job-queues.js';
import { OutboxRelayService } from './outbox-relay.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { QueueMetrics } from './queue-metrics.js';

@Module({
  imports: [
    JobCoreModule,
    StorageModule,
    ScheduleModule.forRoot(),
    BullModule.registerQueue({ name: JOBS_QUEUE }, { name: AI_QUEUE }),
  ],
  controllers: [JobsController],
  providers: [JobsService, OutboxRelayService, QueueMetrics, JobQueues],
})
export class JobsModule {}

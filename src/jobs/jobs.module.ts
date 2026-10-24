import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { JobCoreModule } from './job-core.module.js';
import { JOBS_QUEUE } from './job-queue.js';
import { OutboxRelayService } from './outbox-relay.service.js';

@Module({
  imports: [
    JobCoreModule,
    ScheduleModule.forRoot(),
    BullModule.registerQueue({ name: JOBS_QUEUE }),
  ],
  controllers: [JobsController],
  providers: [JobsService, OutboxRelayService],
})
export class JobsModule {}

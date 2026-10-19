import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { JobCoreModule } from './job-core.module.js';
import { JOBS_QUEUE } from './job-queue.js';

@Module({
  imports: [JobCoreModule, BullModule.registerQueue({ name: JOBS_QUEUE })],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}

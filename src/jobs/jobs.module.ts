import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { JobTransitionService } from './job-transition.service.js';

@Module({
  controllers: [JobsController],
  providers: [JobsService, JobTransitionService],
  exports: [JobsService, JobTransitionService],
})
export class JobsModule {}

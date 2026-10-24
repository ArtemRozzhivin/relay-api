import { Module } from '@nestjs/common';
import { JobTransitionService } from './job-transition.service.js';
import { JobHandlerRegistry } from './job-handler.registry.js';

@Module({
  providers: [JobTransitionService, JobHandlerRegistry],
  exports: [JobTransitionService, JobHandlerRegistry],
})
export class JobCoreModule {}

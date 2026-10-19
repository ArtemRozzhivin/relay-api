import { Module } from '@nestjs/common';
import { JobTransitionService } from './job-transition.service.js';

@Module({
  providers: [JobTransitionService],
  exports: [JobTransitionService],
})
export class JobCoreModule {}

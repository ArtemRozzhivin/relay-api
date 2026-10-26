import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { JobTransitionService } from './job-transition.service.js';
import { JobHandlerRegistry } from './job-handler.registry.js';
import { JobEventsPublisher } from './job-events.publisher.js';

@Module({
  imports: [RedisModule],
  providers: [JobTransitionService, JobHandlerRegistry, JobEventsPublisher],
  exports: [JobTransitionService, JobHandlerRegistry, JobEventsPublisher],
})
export class JobCoreModule {}

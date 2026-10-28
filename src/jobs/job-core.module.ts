import { Module, type Type } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { JobTransitionService } from './job-transition.service.js';
import { JobHandlerRegistry } from './job-handler.registry.js';
import { JobContextFactory } from './job-context.factory.js';
import { JobEventsPublisher } from './job-events.publisher.js';
import { JOB_HANDLERS, type RunnableJobHandler } from './job-handler.js';
import { MockJobHandler } from './handlers/mock.handler.js';
import { ChargeJobHandler } from './handlers/charge.handler.js';
import type { JobType } from './jobs.schema.js';

// Keyed by type rather than listed: `Record<JobType, …>` makes a job type with
// no handler a compile error, which is the one guarantee lost when the
// processor's `switch (job.type)` went away. Adding a job type means adding an
// option to the submit union and an entry here. Nothing in src/worker/ changes.
const HANDLERS: Record<JobType, Type<RunnableJobHandler>> = {
  MOCK: MockJobHandler,
  CHARGE: ChargeJobHandler,
};

const handlerProviders = Object.values(HANDLERS);

@Module({
  imports: [RedisModule],
  providers: [
    JobTransitionService,
    JobHandlerRegistry,
    JobContextFactory,
    JobEventsPublisher,
    ...handlerProviders,
    {
      provide: JOB_HANDLERS,
      useFactory: (...resolved: RunnableJobHandler[]) => resolved,
      inject: handlerProviders,
    },
  ],
  exports: [
    JobTransitionService,
    JobHandlerRegistry,
    JobContextFactory,
    JobEventsPublisher,
  ],
})
export class JobCoreModule {}

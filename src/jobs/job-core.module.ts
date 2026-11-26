import { Module, type Type } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { JobTransitionService } from './engine/job-transition.service.js';
import { JobHandlerRegistry } from './engine/job-handler.registry.js';
import { JobContextFactory } from './engine/job-context.factory.js';
import { JobEventsPublisher } from './events/job-events.publisher.js';
import { JOB_HANDLERS, type RunnableJobHandler } from './engine/job-handler.js';
import { MockJobHandler } from './handlers/mock/mock.handler.js';
import { ChargeJobHandler } from './handlers/charge/charge.handler.js';
import { ImportCsvJobHandler } from './handlers/import-csv/import-csv.handler.js';
import { ImageProcessJobHandler } from './handlers/image-process/image-process.handler.js';
import { AiEnrichJobHandler } from './handlers/ai-enrich/ai-enrich.handler.js';
import { PipelineFinalizeJobHandler } from './handlers/pipeline-finalize/pipeline-finalize.handler.js';
import { StorageModule } from '../storage/storage.module.js';
import { ProductsModule } from '../products/products.module.js';
import { OutboundModule } from '../outbound/outbound.module.js';
import { EnrichmentModule } from '../enrichment/enrichment.module.js';
import type { JobType } from './jobs.schema.js';

// Keyed by type rather than listed: `Record<JobType, …>` makes a job type with
// no handler a compile error, which is the one guarantee lost when the
// processor's `switch (job.type)` went away. Adding a job type means adding an
// option to the submit union — or, for one only the server writes, to `JobType`
// — and an entry here. A type that calls the model also goes in `AI_TYPES`
// (delivery/job-queue.ts), for the queue whose limiter a 429 pauses; one that
// costs money or holds a shared queue gets a cap in `UNFINISHED_CAPS`
// (api/unfinished-caps.ts, D32). Nothing in src/worker/ changes.
const HANDLERS: Record<JobType, Type<RunnableJobHandler>> = {
  MOCK: MockJobHandler,
  CHARGE: ChargeJobHandler,
  'import.csv': ImportCsvJobHandler,
  'image.process': ImageProcessJobHandler,
  'ai.enrich': AiEnrichJobHandler,
  'pipeline.finalize': PipelineFinalizeJobHandler,
};

const handlerProviders = Object.values(HANDLERS);

@Module({
  imports: [
    RedisModule,
    StorageModule,
    ProductsModule,
    OutboundModule,
    EnrichmentModule,
  ],
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

import { Logger } from '@nestjs/common';
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import type { Job as QueueJob } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { JobTransitionService } from '../jobs/job-transition.service.js';
import { jobHandlers } from '../jobs/job-handlers.js';
import { JOBS_QUEUE, type JobMessage } from '../jobs/job-queue.js';
import { Prisma } from '../generated/prisma/client.js';

// A decorator is evaluated when the class is defined, before the DI container
// exists, so ConfigService is unreachable here. WORKER_CONCURRENCY is still
// validated by workerEnvSchema at boot; this read is only to shape the worker.
@Processor(JOBS_QUEUE, {
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
})
export class JobsProcessor extends WorkerHost {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: JobTransitionService,
  ) {
    super();
  }

  async process(message: QueueJob<JobMessage>) {
    const { jobId, correlationId } = message.data;

    const claimed = await this.transitions.claim(jobId);

    if (!claimed) {
      this.logger.log(
        `Skipping job ${jobId}: not claimable (already running or finalised)`,
      );

      return;
    }

    this.logger.log(
      `Running job ${jobId} (${claimed.type}) attempt ${claimed.attempts} [correlationId=${correlationId}]`,
    );

    try {
      const handler = jobHandlers[claimed.type];
      const result = await handler(claimed.payload as never);

      await this.transitions.succeed(jobId, result as Prisma.InputJsonValue);

      return result;
    } catch (error) {
      const message_ = error instanceof Error ? error.message : String(error);

      await this.transitions.deadLetter(jobId, {
        code: 'HANDLER_FAILED',
        message: message_,
      });

      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(message: QueueJob<JobMessage>, error: Error) {
    this.logger.warn(
      `Job ${message.data?.jobId} failed: ${error.message}`,
    );
  }
}

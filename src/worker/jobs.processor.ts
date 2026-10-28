import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job as QueueJob } from 'bullmq';
import { JobTransitionService } from '../jobs/job-transition.service.js';
import { JobHandlerRegistry } from '../jobs/job-handler.registry.js';
import { JobContextFactory } from '../jobs/job-context.factory.js';
import { JobEventsPublisher } from '../jobs/job-events.publisher.js';
import { JOBS_QUEUE, type JobMessage } from '../jobs/job-queue.js';
import { TerminalJobError } from '../common/errors/app-error.js';

@Processor(JOBS_QUEUE, {
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
})
export class JobsProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(JobsProcessor.name);
  private readonly finalising = new Set<Promise<void>>();

  constructor(
    private readonly transitions: JobTransitionService,
    private readonly handlers: JobHandlerRegistry,
    private readonly contexts: JobContextFactory,
    private readonly events: JobEventsPublisher,
  ) {
    super();
  }

  async process(message: QueueJob<JobMessage>) {
    const { jobId, correlationId } = message.data;

    const claimed = await this.transitions.claim(jobId);

    if (!claimed) {
      this.logger.log(`Job ${jobId} is already finalised; nothing to do`);

      return;
    }

    const attempt = claimed.attempts;

    await this.events.jobUpdated(claimed);

    this.logger.log(
      `Running job ${jobId} (${claimed.type}) attempt ${attempt}/${claimed.maxAttempts} [correlationId=${correlationId}]`,
    );

    const context = this.contexts.create({
      jobId,
      attempt,
      correlationId,
      progress: claimed.progress,
    });

    try {
      const result = await this.handlers.run(claimed, context);

      // Before the transition, not after: a handler may report without
      // awaiting, and a queued write that lands on a row this method has
      // already finished would be refused and lost — the job would finish
      // showing its second-to-last batch.
      await context.flush();

      const succeeded = await this.transitions.succeed(jobId, attempt, result);

      if (succeeded) {
        await this.events.jobUpdated(succeeded);
      } else {
        this.logger.warn(
          `Job ${jobId} finished on attempt ${attempt} but that attempt no longer owns it`,
        );
      }

      return result;
    } catch (cause) {
      // Same reason as the success path, and it matters more here: a retry keeps
      // the progress of the attempt that failed.
      await context.flush();

      const reason = cause instanceof Error ? cause.message : String(cause);

      const isTerminal =
        cause instanceof TerminalJobError ||
        cause instanceof UnrecoverableError;
      const isExhausted = attempt >= claimed.maxAttempts;

      if (isTerminal || isExhausted) {
        const dead = await this.transitions.deadLetter(jobId, attempt, {
          code: isTerminal ? 'TERMINAL_FAILURE' : 'ATTEMPTS_EXHAUSTED',
          message: reason,
          attempt,
        });

        if (dead) {
          await this.events.jobUpdated(dead);

          this.logger.error(
            `Job ${jobId} dead-lettered after ${attempt} attempt(s): ${reason}`,
          );
        } else {
          this.logger.warn(
            `Job ${jobId} failed on attempt ${attempt}, which no longer owns it; dead-letter skipped`,
          );
        }

        throw new UnrecoverableError(reason);
      }

      const requeued = await this.transitions.requeueForRetry(jobId, attempt, {
        code: 'ATTEMPT_FAILED',
        message: reason,
        attempt,
      });

      if (!requeued) {
        this.logger.warn(
          `Job ${jobId} failed on attempt ${attempt}, which no longer owns it; retry not scheduled`,
        );
      } else {
        await this.events.jobUpdated(requeued);

        this.logger.warn(
          `Job ${jobId} attempt ${attempt}/${claimed.maxAttempts} failed, will retry: ${reason}`,
        );
      }

      throw cause;
    }
  }

  // The queue can abandon a job without ever calling process(): past
  // maxStalledCount (default 1) it fails the job itself with "job stalled more
  // than allowable limit". 'failed' fires on every failed attempt, but
  // finishedOn is set only once the queue has stopped redelivering, so it is
  // the one signal that distinguishes "will retry" from "gave up".
  @OnWorkerEvent('failed')
  onFailed(message: QueueJob<JobMessage> | undefined, error: Error) {
    const jobId = message?.data?.jobId;

    if (!jobId || !message?.finishedOn) {
      return;
    }

    // Registered as a bare event listener, so nothing holds this promise or
    // waits for it on shutdown; tracking it is what makes onModuleDestroy able
    // to finish a dead-letter that is in flight when SIGTERM arrives.
    const task = this.finalise(jobId, error);

    this.finalising.add(task);
    void task.finally(() => this.finalising.delete(task));
  }

  private async finalise(jobId: string, error: Error) {
    try {
      const abandoned = await this.transitions.abandon(jobId, {
        code: 'DELIVERY_ABANDONED',
        message: error.message,
      });

      if (abandoned) {
        await this.events.jobUpdated(abandoned);

        this.logger.error(
          `Job ${jobId} dead-lettered: the queue stopped redelivering it (${error.message})`,
        );
      }
    } catch (cause) {
      this.logger.error(
        `Job ${jobId} was abandoned by the queue and could not be finalised: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }

  async onModuleDestroy() {
    await Promise.allSettled(this.finalising);
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(
      `Job ${jobId} stalled; the queue will redeliver it or abandon it`,
    );
  }
}

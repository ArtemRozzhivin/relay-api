import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, UnrecoverableError, type Job as QueueJob } from 'bullmq';
import { JobTransitionService } from '../jobs/job-transition.service.js';
import { JobHandlerRegistry } from '../jobs/job-handler.registry.js';
import { JobContextFactory } from '../jobs/job-context.factory.js';
import { JobCancelledError } from '../jobs/job-handler.js';
import { JobEventsPublisher } from '../jobs/job-events.publisher.js';
import { JOBS_QUEUE, type JobMessage } from '../jobs/job-queue.js';
import { AppError, TerminalJobError } from '../common/errors/app-error.js';
import type { DeadLetterCode } from '../jobs/job-error-codes.js';
import type { WorkerEnv } from '../config/env.schema.js';

// The HTTP filter's rule, applied to a job's error: only an AppError's message
// was written for the job's owner. Anything else — Prisma, S3, a socket — can
// name a table, the principal a bucket refused, or an internal address, so the
// owner is told only that it happened and where to point, and the worker's log
// keeps what. The correlation id is the submit's request id, which the owner
// already holds.
const ownerMessage = (error: unknown, correlationId: string) =>
  error instanceof AppError
    ? error.message
    : `Internal error; the worker's log has it under correlationId ${correlationId}`;

@Processor(JOBS_QUEUE, {
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
})
export class JobsProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(JobsProcessor.name);
  private readonly finalising = new Set<Promise<void>>();

  // Set when shutdown begins: from then on, every running handler is told to
  // stop at its next safe point.
  private stopping = false;

  constructor(
    private readonly transitions: JobTransitionService,
    private readonly handlers: JobHandlerRegistry,
    private readonly contexts: JobContextFactory,
    private readonly events: JobEventsPublisher,
    private readonly config: ConfigService<WorkerEnv, true>,
  ) {
    super();
  }

  async process(message: QueueJob<JobMessage>, token?: string) {
    const { jobId, correlationId } = message.data;

    // Before the claim, not after: a retry scheduled after the cancel request,
    // or a redelivery after the worker running it died, would otherwise run the
    // handler again — and whatever it does before its first boundary is work
    // its owner asked not to happen.
    const cancelled = await this.transitions.cancelBeforeClaim(jobId);

    if (cancelled) {
      await this.events.jobUpdated(cancelled);
      this.logger.log(
        `Job ${jobId} cancelled before it ran [correlationId=${correlationId}]`,
      );

      return;
    }

    const claimed = await this.transitions.claim(jobId);

    if (!claimed) {
      this.logger.log(`Job ${jobId} is already finalised; nothing to do`);

      return;
    }

    // Two numbers, two jobs: `attempt` counts against the retry budget and is
    // what logs and errors show; `lease` is the ownership token every write
    // carries. A re-drive resets the first and never the second.
    const attempt = claimed.attempts;
    const lease = claimed.lease;

    await this.events.jobUpdated(claimed);

    this.logger.log(
      `Running job ${jobId} (${claimed.type}) attempt ${attempt}/${claimed.maxAttempts} [correlationId=${correlationId}]`,
    );

    const context = this.contexts.create({
      jobId,
      userId: claimed.userId,
      attempt,
      lease,
      correlationId,
      progress: claimed.progress,
      checkpoint: claimed.checkpoint,
      stopping: () => this.stopping,
    });

    try {
      const result = await this.handlers.run(claimed, context);

      // Before the transition, not after: a handler may report without
      // awaiting, and a queued write that lands on a row this method has
      // already finished would be refused and lost — the job would finish
      // showing its second-to-last batch.
      await context.flush();

      const succeeded = await this.transitions.succeed(jobId, lease, result);

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

      if (cause instanceof JobCancelledError) {
        const stopped = await this.transitions.cancel(jobId, lease);

        if (stopped) {
          await this.events.jobUpdated(stopped);
          this.logger.log(
            `Job ${jobId} cancelled at a safe point on attempt ${attempt}`,
          );

          return;
        }

        const released = this.stopping
          ? await this.transitions.release(jobId, lease)
          : null;

        if (released) {
          await this.events.jobUpdated(released);
          this.logger.log(
            `Job ${jobId} handed back at a safe point for the next worker; attempt ${attempt} not counted`,
          );

          // Back to the queue without failing: a thrown error would spend one
          // of the queue's attempts and wait out a backoff first.
          await message.moveToDelayed(Date.now(), token);

          throw new DelayedError();
        }

        // shouldStop() is also true for an attempt that lost the job; the
        // attempt that holds it now is the one entitled to finish it.
        this.logger.warn(
          `Job ${jobId} stopped on attempt ${attempt}, which no longer owns it`,
        );

        // Returned, not thrown: stopping when asked is the job doing what it
        // was told, so the queue records the delivery as complete rather than
        // failed and schedules nothing.
        return;
      }

      const detail = cause instanceof Error ? cause.message : String(cause);
      const reason = ownerMessage(cause, correlationId);

      const isTerminal =
        cause instanceof TerminalJobError ||
        cause instanceof UnrecoverableError;
      const isExhausted = attempt >= claimed.maxAttempts;

      if (isTerminal || isExhausted) {
        const dead = await this.transitions.deadLetter(jobId, lease, {
          code: (isTerminal
            ? 'TERMINAL_FAILURE'
            : 'ATTEMPTS_EXHAUSTED') satisfies DeadLetterCode,
          ...(cause instanceof TerminalJobError && cause.reason
            ? { reason: cause.reason }
            : {}),
          message: reason,
          attempt,
        });

        if (dead) {
          await this.events.jobUpdated(dead);

          this.logger.error(
            `Job ${jobId} dead-lettered after ${attempt} attempt(s): ${detail}`,
          );
        } else {
          this.logger.warn(
            `Job ${jobId} failed on attempt ${attempt}, which no longer owns it; dead-letter skipped`,
          );
        }

        throw new UnrecoverableError(reason);
      }

      const requeued = await this.transitions.requeueForRetry(jobId, lease, {
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
          `Job ${jobId} attempt ${attempt}/${claimed.maxAttempts} failed, will retry: ${detail}`,
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
    const { jobId, correlationId } = message?.data ?? {};

    if (!jobId || !correlationId || !message?.finishedOn) {
      return;
    }

    // Loses the event exactly as a worker killed before abandon() lands would,
    // so A5d can prove the sweep recovers the job. Never set in production.
    if (this.config.get('RELAY_FAULT_SKIP_ABANDON', { infer: true })) {
      return;
    }

    // Registered as a bare event listener, so nothing holds this promise or
    // waits for it on shutdown; tracking it is what makes onModuleDestroy able
    // to finish a dead-letter that is in flight when SIGTERM arrives.
    const task = this.finalise(jobId, correlationId, error);

    this.finalising.add(task);
    void task.finally(() => this.finalising.delete(task));
  }

  private async finalise(jobId: string, correlationId: string, error: Error) {
    try {
      const abandoned = await this.transitions.abandon(jobId, {
        code: 'DELIVERY_ABANDONED' satisfies DeadLetterCode,
        // Either BullMQ's own — a stall past the limit — or one process()
        // threw with a message already made safe. Anything else is what
        // process() threw before it could catch it: a refused claim, say.
        message:
          error instanceof UnrecoverableError
            ? error.message
            : ownerMessage(error, correlationId),
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

  // Drained here, not in @nestjs/bullmq's own onApplicationShutdown: Nest runs
  // every module's onModuleDestroy first, and those close the S3 client and
  // Redis that a running job is still using. This module is the root, so its
  // hook runs before theirs.
  async onModuleDestroy() {
    this.stopping = true;
    await this.worker.close();
    await Promise.allSettled(this.finalising);
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(
      `Job ${jobId} stalled; the queue will redeliver it or abandon it`,
    );
  }
}

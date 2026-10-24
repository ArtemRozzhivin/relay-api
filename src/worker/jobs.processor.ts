import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job as QueueJob } from 'bullmq';
import { JobTransitionService } from '../jobs/job-transition.service.js';
import { JobHandlerRegistry } from '../jobs/job-handler.registry.js';
import { JOBS_QUEUE, type JobMessage } from '../jobs/job-queue.js';
import { TerminalJobError } from '../common/errors/app-error.js';

@Processor(JOBS_QUEUE, {
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
})
export class JobsProcessor extends WorkerHost {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    private readonly transitions: JobTransitionService,
    private readonly handlers: JobHandlerRegistry,
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

    this.logger.log(
      `Running job ${jobId} (${claimed.type}) attempt ${claimed.attempts}/${claimed.maxAttempts} [correlationId=${correlationId}]`,
    );

    try {
      const result = await this.handlers.run(claimed);

      if (!(await this.transitions.succeed(jobId, result))) {
        this.logger.warn(
          `Job ${jobId} finished but was already finalised elsewhere`,
        );
      }

      return result;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);

      const isTerminal =
        cause instanceof TerminalJobError || cause instanceof UnrecoverableError;
      const isExhausted = claimed.attempts >= claimed.maxAttempts;

      if (isTerminal || isExhausted) {
        if (
          await this.transitions.deadLetter(jobId, {
            code: isTerminal ? 'TERMINAL_FAILURE' : 'ATTEMPTS_EXHAUSTED',
            message: reason,
            attempt: claimed.attempts,
          })
        ) {
          this.logger.error(
            `Job ${jobId} dead-lettered after ${claimed.attempts} attempt(s): ${reason}`,
          );
        } else {
          this.logger.warn(
            `Job ${jobId} was already finalised elsewhere; dead-letter skipped`,
          );
        }

        throw new UnrecoverableError(reason);
      }

      if (
        !(await this.transitions.requeueForRetry(jobId, {
          code: 'ATTEMPT_FAILED',
          message: reason,
          attempt: claimed.attempts,
        }))
      ) {
        this.logger.warn(
          `Job ${jobId} could not be requeued; it is already finalised`,
        );
      }

      this.logger.warn(
        `Job ${jobId} attempt ${claimed.attempts}/${claimed.maxAttempts} failed, will retry: ${reason}`,
      );

      throw cause;
    }
  }

  // The queue can abandon a job without ever calling process(): past
  // maxStalledCount (default 1) it fails the job itself with "job stalled more
  // than allowable limit". 'failed' fires on every failed attempt, but
  // finishedOn is set only once the queue has stopped redelivering, so it is
  // the one signal that distinguishes "will retry" from "gave up".
  @OnWorkerEvent('failed')
  async onFailed(message: QueueJob<JobMessage> | undefined, error: Error) {
    const jobId = message?.data?.jobId;

    if (!jobId || !message?.finishedOn) {
      return;
    }

    try {
      if (
        await this.transitions.deadLetter(jobId, {
          code: 'DELIVERY_ABANDONED',
          message: error.message,
          attempt: message.attemptsMade,
        })
      ) {
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

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(
      `Job ${jobId} stalled; the queue will redeliver it or abandon it`,
    );
  }
}

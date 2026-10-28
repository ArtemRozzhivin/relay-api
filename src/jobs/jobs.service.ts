import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  JobAlreadyFinishedError,
  JobNotDeadLetteredError,
  JobNotFoundError,
} from '../common/errors/app-error.js';
import { JobTransitionService } from './job-transition.service.js';
import { JobEventsPublisher } from './job-events.publisher.js';
import { Prisma } from '../generated/prisma/client.js';
import { JOBS_QUEUE, messageId, type JobMessage } from './job-queue.js';
import type { ListJobsQuery, SubmitJobInput } from './jobs.schema.js';
import type { ApiEnv } from '../config/env.schema.js';

interface SubmitArgs {
  userId: string;
  idempotencyKey: string;
  correlationId: string;
  input: SubmitJobInput;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: JobTransitionService,
    private readonly events: JobEventsPublisher,
    private readonly config: ConfigService<ApiEnv, true>,
    @InjectQueue(JOBS_QUEUE) private readonly queue: Queue<JobMessage>,
  ) {}

  async submit({ userId, idempotencyKey, correlationId, input }: SubmitArgs) {
    let committed;

    try {
      committed = await this.prisma.$transaction(async (tx) => {
        const job = await tx.job.create({
          data: {
            userId,
            idempotencyKey,
            correlationId,
            type: input.type,
            payload: input.payload,
            maxAttempts: input.maxAttempts,
          },
        });

        const outbox = await tx.outbox.create({
          data: {
            jobId: job.id,
            queue: JOBS_QUEUE,
            jobName: job.type,
            payload: {
              jobId: job.id,
              correlationId,
              maxAttempts: job.maxAttempts,
            },
          },
        });

        return { job, outboxId: outbox.id };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.job.findUniqueOrThrow({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });

        return { job: existing, replayed: true };
      }

      throw error;
    }

    if (this.config.get('RELAY_FAULT_AFTER_COMMIT', { infer: true })) {
      throw new Error(
        'Injected fault: committed the job row, never enqueued it',
      );
    }

    const { job, outboxId } = committed;

    await this.enqueue(
      job.id,
      outboxId,
      job.type,
      job.maxAttempts,
      correlationId,
    );
    await this.markPublished(outboxId);
    await this.events.jobUpdated(job);

    return { job, replayed: false };
  }

  private async enqueue(
    jobId: string,
    outboxId: bigint,
    type: string,
    maxAttempts: number,
    correlationId: string,
  ) {
    await this.queue.add(
      type,
      { jobId, correlationId },
      {
        jobId: messageId(jobId, outboxId),
        attempts: maxAttempts,
        backoff: { type: 'exponential', delay: 1000, jitter: 1 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      },
    );

    this.logger.log(`Enqueued job ${jobId} (${type})`);
  }

  private async markPublished(outboxId: bigint) {
    await this.prisma.outbox.updateMany({
      where: { id: outboxId, publishedAt: null },
      data: { publishedAt: new Date() },
    });
  }

  async redrive(userId: string, jobId: string, correlationId: string) {
    const existing = await this.findOne(userId, jobId);

    const requeued = await this.prisma.$transaction(async (tx) => {
      const job = await this.transitions.redrive(existing.id, tx);

      if (!job) {
        return null;
      }

      const outbox = await tx.outbox.create({
        data: {
          jobId: job.id,
          queue: JOBS_QUEUE,
          jobName: job.type,
          payload: {
            jobId: job.id,
            correlationId,
            maxAttempts: job.maxAttempts,
          },
        },
      });

      return { job, outboxId: outbox.id };
    });

    if (!requeued) {
      throw new JobNotDeadLetteredError();
    }

    const { job, outboxId } = requeued;

    await this.enqueue(
      job.id,
      outboxId,
      job.type,
      job.maxAttempts,
      correlationId,
    );
    await this.markPublished(outboxId);
    await this.events.jobUpdated(job);

    return job;
  }

  /**
   * Asks for a job to stop.
   *
   * @returns the job as it stands after the request: `CANCELLED` if it had not
   * started, or still `RUNNING` with `cancelRequested` if a handler has it —
   * only the worker can tell when the handler has reached a safe point. A job
   * that was *already* `CANCELLED` is returned as it is, so a client retrying a
   * cancel whose response it lost gets the same answer as the first time.
   * @throws JobNotFoundError when the job does not exist or is another tenant's.
   * @throws JobAlreadyFinishedError when it had already succeeded or been
   * dead-lettered. The request changed nothing, and an "accepted" would make
   * the caller read the body to discover its cancel had no effect.
   */
  async cancel(userId: string, jobId: string) {
    const existing = await this.findOne(userId, jobId);

    const flagged = await this.transitions.requestCancel(existing.id);

    if (!flagged) {
      // The flag was refused, so the job had finished. Re-read to learn how:
      // `existing` may predate the finish. Already cancelled is the one finish
      // the caller asked for, so it is answered as a success; any other
      // happened in spite of the request. (A re-drive in between can make this
      // read show QUEUED — a later life the request never reached, for which
      // "already finished" is still the true answer.)
      const current = await this.findOne(userId, jobId);

      if (current.status === 'CANCELLED') {
        return current;
      }

      throw new JobAlreadyFinishedError();
    }

    if (flagged.status === 'QUEUED') {
      const cancelled = await this.transitions.cancelQueued(flagged.id);

      if (cancelled) {
        await this.removeFromQueue(cancelled.id);
        await this.events.jobUpdated(cancelled);

        return cancelled;
      }

      // A worker claimed it between the two writes. It will see the flag at
      // the handler's first boundary, so the request is not lost — but the
      // row just written is stale, and emitting it could arrive after the
      // worker's RUNNING event and walk a client's view backwards.
      return this.findOne(userId, jobId);
    }

    await this.events.jobUpdated(flagged);

    return flagged;
  }

  // Best-effort, and correctness does not depend on it: a CANCELLED row is
  // refused by claim(), so a delivery that slips through finishes as a no-op.
  // Removing the entry only spares a worker that delivery — and remove()
  // refuses an entry another process holds locked, which is harmless here.
  private async removeFromQueue(jobId: string) {
    const outbox = await this.prisma.outbox.findFirst({
      where: { jobId },
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    if (!outbox) {
      return;
    }

    try {
      await this.queue.remove(messageId(jobId, outbox.id));
    } catch (error) {
      this.logger.warn(
        `Could not remove cancelled job ${jobId} from the queue: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async findOne(userId: string, jobId: string) {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, userId },
    });

    if (!job) {
      throw new JobNotFoundError();
    }

    return job;
  }

  async findMany(userId: string, query: ListJobsQuery) {
    const where = {
      userId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.job.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.job.count({ where }),
    ]);

    return { items, total, limit: query.limit, offset: query.offset };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import {
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

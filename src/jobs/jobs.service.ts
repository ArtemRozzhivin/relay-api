import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { JobNotFoundError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { JOBS_QUEUE, type JobMessage } from './job-queue.js';
import type { ListJobsQuery, SubmitJobInput } from './jobs.schema.js';

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
    @InjectQueue(JOBS_QUEUE) private readonly queue: Queue<JobMessage>,
  ) {}

  async submit({ userId, idempotencyKey, correlationId, input }: SubmitArgs) {
    let job;

    try {
      job = await this.prisma.job.create({
        data: {
          userId,
          idempotencyKey,
          correlationId,
          type: input.type,
          payload: input.payload,
          maxAttempts: input.maxAttempts,
        },
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

    // Decision D5(b): the row is committed before the enqueue, so a crash in
    // this gap leaves a QUEUED job nobody will run. Assertion A6 measures it;
    // the transactional outbox in M6 closes it.
    await this.queue.add(
      job.type,
      { jobId: job.id, correlationId },
      {
        jobId: job.id,
        attempts: job.maxAttempts,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      },
    );

    this.logger.log(`Enqueued job ${job.id} (${job.type})`);

    return { job, replayed: false };
  }

  async findOne(userId: string, jobId: string) {
    const job = await this.prisma.job.findFirst({ where: { id: jobId, userId } });

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

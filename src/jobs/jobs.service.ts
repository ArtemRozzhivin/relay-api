import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { JobTransitionService } from './job-transition.service.js';
import { jobHandlers } from './job-handlers.js';
import { JobNotFoundError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Job } from '../generated/prisma/client.js';
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
    private readonly transitions: JobTransitionService,
  ) {}

  async submit({ userId, idempotencyKey, correlationId, input }: SubmitArgs) {
    try {
      const job = await this.prisma.job.create({
        data: {
          userId,
          idempotencyKey,
          correlationId,
          type: input.type,
          payload: input.payload,
          maxAttempts: input.maxAttempts,
        },
      });

      const executed = await this.execute(job);

      return { job: executed, replayed: false };
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

  private async execute(job: Job) {
    const claimed = await this.transitions.claim(job.id);

    if (!claimed) {
      return job;
    }

    try {
      const handler = jobHandlers[claimed.type];
      const result = await handler(claimed.payload as never);

      return (
        (await this.transitions.succeed(
          claimed.id,
          result as Prisma.InputJsonValue,
        )) ?? claimed
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`Job ${claimed.id} failed: ${message}`);

      return (
        (await this.transitions.deadLetter(claimed.id, {
          code: 'HANDLER_FAILED',
          message,
        })) ?? claimed
      );
    }
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Job } from '../generated/prisma/client.js';
import type { JobStatus } from '../generated/prisma/enums.js';

const TERMINAL: readonly JobStatus[] = ['SUCCEEDED', 'DEAD_LETTERED'];

const NOT_FINISHED: JobStatus[] = ['QUEUED', 'RUNNING'];

interface MoveOptions {
  client?: Prisma.TransactionClient;
  where?: Prisma.JobWhereInput;
}

@Injectable()
export class JobTransitionService {
  constructor(private readonly prisma: PrismaService) {}

  isTerminal(status: JobStatus) {
    return TERMINAL.includes(status);
  }

  private async move(
    jobId: string,
    from: JobStatus[],
    data: Prisma.JobUpdateManyMutationInput,
    options: MoveOptions = {},
  ): Promise<Job | null> {
    const client = options.client ?? this.prisma;

    const [job] = await client.job.updateManyAndReturn({
      where: { ...options.where, id: jobId, status: { in: from } },
      data,
    });

    return job ?? null;
  }

  claim(jobId: string) {
    return this.move(jobId, NOT_FINISHED, {
      status: 'RUNNING',
      attempts: { increment: 1 },
      startedAt: new Date(),
    });
  }

  // `attempt` is the ownership token: claim() handed this worker that number, and
  // any later claim has moved it on. A worker whose attempt is stale lost the job
  // while it was still running, and must not write over whoever holds it now.
  succeed(jobId: string, attempt: number, result: Prisma.InputJsonValue) {
    return this.move(
      jobId,
      NOT_FINISHED,
      {
        status: 'SUCCEEDED',
        result,
        error: Prisma.DbNull,
        finishedAt: new Date(),
      },
      { where: { attempts: attempt } },
    );
  }

  requeueForRetry(
    jobId: string,
    attempt: number,
    error: Prisma.InputJsonValue,
  ) {
    return this.move(
      jobId,
      ['RUNNING'],
      { status: 'QUEUED', error },
      { where: { attempts: attempt } },
    );
  }

  deadLetter(jobId: string, attempt: number, error: Prisma.InputJsonValue) {
    return this.move(
      jobId,
      NOT_FINISHED,
      { status: 'DEAD_LETTERED', error, finishedAt: new Date() },
      { where: { attempts: attempt } },
    );
  }

  // The queue abandoned the job outside any attempt we own, so there is no token
  // to match on. `attempts > 0` stands in for it: a re-drive resets the counter
  // to 0, so this cannot overwrite a job an operator has just re-driven.
  abandon(jobId: string, error: Prisma.InputJsonValue) {
    return this.move(
      jobId,
      NOT_FINISHED,
      { status: 'DEAD_LETTERED', error, finishedAt: new Date() },
      { where: { attempts: { gt: 0 } } },
    );
  }

  redrive(jobId: string, client?: Prisma.TransactionClient) {
    return this.move(
      jobId,
      ['DEAD_LETTERED'],
      {
        status: 'QUEUED',
        attempts: 0,
        error: Prisma.DbNull,
        result: Prisma.DbNull,
        startedAt: null,
        finishedAt: null,
      },
      { client },
    );
  }
}

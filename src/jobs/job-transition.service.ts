import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Job } from '../generated/prisma/client.js';
import type { JobStatus } from '../generated/prisma/enums.js';

const TERMINAL: readonly JobStatus[] = ['SUCCEEDED', 'DEAD_LETTERED'];

const NOT_FINISHED: JobStatus[] = ['QUEUED', 'RUNNING'];

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
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Job | null> {
    const [job] = await client.job.updateManyAndReturn({
      where: { id: jobId, status: { in: from } },
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

  succeed(jobId: string, result: Prisma.InputJsonValue) {
    return this.move(jobId, ['RUNNING'], {
      status: 'SUCCEEDED',
      result,
      error: Prisma.DbNull,
      finishedAt: new Date(),
    });
  }

  requeueForRetry(jobId: string, error: Prisma.InputJsonValue) {
    return this.move(jobId, ['RUNNING'], { status: 'QUEUED', error });
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
      client,
    );
  }

  // Accepts QUEUED as well as RUNNING: the queue can abandon a job that an
  // earlier attempt had already put back to QUEUED, and that row still has to
  // reach a terminal state or nothing will ever run it again.
  deadLetter(jobId: string, error: Prisma.InputJsonValue) {
    return this.move(jobId, NOT_FINISHED, {
      status: 'DEAD_LETTERED',
      error,
      finishedAt: new Date(),
    });
  }
}

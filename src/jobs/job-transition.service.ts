import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Job } from '../generated/prisma/client.js';
import type { JobStatus } from '../generated/prisma/enums.js';

const TERMINAL: readonly JobStatus[] = ['SUCCEEDED', 'DEAD_LETTERED'];

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
  ): Promise<Job | null> {
    const [job] = await this.prisma.job.updateManyAndReturn({
      where: { id: jobId, status: { in: from } },
      data,
    });

    return job ?? null;
  }

  claim(jobId: string) {
    return this.move(jobId, ['QUEUED'], {
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

  deadLetter(jobId: string, error: Prisma.InputJsonValue) {
    return this.move(jobId, ['RUNNING'], {
      status: 'DEAD_LETTERED',
      error,
      finishedAt: new Date(),
    });
  }
}

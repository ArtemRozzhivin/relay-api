import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Job } from '../generated/prisma/client.js';
import type { JobStatus } from '../generated/prisma/enums.js';
import {
  PROCESSED_PATH,
  toStoredProgress,
  type JobProgress,
} from './job-progress.js';

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

  // Not a status transition, and deliberately not routed through one: a job's
  // status must not change because it counted. It carries the same ownership
  // token all the same — a worker the queue has given up on must not overwrite
  // the progress of the attempt that replaced it (D25). `RUNNING` only, so a
  // write that arrives after the job finished matches no rows instead of putting
  // a count back onto a terminal row.
  /**
   * @param reclaim drops the monotonic predicate for this one write. The caller
   * sets it when the stored value holds a shape it cannot read, where
   * `progress -> 'processed'` is SQL NULL and the comparison below is therefore
   * neither true nor false but NULL — matching no rows, so the column would
   * stay frozen for the rest of the job's life. There is no Prisma filter for
   * "this jsonb path is SQL NULL", so the decision is made by the only code
   * that has already read the value.
   */
  reportProgress(
    jobId: string,
    attempt: number,
    progress: JobProgress,
    { reclaim = false }: { reclaim?: boolean } = {},
  ) {
    const monotonic: Prisma.JobWhereInput = {
      OR: [
        // Nothing reported yet.
        { progress: { equals: Prisma.DbNull } },
        // Monotonic in SQL, not just in the worker's memory: a retry starts a
        // fresh attempt that counts from one again, and without this it would
        // walk the client's bar backwards from where the previous attempt left
        // it (A12). `lte`, so a handler can revise `message` at a count it has
        // already reached.
        { progress: { path: PROCESSED_PATH, lte: progress.processed } },
      ],
    };

    return this.move(
      jobId,
      ['RUNNING'],
      { progress: toStoredProgress(progress) },
      {
        where: {
          attempts: attempt,
          ...(reclaim ? {} : monotonic),
        },
      },
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
        // Cleared because the work starts over: leaving it would show a client
        // 19 500 of 20 000 on a job that has done nothing yet. D26 protects the
        // *checkpoint* from a re-drive, not this, which is presentational.
        progress: Prisma.DbNull,
        startedAt: null,
        finishedAt: null,
      },
      { client },
    );
  }
}

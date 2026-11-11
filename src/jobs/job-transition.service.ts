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

const TERMINAL: readonly JobStatus[] = [
  'SUCCEEDED',
  'DEAD_LETTERED',
  'CANCELLED',
];

const NOT_FINISHED: JobStatus[] = ['QUEUED', 'RUNNING'];

// Thrown inside a checkpoint's transaction only to roll it back; never escapes.
class CheckpointRefused extends Error {}

// What a re-drive resets, shared by the single and bulk forms so they cannot
// drift: a job re-driven one way must look exactly like one re-driven the other.
// `checkpoint` is deliberately absent: a re-drive resumes where the work got to
// (D26), and only a restart asked for by name clears it.
const REDRIVE_RESET = {
  status: 'QUEUED',
  // A fresh retry budget. `lease` is deliberately left alone: it is the
  // ownership token, and resetting it would hand the next claim a number a
  // worker from the previous life may still hold.
  attempts: 0,
  error: Prisma.DbNull,
  result: Prisma.DbNull,
  // Cleared because the next run reports its own: a resumed import starts by
  // reporting its checkpoint, and a restarted one would otherwise show 19 500
  // of 20 000 on a job that has done nothing yet.
  progress: Prisma.DbNull,
  // An operator re-driving a job is asking for it to run again, so a
  // cancellation requested during its previous life must not stop it at the
  // first boundary.
  cancelRequested: false,
  startedAt: null,
  finishedAt: null,
} satisfies Prisma.JobUpdateManyMutationInput;

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
      lease: { increment: 1 },
      startedAt: new Date(),
    });
  }

  // `lease` is the ownership token: claim() handed this worker that number, and
  // any later claim has moved it on — in this life or a re-driven one, since
  // nothing resets it. A worker whose lease is stale lost the job while it was
  // still running, and must not write over whoever holds it now.
  //
  // RUNNING only. A QUEUED row this lease still matches has been re-driven
  // since, and the re-drive's own delivery will run it: a stale worker
  // finishing it would refuse that delivery its claim.
  succeed(jobId: string, lease: number, result: Prisma.InputJsonValue) {
    return this.move(
      jobId,
      ['RUNNING'],
      {
        status: 'SUCCEEDED',
        result,
        error: Prisma.DbNull,
        finishedAt: new Date(),
      },
      { where: { lease } },
    );
  }

  requeueForRetry(jobId: string, lease: number, error: Prisma.InputJsonValue) {
    return this.move(
      jobId,
      ['RUNNING'],
      { status: 'QUEUED', error },
      { where: { lease } },
    );
  }

  deadLetter(jobId: string, lease: number, error: Prisma.InputJsonValue) {
    return this.move(
      jobId,
      ['RUNNING'],
      { status: 'DEAD_LETTERED', error, finishedAt: new Date() },
      { where: { lease } },
    );
  }

  // The queue abandoned the job outside any attempt we own, so there is no token
  // to match on. `attempts > 0` stands in for it: a re-drive resets the counter
  // to 0, so this cannot overwrite a job an operator has just re-driven. It
  // could overwrite one a worker has also claimed since — which needs a
  // re-drive and a claim to land between the queue failing the job and this
  // write, a window of milliseconds. A job no attempt ever claimed — every
  // delivery failed before the claim, with Postgres unreachable, say — is
  // refused too, and left to the sweep (§7.6).
  abandon(jobId: string, error: Prisma.InputJsonValue) {
    return this.move(
      jobId,
      NOT_FINISHED,
      { status: 'DEAD_LETTERED', error, finishedAt: new Date() },
      { where: { attempts: { gt: 0 } } },
    );
  }

  // The sweep found an unfinished row whose queue entry is finished or gone
  // (§7.6). The write is pinned to everything the sweep read, so nothing is
  // finished on stale evidence: the status; the lease, which any claim since
  // has moved on; and the delivery, because a re-drive puts a row back to
  // QUEUED under the same lease, with a newer outbox row of its own.
  abandonStranded(
    jobId: string,
    seen: { status: JobStatus; lease: number; outboxId: bigint },
    error: Prisma.InputJsonValue,
  ) {
    return this.move(
      jobId,
      [seen.status],
      { status: 'DEAD_LETTERED', error, finishedAt: new Date() },
      {
        where: {
          lease: seen.lease,
          outbox: { none: { id: { gt: seen.outboxId } } },
        },
      },
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
    lease: number,
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
          lease,
          ...(reclaim ? {} : monotonic),
        },
      },
    );
  }

  /**
   * Records that the job's owner wants it stopped. One statement for both
   * unfinished states, so a job bouncing between them — a retry moves `RUNNING`
   * back to `QUEUED` — cannot slip between two checks and lose the request.
   *
   * @returns the row as written, or `null` when the job had already finished.
   */
  requestCancel(jobId: string) {
    return this.move(jobId, NOT_FINISHED, { cancelRequested: true });
  }

  /**
   * Finishes a cancellation nobody is running: `QUEUED` only. A `RUNNING` job is
   * never cancelled from outside, because its handler may be mid-effect and only
   * the worker can see when it has reached a point where stopping is safe. Nor
   * is a job whose effect has committed — waiting for a retry after the charge
   * went through, say — which only its handler may finish, as a success.
   */
  cancelQueued(jobId: string) {
    return this.move(
      jobId,
      ['QUEUED'],
      { status: 'CANCELLED', finishedAt: new Date() },
      { where: { cancelRequested: true, effectCommitted: false } },
    );
  }

  /**
   * Finishes a cancellation at delivery, before any handler runs. Reached by a
   * retry scheduled after the request, or by a redelivery after the worker that
   * was running it died — neither should run the handler again.
   *
   * No lease: this delivery has claimed nothing, and an earlier attempt that
   * did is gone or has lost the job. The flag is the guard, and a re-drive
   * clears it, so this cannot cancel a job an operator has just re-driven. A
   * job whose effect has committed is refused: no handler runs here to see it,
   * and the delivery goes on to claim it, where the handler finds the effect
   * and finishes the job as the success it is.
   */
  cancelBeforeClaim(jobId: string) {
    return this.move(
      jobId,
      NOT_FINISHED,
      { status: 'CANCELLED', finishedAt: new Date() },
      { where: { cancelRequested: true, effectCommitted: false } },
    );
  }

  // The worker is shutting down, not failing: the attempt stopped at a safe
  // point, so it is handed back rather than counted against the budget, and
  // the next worker resumes the job from what it committed.
  release(jobId: string, lease: number) {
    return this.move(
      jobId,
      ['RUNNING'],
      { status: 'QUEUED', attempts: { decrement: 1 } },
      { where: { lease } },
    );
  }

  /**
   * The worker's acknowledgement: the handler saw the request at a boundary and
   * stopped. Requires the flag, so a handler that stops without being asked
   * cannot turn a job into `CANCELLED` that its owner never cancelled.
   */
  cancel(jobId: string, lease: number) {
    return this.move(
      jobId,
      ['RUNNING'],
      { status: 'CANCELLED', finishedAt: new Date() },
      { where: { lease, cancelRequested: true } },
    );
  }

  /**
   * Whether this attempt should keep going: it still owns the job and nobody
   * has asked it to stop. A read of the same predicate its next write will
   * carry, kept here so the predicate has one home.
   */
  async isWanted(jobId: string, lease: number) {
    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        status: 'RUNNING',
        lease,
        cancelRequested: false,
      },
      select: { id: true },
    });

    return job !== null;
  }

  /**
   * Runs `work` and records `checkpoint` in one transaction, so a checkpoint
   * never claims work that did not commit, and work never commits without the
   * checkpoint that lets a later attempt skip it.
   *
   * Guarded by the lease like every other write a worker makes: an attempt that
   * lost the job has its work rolled back with the refused checkpoint.
   *
   * @param checkpoint builds the value from what `work` returned.
   * @returns `{ value }` holding what `work` returned, or `null` when this
   * attempt no longer owns the job and nothing was written.
   */
  commitCheckpoint<T>(
    jobId: string,
    lease: number,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    checkpoint: (value: T) => Prisma.InputJsonValue,
  ) {
    return this.commitWith(jobId, lease, work, (value) => ({
      checkpoint: checkpoint(value),
    }));
  }

  /**
   * Runs `work` — the job's one irreversible effect — and marks the job
   * `effectCommitted` in one transaction. The mark is a column of the job row
   * rather than "a ledger row exists" because a cancel waiting on the row's
   * lock re-checks only that row: it would not see the new ledger row, and
   * would cancel a job whose effect it was waiting on.
   *
   * Guarded by the lease: an attempt that lost the job — to a redelivery that
   * cancelled it, say — has its effect rolled back.
   *
   * @returns `{ value }` holding what `work` returned, or `null` when this
   * attempt no longer owns the job and nothing was written.
   * @throws whatever `work` throws, the transaction rolled back.
   */
  commitEffect<T>(
    jobId: string,
    lease: number,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.commitWith(jobId, lease, work, () => ({
      effectCommitted: true,
    }));
  }

  private async commitWith<T>(
    jobId: string,
    lease: number,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    mark: (value: T) => Prisma.JobUpdateManyMutationInput,
  ): Promise<{ value: T } | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const value = await work(tx);

        // Written after the work, not before: the job row stays locked from
        // here to the commit, and a progress write or a cancel request queued
        // behind that lock should wait for one statement, not the whole batch.
        const saved = await this.move(jobId, ['RUNNING'], mark(value), {
          client: tx,
          where: { lease },
        });

        if (!saved) {
          throw new CheckpointRefused();
        }

        return { value };
      });
    } catch (error) {
      if (error instanceof CheckpointRefused) {
        return null;
      }

      throw error;
    }
  }

  /**
   * @param fromStart also clears the checkpoint, so the job does its work again
   * from the beginning instead of resuming (D26).
   */
  redrive(
    jobId: string,
    client?: Prisma.TransactionClient,
    { fromStart = false }: { fromStart?: boolean } = {},
  ) {
    return this.move(
      jobId,
      ['DEAD_LETTERED'],
      fromStart
        ? { ...REDRIVE_RESET, checkpoint: Prisma.DbNull }
        : REDRIVE_RESET,
      { client },
    );
  }

  /**
   * The set form of {@link redrive}, for a bulk re-drive. Takes a transaction
   * rather than offering one, because the caller must write each job's outbox
   * row in the same commit.
   *
   * The status predicate is checked again here rather than trusted from the
   * caller's SELECT: a job someone else re-drove in between is skipped, not
   * re-driven twice — so two overlapping bulk calls cannot enqueue one job
   * twice.
   */
  redriveMany(jobIds: string[], client: Prisma.TransactionClient) {
    return client.job.updateManyAndReturn({
      where: { id: { in: jobIds }, status: 'DEAD_LETTERED' },
      data: REDRIVE_RESET,
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ErrorReportNotFoundError,
  IdempotencyKeyReusedError,
  JobAlreadyFinishedError,
  JobNotCancellableError,
  JobNotDeadLetteredError,
  JobNotFoundError,
  UploadNotFoundError,
} from '../../common/errors/app-error.js';
import { StorageService } from '../../storage/storage.service.js';
import { errorReportKey, uploadPrefix } from '../../storage/object-keys.js';
import { JobTransitionService } from '../engine/job-transition.service.js';
import { JobEventsPublisher } from '../events/job-events.publisher.js';
import { Prisma, type Job } from '../../generated/prisma/client.js';
import {
  jobOptions,
  messageId,
  outboxEntry,
  queueFor,
} from '../delivery/job-queue.js';
import { JobQueues } from '../delivery/job-queues.js';
import type {
  BulkRedriveInput,
  DeadLetterFilter,
  ListDeadLettersQuery,
  ListJobsQuery,
  SubmitJobInput,
} from '../jobs.schema.js';
import type { ApiEnv } from '../../config/env.schema.js';
import { requestHash } from './request-hash.js';
import {
  assertUnderCap,
  isCapped,
  roomLeft,
  withinRoom,
} from './unfinished-caps.js';
import { lockAccount } from '../../prisma/account-lock.js';
import { toPage } from '../../common/pagination/cursor.js';
import { describeError } from '../../common/errors/describe-error.js';

// Fetched when the seller clicks, so a short life costs nothing: a link that
// leaks from a browser history is dead within minutes.
const REPORT_LINK_SECONDS = 300;

// The caller's dead letters matching a filter, for the list and the bulk
// re-drive alike. Every filter is optional on its own; the re-drive's schema
// requires at least one.
const deadLettersMatching = (
  userId: string,
  filter: DeadLetterFilter,
): Prisma.JobWhereInput => {
  const { type, errorCode, deadLetteredFrom, deadLetteredTo } = filter;

  return {
    userId,
    status: 'DEAD_LETTERED',
    ...(type === undefined ? {} : { type }),
    ...(errorCode === undefined
      ? {}
      : { error: { path: ['code'], equals: errorCode } }),
    ...(deadLetteredFrom === undefined && deadLetteredTo === undefined
      ? {}
      : {
          finishedAt: {
            ...(deadLetteredFrom === undefined
              ? {}
              : { gte: deadLetteredFrom }),
            ...(deadLetteredTo === undefined ? {} : { lt: deadLetteredTo }),
          },
        }),
  };
};

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
    private readonly storage: StorageService,
    private readonly queues: JobQueues,
  ) {}

  /**
   * Accepts a job once per `(userId, idempotencyKey)`: the row and its outbox
   * row commit together, then the job is enqueued directly, with the relay as
   * the backstop should that enqueue never happen (§7.2).
   *
   * @returns the job, and whether it is a replay: an earlier request with the
   * same key and body already created it, and nothing new was enqueued.
   * @throws IdempotencyKeyReusedError (422) when the key was first used with a
   * different body.
   * @throws UploadNotFoundError (422) when an `import.csv` names a key that is
   * not one of the caller's uploads, or no longer exists.
   * @throws TooManyUnfinishedJobsError (429) when the caller already has as many
   * unfinished jobs of this type as it may (D32). A replay is answered as one
   * all the same.
   */
  async submit({ userId, idempotencyKey, correlationId, input }: SubmitArgs) {
    await this.checkUpload(userId, idempotencyKey, input);

    const hash = requestHash(input);
    let committed;

    try {
      committed = await this.prisma.$transaction(async (tx) => {
        if (isCapped(input.type)) {
          await lockAccount(tx, userId);
        }

        // Written before the cap is checked, so a replay fails here on the
        // unique key and is answered as one even with the account at its cap.
        const job = await tx.job.create({
          data: {
            userId,
            idempotencyKey,
            requestHash: hash,
            correlationId,
            type: input.type,
            payload: input.payload,
            maxAttempts: input.maxAttempts,
          },
        });

        await assertUnderCap(tx, userId, job.type);

        const outbox = await tx.outbox.create({
          data: outboxEntry(job, correlationId),
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

        // Compared after losing the insert, never checked before it: the
        // unique index already decided which request was first (A1), so this
        // only has to say whether the loser was a retry of it. NULL is a row
        // from before the hash was stored, which can only be replayed.
        if (existing.requestHash !== null && existing.requestHash !== hash) {
          throw new IdempotencyKeyReusedError();
        }

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

    await this.publishNow(job, outboxId, correlationId);

    return { job, replayed: false };
  }

  // A job that names a file must name one of the caller's own that is really
  // there — a client that submits before S3 has answered its upload learns so
  // now, not from a dead letter. A replay of an import already accepted is let
  // through even once its file has expired, so it is answered as the replay it
  // is (D1); a different body under that key is still refused, by the hash.
  private async checkUpload(
    userId: string,
    idempotencyKey: string,
    input: SubmitJobInput,
  ) {
    if (input.type !== 'import.csv') {
      return;
    }

    const { key } = input.payload;

    if (
      key.startsWith(uploadPrefix(userId)) &&
      (await this.storage.exists(key))
    ) {
      return;
    }

    const accepted = await this.prisma.job.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: { id: true },
    });

    if (!accepted) {
      throw new UploadNotFoundError();
    }
  }

  /**
   * The direct path (§4.5): enqueues a job whose outbox row has just
   * committed, at once rather than on the relay's next tick. Should anything
   * here fail, the row stays unpublished and the relay delivers it instead.
   */
  async publishNow(job: Job, outboxId: bigint, correlationId: string) {
    await this.queues
      .named(queueFor(job.type))
      .add(
        job.type,
        { jobId: job.id, correlationId },
        jobOptions(job.id, outboxId, job.maxAttempts),
      );

    this.logger.log(`Enqueued job ${job.id} (${job.type})`);

    // `publishedAt: null` in the filter: the relay may have published this
    // row in the meantime, and its stamp is the one to keep.
    await this.prisma.outbox.updateMany({
      where: { id: outboxId, publishedAt: null },
      data: { publishedAt: new Date() },
    });

    await this.events.jobUpdated(job);
  }

  /**
   * Gives a dead-lettered job a fresh retry budget and a new delivery.
   *
   * @param fromStart discards the job's checkpoint, so it does its work again
   * from the beginning; by default it resumes where it got to (D26).
   * @throws JobNotFoundError (404) when the job does not exist or is another
   * tenant's.
   * @throws JobNotDeadLetteredError (409) when the job is not dead-lettered.
   * @throws TooManyUnfinishedJobsError (429) when the caller already has as many
   * unfinished jobs of its type as it may (D32).
   */
  async redrive(
    userId: string,
    jobId: string,
    correlationId: string,
    { fromStart = false }: { fromStart?: boolean } = {},
  ) {
    const existing = await this.findOne(userId, jobId);

    const requeued = await this.prisma.$transaction(async (tx) => {
      if (isCapped(existing.type)) {
        await lockAccount(tx, userId);
      }

      const job = await this.transitions.redrive(existing.id, tx, {
        fromStart,
      });

      if (!job) {
        return null;
      }

      await assertUnderCap(tx, userId, job.type);

      const outbox = await tx.outbox.create({
        data: outboxEntry(job, correlationId),
      });

      return { job, outboxId: outbox.id };
    });

    if (!requeued) {
      throw new JobNotDeadLetteredError();
    }

    const { job, outboxId } = requeued;

    await this.publishNow(job, outboxId, correlationId);

    return job;
  }

  /**
   * Re-drives the caller's dead letters that match a filter, one bounded batch
   * per call.
   *
   * Nothing is enqueued here. Each job's outbox row is written in the same
   * transaction as its status change, and the relay publishes it — so a crash
   * after the commit loses nothing, and the relay's steady pace turns thousands
   * of re-driven jobs into a ramp rather than one burst against a downstream
   * that has only just recovered.
   *
   * Not idempotent per call, by design: a repeated call continues with the next
   * batch. It can never re-drive the same dead letter twice, because the update
   * re-checks the status — but a re-driven job that dies again is a new dead
   * letter, and with no `deadLetteredTo` it matches again.
   *
   * Capped types come back only as far as the caller's caps have room (D32),
   * so a call can re-drive fewer than `limit` while more still match: the rest
   * stay dead-lettered, counted in `remaining`, for a call made once some of
   * the caller's jobs have finished.
   *
   * @returns how many this call re-drove, and how many still match — call
   * again until `remaining` is 0, with `deadLetteredTo` set to when the loop
   * started so it works through a fixed set. With `dryRun`, nothing changes and
   * `remaining` is how many a real call would work through.
   */
  async redriveMatching(
    userId: string,
    filter: BulkRedriveInput,
    correlationId: string,
  ) {
    const where = deadLettersMatching(userId, filter);

    if (filter.dryRun) {
      return { redriven: 0, remaining: await this.prisma.job.count({ where }) };
    }

    const redriven = await this.prisma.$transaction(async (tx) => {
      await lockAccount(tx, userId);

      const room = await roomLeft(tx, userId);
      // Left out of the query, not only out of the batch: a backlog of
      // imports at their cap would otherwise fill every batch, and the dead
      // letters behind them would never be reached.
      const full = [...room]
        .filter(([, left]) => left <= 0)
        .map(([type]) => type);

      // Oldest first, so repeated calls work through a backlog in the order
      // it died — and in the dead-letter list's order, the id breaking ties,
      // so the list shows them in the order they are taken.
      const batch = await tx.job.findMany({
        where: { AND: [where, { type: { notIn: full } }] },
        orderBy: [{ finishedAt: 'asc' }, { id: 'asc' }],
        take: filter.limit,
        select: { id: true, type: true },
      });
      const fits = withinRoom(batch, room);

      if (fits.length === 0) {
        return [];
      }

      const jobs = await this.transitions.redriveMany(
        fits.map(({ id }) => id),
        tx,
      );

      await tx.outbox.createMany({
        data: jobs.map((job) => outboxEntry(job, correlationId)),
      });

      return jobs;
    });

    // After the commit, never inside it (§9.2a). Concurrently, because these
    // are different jobs and the order between them carries no meaning.
    await Promise.all(redriven.map((job) => this.events.jobUpdated(job)));

    return {
      redriven: redriven.length,
      remaining: await this.prisma.job.count({ where }),
    };
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
   * @throws JobNotCancellableError for a pipeline's `pipeline.finalize`.
   */
  async cancel(userId: string, jobId: string) {
    const existing = await this.findOne(userId, jobId);

    // Asked before the flag, which would be refused for it too, so the caller
    // learns why rather than reading "already finished" about a queued job.
    if (existing.type === 'pipeline.finalize') {
      throw new JobNotCancellableError();
    }

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

      // A worker claimed it between the two writes, or its effect has already
      // committed and only its handler may finish it (§5.2). Either way the
      // request is not lost — a handler sees the flag at its first boundary —
      // but the row just written is stale, and emitting it could arrive after
      // the worker's RUNNING event and walk a client's view backwards.
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
      select: { id: true, queue: true },
    });

    if (!outbox) {
      return;
    }

    try {
      await this.queues.named(outbox.queue).remove(messageId(jobId, outbox.id));
    } catch (error) {
      this.logger.warn(
        `Could not remove cancelled job ${jobId} from the queue: ${describeError(error)}`,
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

  /**
   * A link that downloads an import's error report, signed on each call rather
   * than stored, so the link a client holds is never one that has expired.
   *
   * @throws JobNotFoundError when the job is not the caller's.
   * @throws ErrorReportNotFoundError when the job has none: it has not
   * succeeded, every row was valid, or the bucket has expired the report.
   */
  async errorReportLink(userId: string, jobId: string) {
    const job = await this.findOne(userId, jobId);
    const key = errorReportKey(userId, job.id);

    // Only a finished import's: a report left by an earlier life of a job
    // that is running again describes a run that is being redone.
    if (
      job.type !== 'import.csv' ||
      job.status !== 'SUCCEEDED' ||
      !(await this.storage.exists(key))
    ) {
      throw new ErrorReportNotFoundError();
    }

    return this.storage.signDownload(key, REPORT_LINK_SECONDS);
  }

  /**
   * The caller's jobs, newest first, one page per call (D14).
   *
   * A page starts after the cursor's values rather than at an offset, so a job
   * submitted mid-scroll lands before the first page instead of pushing one
   * already shown onto the next, and a deep page costs what the first does.
   * The cursor carries values, not a reference to a row: a row the caller is
   * paging past may have left the filter since — a QUEUED job that started —
   * and its position must still mean the same thing.
   */
  async findMany(
    userId: string,
    { status, type, limit, cursor }: ListJobsQuery,
  ) {
    const rows = await this.prisma.job.findMany({
      where: {
        userId,
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
        // Strictly after the cursor in (createdAt, id) order — the id breaks
        // ties, which a millisecond clock makes common.
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return toPage(rows, limit, (job) => ({
      createdAt: job.createdAt.toISOString(),
      id: job.id,
    }));
  }

  /**
   * The caller's dead letters matching a filter, oldest-dead first, one page
   * per call (D11, D14).
   *
   * The filter and the order are `POST /jobs/retry`'s, so this is what a
   * re-drive with the same filter works through, in the order it does. The
   * re-drive's batch is its first `limit` once types at their cap are left
   * out, and of a type with some room only as many as fit (D32).
   *
   * A scroll is not a snapshot: a job is stamped dead before its write
   * commits, and can land behind a cursor already past it. To page through a
   * fixed set, set `deadLetteredTo` a few seconds in the past.
   */
  async findDeadLetters(
    userId: string,
    { limit, cursor, ...filter }: ListDeadLettersQuery,
  ) {
    const rows = await this.prisma.job.findMany({
      where: {
        AND: [
          deadLettersMatching(userId, filter),
          // Strictly after the cursor in (finishedAt, id) order.
          cursor
            ? {
                OR: [
                  { finishedAt: { gt: cursor.finishedAt } },
                  { finishedAt: cursor.finishedAt, id: { gt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ finishedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    return toPage(rows, limit, (job) => ({
      // A CHECK gives every finished job a finishedAt, and the list holds only
      // dead letters.
      finishedAt: (job.finishedAt as Date).toISOString(),
      id: job.id,
    }));
  }
}

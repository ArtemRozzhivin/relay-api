import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ErrorReportNotFoundError,
  IdempotencyKeyReusedError,
  JobAlreadyFinishedError,
  JobNotDeadLetteredError,
  JobNotFoundError,
  UploadNotFoundError,
} from '../common/errors/app-error.js';
import { StorageService } from '../storage/storage.service.js';
import { errorReportKey, uploadPrefix } from '../storage/object-keys.js';
import { JobTransitionService } from './job-transition.service.js';
import { JobEventsPublisher } from './job-events.publisher.js';
import { Prisma, type Job } from '../generated/prisma/client.js';
import {
  JOBS_QUEUE,
  jobOptions,
  messageId,
  type JobMessage,
  type OutboxMessage,
} from './job-queue.js';
import type {
  BulkRedriveInput,
  ListJobsQuery,
  SubmitJobInput,
} from './jobs.schema.js';
import type { ApiEnv } from '../config/env.schema.js';
import { requestHash } from './request-hash.js';
import { toPage } from '../common/pagination/cursor.js';
import { describeError } from '../common/errors/describe-error.js';

// Fetched when the seller clicks, so a short life costs nothing: a link that
// leaks from a browser history is dead within minutes.
const REPORT_LINK_SECONDS = 300;

// One shape for every message the outbox carries — submit, re-drive and bulk
// re-drive alike — so the relay and the direct path publish the same thing
// however a job reached the queue.
const outboxEntry = (job: Job, correlationId: string) => ({
  jobId: job.id,
  queue: JOBS_QUEUE,
  jobName: job.type,
  payload: {
    jobId: job.id,
    correlationId,
    maxAttempts: job.maxAttempts,
  } satisfies OutboxMessage,
});

// The caller's dead letters matching a bulk re-drive filter. Every filter is
// optional on its own; the schema requires at least one.
const deadLettersMatching = (
  userId: string,
  filter: BulkRedriveInput,
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
    @InjectQueue(JOBS_QUEUE) private readonly queue: Queue<JobMessage>,
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
   */
  async submit({ userId, idempotencyKey, correlationId, input }: SubmitArgs) {
    await this.checkUpload(userId, idempotencyKey, input);

    const hash = requestHash(input);
    let committed;

    try {
      committed = await this.prisma.$transaction(async (tx) => {
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

  // The direct path (§4.5): enqueued at once rather than on the relay's next
  // tick. Should anything here fail, the outbox row stays unpublished and the
  // relay delivers it instead.
  private async publishNow(job: Job, outboxId: bigint, correlationId: string) {
    await this.queue.add(
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
   */
  async redrive(
    userId: string,
    jobId: string,
    correlationId: string,
    { fromStart = false }: { fromStart?: boolean } = {},
  ) {
    const existing = await this.findOne(userId, jobId);

    const requeued = await this.prisma.$transaction(async (tx) => {
      const job = await this.transitions.redrive(existing.id, tx, {
        fromStart,
      });

      if (!job) {
        return null;
      }

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
      // Oldest first, so repeated calls work through a backlog in the order
      // it died.
      const batch = await tx.job.findMany({
        where,
        orderBy: { finishedAt: 'asc' },
        take: filter.limit,
        select: { id: true },
      });

      if (batch.length === 0) {
        return [];
      }

      const jobs = await this.transitions.redriveMany(
        batch.map(({ id }) => id),
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
      select: { id: true },
    });

    if (!outbox) {
      return;
    }

    try {
      await this.queue.remove(messageId(jobId, outbox.id));
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
}

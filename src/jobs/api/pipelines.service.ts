import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Prisma, type Pipeline } from '../../generated/prisma/client.js';
import type { JobStatus } from '../../generated/prisma/enums.js';
import {
  IdempotencyKeyReusedError,
  PipelineNotFoundError,
  TooManyRunningPipelinesError,
  UploadNotFoundError,
} from '../../common/errors/app-error.js';
import { StorageService } from '../../storage/storage.service.js';
import { uploadPrefix } from '../../storage/object-keys.js';
import { lockAccount } from '../../prisma/account-lock.js';
import { outboxEntry } from '../delivery/job-queue.js';
import { pipelineKey } from '../engine/pipeline-keys.js';
import type { StartPipelineInput } from '../jobs.schema.js';
import { JobsService } from './jobs.service.js';
import { requestHash } from './request-hash.js';
import { assertUnderCap } from './unfinished-caps.js';

interface StartArgs {
  userId: string;
  idempotencyKey: string;
  correlationId: string;
  input: StartPipelineInput;
}

@Injectable()
export class PipelinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
  ) {}

  /**
   * Starts a pipeline once per `(userId, idempotencyKey)`: the pipeline, its
   * import and the import's outbox row commit together, then the import is
   * enqueued directly, as a submitted job is (§6.3e).
   *
   * @returns the pipeline as a client sees it, and whether it is a replay.
   * @throws IdempotencyKeyReusedError (422) when the key was first used with a
   * different body.
   * @throws UploadNotFoundError (422) when the key names no upload of the
   * caller's that still exists.
   * @throws TooManyUnfinishedJobsError (429) when the caller already has as many
   * unfinished imports as it may (D32). A replay is answered as one all the
   * same.
   * @throws TooManyRunningPipelinesError (429) when another of the caller's
   * pipelines is still running.
   */
  async start({ userId, idempotencyKey, correlationId, input }: StartArgs) {
    await this.checkUpload(userId, idempotencyKey, input.key);

    const hash = requestHash(input);
    let committed;

    try {
      committed = await this.prisma.$transaction(async (tx) => {
        await lockAccount(tx, userId);

        // First, so a replay fails here on the unique key and is answered as
        // one even with the account at its import cap.
        const pipeline = await tx.pipeline.create({
          data: { userId, idempotencyKey, requestHash: hash, correlationId },
        });

        const job = await tx.job.create({
          data: {
            userId,
            idempotencyKey: pipelineKey(pipeline.id, 'import'),
            correlationId,
            type: 'import.csv',
            payload: { key: input.key },
            pipelineId: pipeline.id,
            // The place the pipeline's counter starts with.
            pendingInPipeline: true,
          },
        });

        await assertUnderCap(tx, userId, job.type);

        // One at a time (D32): its batches count against no cap, so the
        // pipeline as a whole is what is limited. Counted after the write, as
        // the caps are, so the count includes this one.
        const running = await tx.pipeline.count({
          where: { userId, status: 'RUNNING' },
        });

        if (running > 1) {
          throw new TooManyRunningPipelinesError();
        }

        const outbox = await tx.outbox.create({
          data: outboxEntry(job, correlationId),
        });

        return { pipeline, job, outboxId: outbox.id };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.pipeline.findUniqueOrThrow({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });

        // As for a submit: the unique index decided which request was first,
        // and this only says whether the loser was a retry of it (D28).
        if (existing.requestHash !== hash) {
          throw new IdempotencyKeyReusedError();
        }

        return { pipeline: await this.describe(existing), replayed: true };
      }

      throw error;
    }

    const { pipeline, job, outboxId } = committed;

    // Read before the enqueue, so the answer is what this request committed,
    // as a submit's is, whatever a worker does with the import meanwhile.
    const started = await this.describe(pipeline);

    await this.jobs.publishNow(job, outboxId, correlationId);

    return { pipeline: started, replayed: false };
  }

  /**
   * @throws PipelineNotFoundError (404) when the pipeline does not exist or is
   * another tenant's.
   */
  async findOne(userId: string, id: string) {
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id, userId },
    });

    if (!pipeline) {
      throw new PipelineNotFoundError();
    }

    return this.describe(pipeline);
  }

  // As submit() checks an import's upload, and lets a replay through once the
  // file has expired; the replay is looked for among pipelines, not jobs.
  private async checkUpload(
    userId: string,
    idempotencyKey: string,
    key: string,
  ) {
    if (
      key.startsWith(uploadPrefix(userId)) &&
      (await this.storage.exists(key))
    ) {
      return;
    }

    const accepted = await this.prisma.pipeline.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: { id: true },
    });

    if (!accepted) {
      throw new UploadNotFoundError();
    }
  }

  // What a client sees: how many of the pipeline's jobs of each type are in
  // each status, which is how it follows a run and finds a failed batch. The
  // fingerprint and the counters are not part of it: the counters count first
  // outcomes, which a re-drive leaves behind, and would read as a contradiction
  // of the statuses beside them. Nor is the fan-out's moment, which the status
  // already says all a client needs of.
  private async describe({
    requestHash: _requestHash,
    pendingChildren: _pendingChildren,
    failedChildren: _failedChildren,
    fannedOutAt: _fannedOutAt,
    ...pipeline
  }: Pipeline) {
    const [importJob, counted] = await Promise.all([
      this.prisma.job.findUniqueOrThrow({
        where: {
          userId_idempotencyKey: {
            userId: pipeline.userId,
            idempotencyKey: pipelineKey(pipeline.id, 'import'),
          },
        },
        select: { id: true },
      }),
      this.prisma.job.groupBy({
        by: ['type', 'status'],
        where: { pipelineId: pipeline.id },
        _count: { _all: true },
      }),
    ]);

    const jobs: Record<string, Partial<Record<JobStatus, number>>> = {};

    for (const { type, status, _count } of counted) {
      jobs[type] = { ...jobs[type], [status]: _count._all };
    }

    return { ...pipeline, importJobId: importJob.id, jobs };
  }
}

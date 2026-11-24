import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { PipelineFinalizeJobHandler } from '../../src/jobs/handlers/pipeline-finalize/pipeline-finalize.handler.js';
import { recordingContext } from '../../src/jobs/engine/job-context.fixture.js';
import { pipelineKey } from '../../src/jobs/engine/pipeline-keys.js';
import { TerminalJobError } from '../../src/common/errors/app-error.js';
import type { JobStatus } from '../../src/generated/prisma/enums.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
  seedJob,
  seedPipeline,
} from '../support/db.js';

const IMPORTED = { rows: 3, imported: 3, invalid: 0, invalidSamples: [] };

// The pipeline's last job (§6.3e): it reads what every other job of the
// pipeline did, and writes the pipeline's status and summary once.
describe('the pipeline.finalize handler', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let handler: PipelineFinalizeJobHandler;
  const users: string[] = [];

  // A pipeline whose every job has finished: its import, then one batch per
  // status given, `failedChildren` the failures among them.
  const finished = async ({
    importStatus = 'SUCCEEDED',
    batches = [],
    failedChildren,
  }: {
    importStatus?: JobStatus;
    batches?: JobStatus[];
    failedChildren?: number;
  } = {}) => {
    const userId = await createThrowawayUser(prisma, 'finalize');

    users.push(userId);

    const failures = [importStatus, ...batches].filter(
      (status) => status !== 'SUCCEEDED',
    ).length;
    const pipeline = await seedPipeline(prisma, {
      userId,
      pendingChildren: 0,
      failedChildren: failedChildren ?? failures,
    });

    await seedJob(prisma, {
      userId,
      type: 'import.csv',
      idempotencyKey: pipelineKey(pipeline.id, 'import'),
      pipelineId: pipeline.id,
      status: importStatus,
      result: importStatus === 'SUCCEEDED' ? IMPORTED : undefined,
    });

    for (const status of batches) {
      await seedJob(prisma, {
        userId,
        type: 'ai.enrich',
        pipelineId: pipeline.id,
        status,
        result: status === 'SUCCEEDED' ? { enriched: 2, failed: 1 } : undefined,
      });
    }

    return { userId, pipelineId: pipeline.id };
  };

  const finalize = (userId: string, pipelineId: string) => {
    const recorded = recordingContext({ userId });

    return {
      ...recorded,
      result: handler.run(recorded.context, { pipelineId }),
    };
  };

  const pipelineOf = (id: string) =>
    prisma.pipeline.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    moduleRef = await createTestModule({
      imports: [PrismaModule],
      providers: [PipelineFinalizeJobHandler],
    });
    prisma = moduleRef.get(PrismaService);
    handler = moduleRef.get(PipelineFinalizeJobHandler);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await moduleRef?.close();
  });

  it('finishes a pipeline whose every job succeeded as COMPLETED, with its summary', async () => {
    const { userId, pipelineId } = await finished({
      batches: ['SUCCEEDED', 'SUCCEEDED'],
    });

    const summary = {
      import: { rows: 3, imported: 3, invalid: 0 },
      enrich: { batches: 2, failedBatches: 0, enriched: 4, failed: 2 },
      images: { batches: 0, failedBatches: 0, processed: 0, failed: 0 },
    };

    expect(await finalize(userId, pipelineId).result).toEqual({
      pipelineId,
      status: 'COMPLETED',
      summary,
    });
    expect(await pipelineOf(pipelineId)).toMatchObject({
      status: 'COMPLETED',
      summary,
      finishedAt: expect.any(Date),
    });
  });

  it('finishes one whose batch did not succeed as COMPLETED_WITH_ERRORS', async () => {
    const { userId, pipelineId } = await finished({
      batches: ['SUCCEEDED', 'DEAD_LETTERED'],
    });

    await finalize(userId, pipelineId).result;

    expect(await pipelineOf(pipelineId)).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      summary: {
        enrich: { batches: 2, failedBatches: 1, enriched: 2, failed: 1 },
      },
    });
  });

  // The counter counted the batch's first finish, a failure; a re-drive that
  // succeeded since does not make the run one without errors.
  it('finishes one whose batch failed, then succeeded on a re-drive, as COMPLETED_WITH_ERRORS', async () => {
    const { userId, pipelineId } = await finished({
      batches: ['SUCCEEDED'],
      failedChildren: 1,
    });

    await finalize(userId, pipelineId).result;

    expect(await pipelineOf(pipelineId)).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      summary: { enrich: { batches: 1, failedBatches: 0 } },
    });
  });

  it('finishes one whose import did not succeed as FAILED', async () => {
    const { userId, pipelineId } = await finished({
      importStatus: 'DEAD_LETTERED',
    });

    await finalize(userId, pipelineId).result;

    expect(await pipelineOf(pipelineId)).toMatchObject({
      status: 'FAILED',
      summary: { import: null },
    });
  });

  it('changes nothing when it runs again', async () => {
    const { userId, pipelineId } = await finished({ batches: ['SUCCEEDED'] });

    await finalize(userId, pipelineId).result;

    const first = await pipelineOf(pipelineId);

    // A batch re-driven and finished since does not rewrite the summary.
    await prisma.job.updateMany({
      where: { pipelineId, type: 'ai.enrich' },
      data: { result: { enriched: 99, failed: 0 } },
    });

    const again = finalize(userId, pipelineId);

    expect(await again.result).toEqual({
      pipelineId,
      status: 'COMPLETED',
      summary: first.summary,
    });
    expect(await pipelineOf(pipelineId)).toEqual(first);
    expect(again.lines).toContain(
      'found its pipeline already finished; changed nothing',
    );
  });

  it("refuses another account's pipeline, changing nothing", async () => {
    const { pipelineId } = await finished();
    const stranger = await createThrowawayUser(prisma, 'finalize');

    users.push(stranger);

    await expect(finalize(stranger, pipelineId).result).rejects.toBeInstanceOf(
      TerminalJobError,
    );
    expect(await pipelineOf(pipelineId)).toMatchObject({ status: 'RUNNING' });
  });
});

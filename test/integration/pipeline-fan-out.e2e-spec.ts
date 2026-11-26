import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { JobTransitionService } from '../../src/jobs/engine/job-transition.service.js';
import type { PipelineBatch } from '../../src/jobs/engine/job-context.js';
import { pipelineKey } from '../../src/jobs/engine/pipeline-keys.js';
import type { JobStatus } from '../../src/generated/prisma/enums.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
  seedJob,
  seedPipeline,
} from '../support/db.js';

const enrich = (...skus: string[]): PipelineBatch => ({
  stage: 'enrich',
  type: 'ai.enrich',
  payload: { skus },
});

const images = (...skus: string[]): PipelineBatch => ({
  stage: 'images',
  type: 'image.process',
  payload: { skus },
});

// The one transaction that writes a pipeline's batches (§6.3e): each a job
// under a key the server mints, with its outbox row, and the counter raised by
// as many — and nothing twice, whoever runs it again.
describe("a pipeline's fan-out", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transitions: JobTransitionService;
  const users: string[] = [];

  // A pipeline whose import is running on attempt 1, under lease 1.
  const importing = async (
    job: {
      status?: JobStatus;
      pendingInPipeline?: boolean;
      cancelRequested?: boolean;
    } = {},
  ) => {
    const userId = await createThrowawayUser(prisma, 'fan-out');

    users.push(userId);

    const pipeline = await seedPipeline(prisma, { userId });
    const importJob = await seedJob(prisma, {
      userId,
      type: 'import.csv',
      idempotencyKey: pipelineKey(pipeline.id, 'import'),
      correlationId: 'the-request',
      pipelineId: pipeline.id,
      pendingInPipeline: true,
      status: 'RUNNING',
      attempts: 1,
      ...job,
    });

    return { userId, pipelineId: pipeline.id, importJobId: importJob.id };
  };

  const batchesOf = (pipelineId: string) =>
    prisma.job.findMany({
      where: { pipelineId, type: { not: 'import.csv' } },
      include: { outbox: true },
      orderBy: { idempotencyKey: 'asc' },
    });

  const pendingOf = async (pipelineId: string) =>
    (await prisma.pipeline.findUniqueOrThrow({ where: { id: pipelineId } }))
      .pendingChildren;

  const fannedOutAt = async (pipelineId: string) =>
    (await prisma.pipeline.findUniqueOrThrow({ where: { id: pipelineId } }))
      .fannedOutAt;

  beforeAll(async () => {
    moduleRef = await createTestModule({
      imports: [PrismaModule],
      providers: [JobTransitionService],
    });
    prisma = moduleRef.get(PrismaService);
    transitions = moduleRef.get(JobTransitionService);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await moduleRef?.close();
  });

  it('writes each batch as a job of the pipeline, with its outbox row, and raises the counter', async () => {
    const { userId, pipelineId, importJobId } = await importing();

    await expect(
      transitions.fanOut(importJobId, 1, [
        enrich('A', 'B'),
        images('A'),
        enrich('C'),
      ]),
    ).resolves.toEqual({ holding: true, written: 3 });

    const batches = await batchesOf(pipelineId);

    expect(
      batches.map((job) => ({
        key: job.idempotencyKey,
        type: job.type,
        payload: job.payload,
        status: job.status,
        userId: job.userId,
        correlationId: job.correlationId,
        pendingInPipeline: job.pendingInPipeline,
        queues: job.outbox.map(({ queue }) => queue),
      })),
    ).toEqual([
      {
        key: pipelineKey(pipelineId, 'enrich', 0),
        type: 'ai.enrich',
        payload: { skus: ['A', 'B'] },
        status: 'QUEUED',
        userId,
        correlationId: 'the-request',
        pendingInPipeline: true,
        queues: ['relay-ai'],
      },
      {
        key: pipelineKey(pipelineId, 'enrich', 1),
        type: 'ai.enrich',
        payload: { skus: ['C'] },
        status: 'QUEUED',
        userId,
        correlationId: 'the-request',
        pendingInPipeline: true,
        queues: ['relay-ai'],
      },
      {
        key: pipelineKey(pipelineId, 'images', 0),
        type: 'image.process',
        payload: { skus: ['A'] },
        status: 'QUEUED',
        userId,
        correlationId: 'the-request',
        pendingInPipeline: true,
        queues: ['relay-jobs'],
      },
    ]);
    // The import's own place, and one for each batch.
    expect(await pendingOf(pipelineId)).toBe(4);
  });

  it('writes nothing twice when it runs again', async () => {
    const { pipelineId, importJobId } = await importing();
    const all = [enrich('A'), enrich('B'), images('A')];

    await transitions.fanOut(importJobId, 1, all);

    await expect(transitions.fanOut(importJobId, 1, all)).resolves.toEqual({
      holding: true,
      written: 0,
    });

    const batches = await batchesOf(pipelineId);

    expect(batches).toHaveLength(3);
    expect(batches.flatMap(({ outbox }) => outbox)).toHaveLength(3);
    expect(await pendingOf(pipelineId)).toBe(4);
  });

  it('writes, and counts, only the batches an earlier run did not', async () => {
    const { pipelineId, importJobId } = await importing();

    await transitions.fanOut(importJobId, 1, [enrich('A')]);

    await expect(
      transitions.fanOut(importJobId, 1, [enrich('A'), enrich('B')]),
    ).resolves.toEqual({ holding: true, written: 1 });

    const batches = await batchesOf(pipelineId);

    expect(batches.map(({ payload }) => payload)).toEqual([
      { skus: ['A'] },
      { skus: ['B'] },
    ]);
    // One delivery each: the batch the first run wrote is not sent again.
    expect(batches.map(({ outbox }) => outbox.length)).toEqual([1, 1]);
    expect(await pendingOf(pipelineId)).toBe(3);
  });

  it.each([
    ['a lease another attempt has moved on from', 0, {}],
    ['a job that has finished', 1, { status: 'SUCCEEDED' as const }],
  ])('writes nothing for %s', async (_what, lease, job) => {
    const { pipelineId, importJobId } = await importing(job);

    await expect(
      transitions.fanOut(importJobId, lease, [enrich('A')]),
    ).resolves.toBeNull();
    expect(await batchesOf(pipelineId)).toEqual([]);
    expect(await pendingOf(pipelineId)).toBe(1);
  });

  it('writes nothing for a job that holds no place in its pipeline', async () => {
    const { pipelineId, importJobId } = await importing({
      pendingInPipeline: false,
    });

    await expect(
      transitions.fanOut(importJobId, 1, [enrich('A')]),
    ).resolves.toEqual({ holding: false, written: 0 });
    expect(await batchesOf(pipelineId)).toEqual([]);
    expect(await pendingOf(pipelineId)).toBe(1);
    expect(await fannedOutAt(pipelineId)).toBeNull();
  });

  // How the pipeline ends turns on it (§6.3e): written means not FAILED.
  it('marks the pipeline fanned out once, even when no product needed a batch', async () => {
    const { pipelineId, importJobId } = await importing();

    await transitions.fanOut(importJobId, 1, []);

    const first = await fannedOutAt(pipelineId);

    expect(first).toBeInstanceOf(Date);

    await transitions.fanOut(importJobId, 1, [enrich('A')]);

    expect(await fannedOutAt(pipelineId)).toEqual(first);
  });

  // The last point at which a cancel leaves nothing behind: past it, a whole
  // pipeline of batches would run for an import its owner stopped.
  it('writes nothing once its owner has asked the import to stop', async () => {
    const { pipelineId, importJobId } = await importing({
      cancelRequested: true,
    });

    await expect(
      transitions.fanOut(importJobId, 1, [enrich('A'), images('A')]),
    ).resolves.toBeNull();
    expect(await batchesOf(pipelineId)).toEqual([]);
    expect(await pendingOf(pipelineId)).toBe(1);
    expect(await fannedOutAt(pipelineId)).toBeNull();
  });
});

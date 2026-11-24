import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { JobTransitionService } from '../../src/jobs/engine/job-transition.service.js';
import { pipelineKey } from '../../src/jobs/engine/pipeline-keys.js';
import type { DeadLetterError } from '../../src/jobs/engine/job-error-codes.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
  seedJob,
  seedPipeline,
} from '../support/db.js';

const DIED: DeadLetterError = {
  code: 'TERMINAL_FAILURE',
  message: 'it died',
  attempt: 1,
};

// The counter that decides when a pipeline is finished (D24): each job takes
// its place off it in the commit of its first finish, and the commit that
// takes it to zero writes the pipeline's finalize job.
describe("a pipeline's counter", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transitions: JobTransitionService;
  const users: string[] = [];

  // A pipeline waiting on `count` running batches, each on attempt 1 under
  // lease 1 and holding its place.
  const waitingOn = async (count: number) => {
    const userId = await createThrowawayUser(prisma, 'counter');

    users.push(userId);

    const pipeline = await seedPipeline(prisma, {
      userId,
      correlationId: 'the-request',
      pendingChildren: count,
    });
    const jobs = [];

    for (let index = 0; index < count; index += 1) {
      jobs.push(
        await seedJob(prisma, {
          userId,
          type: 'ai.enrich',
          pipelineId: pipeline.id,
          pendingInPipeline: true,
          status: 'RUNNING',
          attempts: 1,
        }),
      );
    }

    return { userId, pipelineId: pipeline.id, jobs };
  };

  const pipelineOf = (id: string) =>
    prisma.pipeline.findUniqueOrThrow({ where: { id } });

  const finalizeJobsOf = (pipelineId: string) =>
    prisma.job.findMany({
      where: { pipelineId, type: 'pipeline.finalize' },
      include: { outbox: true },
    });

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

  it('takes a job that succeeded off the counter, as no failure', async () => {
    const { pipelineId, jobs } = await waitingOn(2);

    const finished = await transitions.succeed(jobs[0]!.id, 1, {});

    expect(finished).toMatchObject({
      status: 'SUCCEEDED',
      pendingInPipeline: false,
    });
    expect(await pipelineOf(pipelineId)).toMatchObject({
      pendingChildren: 1,
      failedChildren: 0,
    });
    expect(await finalizeJobsOf(pipelineId)).toEqual([]);
  });

  it.each([
    [
      'dead-lettered',
      (t: JobTransitionService, id: string) => t.deadLetter(id, 1, DIED),
    ],
    [
      'abandoned by the queue',
      (t: JobTransitionService, id: string) => t.abandon(id, DIED),
    ],
  ])('takes a job %s off the counter, as a failure', async (_how, finish) => {
    const { pipelineId, jobs } = await waitingOn(2);

    expect(await finish(transitions, jobs[0]!.id)).toMatchObject({
      status: 'DEAD_LETTERED',
    });
    expect(await pipelineOf(pipelineId)).toMatchObject({
      pendingChildren: 1,
      failedChildren: 1,
    });
  });

  it('takes a job its owner cancelled off the counter, as a failure', async () => {
    const { pipelineId, jobs } = await waitingOn(2);

    await prisma.job.update({
      where: { id: jobs[0]!.id },
      data: { status: 'QUEUED', cancelRequested: true },
    });

    expect(await transitions.cancelQueued(jobs[0]!.id)).toMatchObject({
      status: 'CANCELLED',
    });
    expect(await pipelineOf(pipelineId)).toMatchObject({
      pendingChildren: 1,
      failedChildren: 1,
    });
  });

  it("writes the pipeline's finalize job, and its outbox row, in the finish that reaches zero", async () => {
    const { userId, pipelineId, jobs } = await waitingOn(2);

    await transitions.succeed(jobs[0]!.id, 1, {});
    await transitions.deadLetter(jobs[1]!.id, 1, DIED);

    expect(await pipelineOf(pipelineId)).toMatchObject({
      pendingChildren: 0,
      failedChildren: 1,
      // Finalize decides the status; the counter only says it is due.
      status: 'RUNNING',
    });

    const [finalize, ...more] = await finalizeJobsOf(pipelineId);

    expect(more).toEqual([]);
    expect(finalize).toMatchObject({
      userId,
      type: 'pipeline.finalize',
      payload: { pipelineId },
      idempotencyKey: pipelineKey(pipelineId, 'finalize'),
      correlationId: 'the-request',
      status: 'QUEUED',
      pendingInPipeline: false,
    });
    expect(finalize!.outbox).toMatchObject([
      { queue: 'relay-jobs', jobName: 'pipeline.finalize', publishedAt: null },
    ]);
  });

  it('counts a job once: its finish after a re-drive takes nothing off', async () => {
    const { pipelineId, jobs } = await waitingOn(2);
    const job = jobs[0]!;

    await transitions.deadLetter(job.id, 1, DIED);
    await transitions.redrive(job.id);

    const { lease } = (await transitions.claim(job.id))!;

    expect(await transitions.succeed(job.id, lease, {})).toMatchObject({
      status: 'SUCCEEDED',
    });
    expect(await pipelineOf(pipelineId)).toMatchObject({
      pendingChildren: 1,
      failedChildren: 1,
    });
  });

  it('takes nothing off for a finish that was refused', async () => {
    const { pipelineId, jobs } = await waitingOn(1);

    // A lease another attempt has moved on from.
    expect(await transitions.succeed(jobs[0]!.id, 0, {})).toBeNull();
    expect(await pipelineOf(pipelineId)).toMatchObject({ pendingChildren: 1 });
    expect(await finalizeJobsOf(pipelineId)).toEqual([]);
  });

  it('writes one finalize job when the last jobs finish at the same moment', async () => {
    const { pipelineId, jobs } = await waitingOn(10);

    const finished = await Promise.all(
      jobs.map((job) => transitions.succeed(job.id, 1, {})),
    );

    expect(finished.every((job) => job?.status === 'SUCCEEDED')).toBe(true);
    expect(await pipelineOf(pipelineId)).toMatchObject({
      pendingChildren: 0,
      failedChildren: 0,
    });

    const finalize = await finalizeJobsOf(pipelineId);

    expect(finalize).toHaveLength(1);
    expect(finalize[0]!.outbox).toHaveLength(1);
  });

  it("takes nothing off for the finalize job's own finish", async () => {
    const { pipelineId, jobs } = await waitingOn(1);

    await transitions.succeed(jobs[0]!.id, 1, {});

    const [finalize] = await finalizeJobsOf(pipelineId);
    const { lease } = (await transitions.claim(finalize!.id))!;

    expect(await transitions.succeed(finalize!.id, lease, {})).toMatchObject({
      status: 'SUCCEEDED',
    });
    expect(await pipelineOf(pipelineId)).toMatchObject({ pendingChildren: 0 });
  });

  it('finishes a job outside any pipeline as before', async () => {
    const userId = await createThrowawayUser(prisma, 'counter');

    users.push(userId);

    const job = await seedJob(prisma, {
      userId,
      status: 'RUNNING',
      attempts: 1,
    });

    expect(await transitions.succeed(job.id, 1, {})).toMatchObject({
      status: 'SUCCEEDED',
    });
  });
});

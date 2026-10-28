import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { JobTransitionService } from '../../src/jobs/job-transition.service.js';
import type { Job } from '../../src/generated/prisma/client.js';

// The monotonic guard on a progress write lives in SQL, as a predicate over a
// jsonb path. Prisma's JSON filters are the kind of thing that compiles and then
// matches nothing, so the guarantee is asserted against a real Postgres rather
// than against the type.
describe('a progress write', () => {
  let prisma: PrismaService;
  let transitions: JobTransitionService;
  let userId: string;

  const runningJob = async (progress: Job['progress'], attempts = 1) => {
    const job = await prisma.job.create({
      data: {
        userId,
        type: 'MOCK',
        payload: {},
        status: 'RUNNING',
        attempts,
        idempotencyKey: `progress-${Math.random()}`,
        correlationId: 'test',
        ...(progress === null ? {} : { progress }),
      },
    });

    return job.id;
  };

  const progressOf = async (jobId: string) => {
    const { progress } = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { progress: true },
    });

    return progress;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          envFilePath: ['.env'],
        }),
        PrismaModule,
      ],
      providers: [JobTransitionService],
    }).compile();

    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    transitions = moduleRef.get(JobTransitionService);

    const user = await prisma.user.create({
      data: {
        email: `progress-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}@example.com`,
        passwordHash: 'not-a-real-hash',
      },
    });

    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('is accepted on a job that has reported nothing', async () => {
    const jobId = await runningJob(null);

    expect(
      await transitions.reportProgress(jobId, 1, { processed: 1 }),
    ).not.toBeNull();
    expect(await progressOf(jobId)).toEqual({ processed: 1 });
  });

  it('stores the total and message when the handler supplies them', async () => {
    const jobId = await runningJob(null);

    await transitions.reportProgress(jobId, 1, {
      processed: 2,
      total: 10,
      message: 'row 2 of 10',
    });

    expect(await progressOf(jobId)).toEqual({
      processed: 2,
      total: 10,
      message: 'row 2 of 10',
    });
  });

  it('omits a total the handler does not know, rather than writing null', async () => {
    const jobId = await runningJob(null);

    await transitions.reportProgress(jobId, 1, { processed: 1 });

    expect(await progressOf(jobId)).not.toHaveProperty('total');
  });

  it('moves progress forward', async () => {
    const jobId = await runningJob({ processed: 5 });

    expect(
      await transitions.reportProgress(jobId, 1, { processed: 6 }),
    ).not.toBeNull();
    expect(await progressOf(jobId)).toEqual({ processed: 6 });
  });

  it('is refused when it would move progress backwards', async () => {
    const jobId = await runningJob({ processed: 5 });

    expect(
      await transitions.reportProgress(jobId, 1, { processed: 4 }),
    ).toBeNull();
    expect(await progressOf(jobId)).toEqual({ processed: 5 });
  });

  // Equal, not just greater: a handler revising `message` at a count it has
  // already reached is not moving progress backwards.
  it('is accepted when it repeats the count already stored', async () => {
    const jobId = await runningJob({ processed: 5 });

    expect(
      await transitions.reportProgress(jobId, 1, {
        processed: 5,
        message: 'still working',
      }),
    ).not.toBeNull();
    expect(await progressOf(jobId)).toEqual({
      processed: 5,
      message: 'still working',
    });
  });

  // The write replaces the whole column, so whatever the caller omits is gone.
  // JobContext carries `total` forward for exactly this reason.
  it('replaces the stored value rather than merging into it', async () => {
    const jobId = await runningJob({ processed: 1, total: 10 });

    await transitions.reportProgress(jobId, 1, { processed: 2 });

    expect(await progressOf(jobId)).toEqual({ processed: 2 });
  });

  // Why `reclaim` exists: against a stored shape with no numeric `processed`,
  // `progress -> 'processed' <= n` is NULL rather than false, so it matches no
  // rows and the column would stay frozen for the rest of the job's life.
  it('is refused against a stored shape it cannot compare against', async () => {
    for (const unreadable of [
      { phase: 'extract' },
      { processed: 'five' },
      [1, 2, 3],
    ]) {
      const jobId = await runningJob(unreadable);

      expect(
        await transitions.reportProgress(jobId, 1, { processed: 1 }),
      ).toBeNull();
    }
  });

  it('reclaims that row when the caller says the stored value is unreadable', async () => {
    for (const unreadable of [
      { phase: 'extract' },
      { processed: 'five' },
      [1, 2, 3],
    ]) {
      const jobId = await runningJob(unreadable);

      expect(
        await transitions.reportProgress(
          jobId,
          1,
          { processed: 1 },
          { reclaim: true },
        ),
      ).not.toBeNull();
      expect(await progressOf(jobId)).toEqual({ processed: 1 });
    }
  });

  // Reclaiming drops the monotonic clause, never the ownership one.
  it('refuses a reclaim from an attempt that no longer owns the job', async () => {
    const jobId = await runningJob({ phase: 'extract' }, 2);

    expect(
      await transitions.reportProgress(
        jobId,
        1,
        { processed: 1 },
        { reclaim: true },
      ),
    ).toBeNull();
  });

  // The attempt a worker was handed by claim() is its ownership token (D25).
  it('is refused from an attempt that no longer owns the job', async () => {
    const jobId = await runningJob({ processed: 5 }, 2);

    expect(
      await transitions.reportProgress(jobId, 1, { processed: 9 }),
    ).toBeNull();
    expect(await progressOf(jobId)).toEqual({ processed: 5 });
  });

  it('is refused once the job has finished', async () => {
    const jobId = await runningJob({ processed: 5 });

    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'SUCCEEDED', finishedAt: new Date() },
    });

    expect(
      await transitions.reportProgress(jobId, 1, { processed: 9 }),
    ).toBeNull();
    expect(await progressOf(jobId)).toEqual({ processed: 5 });
  });

  // Ten is not "less than" nine in string order, and a jsonb number compares
  // numerically — the assertion exists because the predicate is a jsonb path
  // comparison, where getting that wrong is silent.
  it('compares counts as numbers, not as text', async () => {
    const jobId = await runningJob({ processed: 9 });

    expect(
      await transitions.reportProgress(jobId, 1, { processed: 10 }),
    ).not.toBeNull();
    expect(await progressOf(jobId)).toEqual({ processed: 10 });
  });

  it('is cleared by a re-drive, which starts the work over', async () => {
    const jobId = await runningJob({ processed: 5 });

    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'DEAD_LETTERED', finishedAt: new Date() },
    });

    await transitions.redrive(jobId);

    expect(await progressOf(jobId)).toBeNull();
  });
});

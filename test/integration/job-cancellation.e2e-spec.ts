import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { JobTransitionService } from '../../src/jobs/job-transition.service.js';
import type { JobStatus } from '../../src/generated/prisma/enums.js';

// Every cancellation transition is a guarded update whose WHERE clause is the
// whole of its correctness, so each one is asserted against a real Postgres:
// what it moves, and — just as much — what it refuses to.
describe('cancellation transitions', () => {
  let prisma: PrismaService;
  let transitions: JobTransitionService;
  let userId: string;

  const jobIn = async (
    status: JobStatus,
    { attempts = status === 'QUEUED' ? 0 : 1, cancelRequested = false } = {},
  ) => {
    const job = await prisma.job.create({
      data: {
        userId,
        type: 'MOCK',
        payload: {},
        status,
        attempts,
        cancelRequested,
        idempotencyKey: `cancel-${Math.random()}`,
        correlationId: 'test',
      },
    });

    return job.id;
  };

  const row = (jobId: string) =>
    prisma.job.findUniqueOrThrow({ where: { id: jobId } });

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
        email: `cancel-${Date.now()}-${Math.random()
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

  describe('requestCancel', () => {
    it.each(['QUEUED', 'RUNNING'] as const)(
      'flags a %s job without changing its status',
      async (status) => {
        const jobId = await jobIn(status);

        const flagged = await transitions.requestCancel(jobId);

        expect(flagged).toMatchObject({ status, cancelRequested: true });
      },
    );

    it.each(['SUCCEEDED', 'DEAD_LETTERED', 'CANCELLED'] as const)(
      'leaves a %s job untouched',
      async (status) => {
        const jobId = await jobIn(status);

        expect(await transitions.requestCancel(jobId)).toBeNull();
        expect(await row(jobId)).toMatchObject({
          status,
          cancelRequested: false,
        });
      },
    );
  });

  describe('cancelQueued', () => {
    it('finishes a flagged job nobody has claimed', async () => {
      const jobId = await jobIn('QUEUED', { cancelRequested: true });

      expect(await transitions.cancelQueued(jobId)).toMatchObject({
        status: 'CANCELLED',
        finishedAt: expect.any(Date),
      });
    });

    // The whole point of two fields: a handler may be mid-effect, so a running
    // job is never cancelled from outside.
    it('never touches a running job, flagged or not', async () => {
      const jobId = await jobIn('RUNNING', { cancelRequested: true });

      expect(await transitions.cancelQueued(jobId)).toBeNull();
      expect((await row(jobId)).status).toBe('RUNNING');
    });

    it('requires the flag', async () => {
      const jobId = await jobIn('QUEUED');

      expect(await transitions.cancelQueued(jobId)).toBeNull();
    });
  });

  describe('cancelBeforeClaim', () => {
    // QUEUED is a retry scheduled after the request; RUNNING is a redelivery
    // after the worker running it died.
    it.each(['QUEUED', 'RUNNING'] as const)(
      'finishes a flagged %s job instead of letting it run',
      async (status) => {
        const jobId = await jobIn(status, { cancelRequested: true });

        expect(await transitions.cancelBeforeClaim(jobId)).toMatchObject({
          status: 'CANCELLED',
        });
      },
    );

    it('lets an unflagged job through to the claim', async () => {
      const jobId = await jobIn('QUEUED');

      expect(await transitions.cancelBeforeClaim(jobId)).toBeNull();
      expect(await transitions.claim(jobId)).toMatchObject({
        status: 'RUNNING',
        attempts: 1,
      });
    });
  });

  describe('cancel — the worker acknowledging', () => {
    it('finishes the job for the attempt that owns it', async () => {
      const jobId = await jobIn('RUNNING', {
        attempts: 2,
        cancelRequested: true,
      });

      expect(await transitions.cancel(jobId, 2)).toMatchObject({
        status: 'CANCELLED',
      });
    });

    it('is refused from an attempt that no longer owns the job', async () => {
      const jobId = await jobIn('RUNNING', {
        attempts: 2,
        cancelRequested: true,
      });

      expect(await transitions.cancel(jobId, 1)).toBeNull();
      expect((await row(jobId)).status).toBe('RUNNING');
    });

    // A handler that stops without being asked must not invent a cancellation
    // its owner never made.
    it('is refused when nobody asked', async () => {
      const jobId = await jobIn('RUNNING');

      expect(await transitions.cancel(jobId, 1)).toBeNull();
    });
  });

  describe('isWanted', () => {
    it('is true for the owning attempt of an uncancelled job', async () => {
      expect(await transitions.isWanted(await jobIn('RUNNING'), 1)).toBe(true);
    });

    it('is false once a cancellation is requested', async () => {
      const jobId = await jobIn('RUNNING', { cancelRequested: true });

      expect(await transitions.isWanted(jobId, 1)).toBe(false);
    });

    it('is false for an attempt that has lost the job', async () => {
      const jobId = await jobIn('RUNNING', { attempts: 2 });

      expect(await transitions.isWanted(jobId, 1)).toBe(false);
    });

    it('is false once the job has finished', async () => {
      expect(await transitions.isWanted(await jobIn('SUCCEEDED'), 1)).toBe(
        false,
      );
    });
  });

  it('a cancelled job cannot be claimed', async () => {
    expect(await transitions.claim(await jobIn('CANCELLED'))).toBeNull();
  });

  // An operator re-driving is asking for the job to run again.
  it('a re-drive clears a cancellation from the previous life', async () => {
    const jobId = await jobIn('DEAD_LETTERED', { cancelRequested: true });

    expect(await transitions.redrive(jobId)).toMatchObject({
      status: 'QUEUED',
      cancelRequested: false,
    });
  });
});

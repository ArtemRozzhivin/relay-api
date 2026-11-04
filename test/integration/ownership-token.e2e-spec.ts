import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { JobTransitionService } from '../../src/jobs/job-transition.service.js';

// The token has one job — telling deliveries apart — and the case it has to get
// right spans two lives of one job: a worker that held the first life's first
// claim must not match the second life's first claim, although both are
// attempt 1.
describe('the ownership token across a re-drive', () => {
  let prisma: PrismaService;
  let transitions: JobTransitionService;
  let userId: string;

  const row = (jobId: string) =>
    prisma.job.findUniqueOrThrow({ where: { id: jobId } });

  // Claimed once, died, re-driven, claimed again: returns the job and the
  // lease each life's first claim handed out.
  const secondLife = async () => {
    const job = await prisma.job.create({
      data: {
        userId,
        type: 'MOCK',
        payload: {},
        idempotencyKey: `token-${randomUUID()}`,
        correlationId: 'token',
      },
    });

    const first = await transitions.claim(job.id);
    await transitions.deadLetter(job.id, first!.lease, { code: 'TEST' });
    await transitions.redrive(job.id);
    const second = await transitions.claim(job.id);

    return { jobId: job.id, first: first!, second: second! };
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
        email: `token-${randomUUID()}@example.com`,
        passwordHash: 'not-a-real-hash',
      },
    });

    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('resets the retry budget on a re-drive, never the lease', async () => {
    const { first, second } = await secondLife();

    // The collision the lease exists for: both lives start at attempt 1.
    expect(first.attempts).toBe(1);
    expect(second.attempts).toBe(1);
    expect(second.lease).toBeGreaterThan(first.lease);
  });

  it("refuses every write from the previous life's worker", async () => {
    const { jobId, first } = await secondLife();
    const stale = first.lease;

    expect(await transitions.isWanted(jobId, stale)).toBe(false);
    expect(
      await transitions.reportProgress(jobId, stale, { processed: 1 }),
    ).toBeNull();
    expect(await transitions.succeed(jobId, stale, { ok: true })).toBeNull();
    expect(
      await transitions.requeueForRetry(jobId, stale, { code: 'TEST' }),
    ).toBeNull();
    expect(
      await transitions.deadLetter(jobId, stale, { code: 'TEST' }),
    ).toBeNull();

    expect(await row(jobId)).toMatchObject({
      status: 'RUNNING',
      attempts: 1,
      progress: null,
    });
  });

  it('lets the current life finish', async () => {
    const { jobId, second } = await secondLife();

    expect(await transitions.isWanted(jobId, second.lease)).toBe(true);
    expect(
      await transitions.succeed(jobId, second.lease, { ok: true }),
    ).toMatchObject({ status: 'SUCCEEDED' });
  });
});

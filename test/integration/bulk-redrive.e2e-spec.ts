import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { JobTransitionService } from '../../src/jobs/job-transition.service.js';
import type { JobStatus } from '../../src/generated/prisma/enums.js';
import type { DeadLetterCode } from '../../src/jobs/job-error-codes.js';

// Each filter becomes part of a WHERE clause over many rows at once, and one
// of them is a Prisma JSON-path filter — the kind that compiles and then
// matches nothing. So every filter is asserted against a real Postgres, both
// for what it re-drives and, just as much, for what it leaves alone.
describe('bulk re-drive', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;

  const tenant = async (label: string) => {
    const email = `bulk-${label}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;

    await request(server)
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);

    const { body } = await request(server)
      .post('/auth/login')
      .send({ email, password: 'password123' });

    const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });

    return { token: body.data.accessToken as string, userId: id };
  };

  // Rows are written directly: what is under test is which rows the filter
  // selects, not how a job comes to die.
  const job = async (
    userId: string,
    {
      status = 'DEAD_LETTERED' as JobStatus,
      code = 'ATTEMPTS_EXHAUSTED' as DeadLetterCode,
      type = 'MOCK',
      finishedAt = new Date('2026-10-28T02:30:00Z'),
    } = {},
  ) => {
    const created = await prisma.job.create({
      data: {
        userId,
        type,
        payload: { durationMs: 10 },
        status,
        attempts: 3,
        idempotencyKey: `bulk-${Math.random()}`,
        correlationId: 'test',
        error: { code, message: 'it died', attempt: 3 },
        finishedAt,
      },
    });

    return created.id;
  };

  const redrive = (token: string, body: Record<string, unknown>) =>
    request(server)
      .post('/jobs/retry')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const statusOf = async (jobId: string) =>
    (await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('re-drives only the dead letters carrying the error code', async () => {
    const { token, userId } = await tenant('code');
    const abandoned = [
      await job(userId, { code: 'DELIVERY_ABANDONED' }),
      await job(userId, { code: 'DELIVERY_ABANDONED' }),
    ];
    const exhausted = await job(userId, { code: 'ATTEMPTS_EXHAUSTED' });

    const { status, body } = await redrive(token, {
      errorCode: 'DELIVERY_ABANDONED',
    });

    expect(status).toBe(202);
    expect(body.data).toEqual({ redriven: 2, remaining: 0 });

    for (const jobId of abandoned) {
      expect(
        await prisma.job.findUniqueOrThrow({ where: { id: jobId } }),
      ).toMatchObject({ status: 'QUEUED', attempts: 0, error: null });
    }

    expect(await statusOf(exhausted)).toBe('DEAD_LETTERED');
  });

  // Half-open, so two adjacent windows never re-drive the same job twice.
  it('treats the window as from-inclusive and to-exclusive', async () => {
    const { token, userId } = await tenant('window');
    const at = (time: string) =>
      job(userId, { finishedAt: new Date(`2026-10-28T${time}Z`) });

    const before = await at('01:59:59');
    const atStart = await at('02:00:00');
    const inside = await at('02:59:59');
    const atEnd = await at('03:00:00');

    const { body } = await redrive(token, {
      deadLetteredFrom: '2026-10-28T02:00:00Z',
      deadLetteredTo: '2026-10-28T03:00:00Z',
    });

    expect(body.data.redriven).toBe(2);
    expect(await statusOf(atStart)).toBe('QUEUED');
    expect(await statusOf(inside)).toBe('QUEUED');
    expect(await statusOf(before)).toBe('DEAD_LETTERED');
    expect(await statusOf(atEnd)).toBe('DEAD_LETTERED');
  });

  it('reads an offset as the instant it names', async () => {
    const { token, userId } = await tenant('offset');
    const died = await job(userId, {
      finishedAt: new Date('2026-10-28T02:30:00Z'),
    });

    // 04:00+02:00 is 02:00Z, so the window covers 02:30Z.
    await redrive(token, {
      deadLetteredFrom: '2026-10-28T04:00:00+02:00',
      deadLetteredTo: '2026-10-28T05:00:00+02:00',
    }).expect(202);

    expect(await statusOf(died)).toBe('QUEUED');
  });

  it('narrows by type', async () => {
    const { token, userId } = await tenant('type');
    const charge = await job(userId, { type: 'CHARGE' });
    const mock = await job(userId, { type: 'MOCK' });

    await redrive(token, { type: 'CHARGE' }).expect(202);

    expect(await statusOf(charge)).toBe('QUEUED');
    expect(await statusOf(mock)).toBe('DEAD_LETTERED');
  });

  it('works through a backlog a bounded batch at a time, oldest first', async () => {
    const { token, userId } = await tenant('batches');
    const ids: string[] = [];

    for (let minute = 0; minute < 5; minute += 1) {
      ids.push(
        await job(userId, {
          finishedAt: new Date(`2026-10-28T02:0${minute}:00Z`),
        }),
      );
    }

    const call = () => redrive(token, { type: 'MOCK', limit: 2 });

    expect((await call()).body.data).toEqual({ redriven: 2, remaining: 3 });
    expect(await statusOf(ids[0])).toBe('QUEUED');
    expect(await statusOf(ids[1])).toBe('QUEUED');
    expect(await statusOf(ids[2])).toBe('DEAD_LETTERED');

    expect((await call()).body.data).toEqual({ redriven: 2, remaining: 1 });
    expect((await call()).body.data).toEqual({ redriven: 1, remaining: 0 });

    // A call once the backlog is empty is a complete answer, not an error.
    expect((await call()).body.data).toEqual({ redriven: 0, remaining: 0 });
  });

  // Two overlapping calls can select the same ids before either commits; the
  // second then holds ids that have already moved on. Provoking that race over
  // HTTP is unreliable — each call finishes in a few milliseconds, so the second
  // usually selects after the first commits and the guard is never reached. So
  // the property is asserted directly: ids selected while dead, re-driven by
  // someone else since, are skipped rather than re-driven a second time.
  it('skips jobs that were re-driven after they were selected', async () => {
    const { userId } = await tenant('stale-ids');
    const transitions = app.get(JobTransitionService);
    const ids: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      ids.push(await job(userId));
    }

    const first = await prisma.$transaction((tx) =>
      transitions.redriveMany(ids, tx),
    );
    const second = await prisma.$transaction((tx) =>
      transitions.redriveMany(ids, tx),
    );

    expect(first).toHaveLength(ids.length);
    expect(second).toHaveLength(0);
  });

  it('counts without changing anything on a dry run', async () => {
    const { token, userId } = await tenant('dry');
    const jobId = await job(userId);

    const { status, body } = await redrive(token, {
      type: 'MOCK',
      dryRun: true,
    });

    expect(status).toBe(202);
    expect(body.data).toEqual({ redriven: 0, remaining: 1 });
    expect(await statusOf(jobId)).toBe('DEAD_LETTERED');
    expect(await prisma.outbox.count({ where: { jobId } })).toBe(0);
  });

  // The outbox row is what makes the re-drive survive a crash after commit, so
  // it must exist for every re-driven job and for nothing else.
  it('writes exactly one outbox row per re-driven job', async () => {
    const { token, userId } = await tenant('outbox');
    const matching = [await job(userId), await job(userId)];
    const other = await job(userId, { code: 'TERMINAL_FAILURE' });

    await redrive(token, { errorCode: 'ATTEMPTS_EXHAUSTED' }).expect(202);

    for (const jobId of matching) {
      expect(await prisma.outbox.count({ where: { jobId } })).toBe(1);
    }

    expect(await prisma.outbox.count({ where: { jobId: other } })).toBe(0);
  });

  it.each(['SUCCEEDED', 'CANCELLED', 'QUEUED', 'RUNNING'] as const)(
    'never touches a %s job, whatever else matches',
    async (status) => {
      const { token, userId } = await tenant(`not-dead-${status}`);
      const jobId = await job(userId, { status });

      const { body } = await redrive(token, { type: 'MOCK' });

      expect(body.data).toEqual({ redriven: 0, remaining: 0 });
      expect(await statusOf(jobId)).toBe(status);
    },
  );

  it("never touches another tenant's dead letters", async () => {
    const [owner, stranger] = await Promise.all([
      tenant('owner'),
      tenant('stranger'),
    ]);
    const jobId = await job(owner.userId);

    const { body } = await redrive(stranger.token, { type: 'MOCK' });

    expect(body.data).toEqual({ redriven: 0, remaining: 0 });
    expect(await statusOf(jobId)).toBe('DEAD_LETTERED');
  });

  it.each([
    ['no filter', {}],
    ['a time with no timezone', { deadLetteredFrom: '2026-10-28T02:00:00' }],
    ['an unknown error code', { errorCode: 'ATTEMPTS_EXHAUSTD' }],
    ['an unknown field', { type: 'MOCK', status: 'SUCCEEDED' }],
  ])('refuses %s with a 400', async (_label, body) => {
    const { token } = await tenant('bad');

    await redrive(token, body).expect(400);
  });
});

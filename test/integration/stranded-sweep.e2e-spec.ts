import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Worker, type Job as QueueJob, type Queue } from 'bullmq';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { RedisModule } from '../../src/redis/redis.module.js';
import { JobTransitionService } from '../../src/jobs/job-transition.service.js';
import { JobEventsPublisher } from '../../src/jobs/job-events.publisher.js';
import { JOBS_QUEUE, messageId } from '../../src/jobs/job-queue.js';
import {
  StrandedJobSweeper,
  type SweepCandidate,
} from '../../src/worker/stranded-job.sweeper.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
  seedJob,
} from '../support/db.js';

// The sweep decides from the queue's state, so each state is built for real in
// Redis — under a prefix of its own, so nothing another tier left in the queue
// is in the way of the manual worker that drives them — and the sweeper is
// asked about these rows only, never about whatever else is unfinished in the
// database.
describe('the stranded-job sweep', () => {
  const prefix = `sweep-test-${randomUUID()}`;
  const connection = { url: process.env.REDIS_URL };

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let sweeper: StrandedJobSweeper;
  let transitions: JobTransitionService;
  let queue: Queue;
  let worker: Worker;
  let userId: string;

  // A RUNNING row has been claimed once. A QUEUED one has not: it stands for
  // a job whose every delivery failed before the claim, and its outbox row is
  // published, because the queue has had it.
  const unfinished = async (
    status: 'RUNNING' | 'QUEUED',
  ): Promise<SweepCandidate> => {
    const claimed = status === 'RUNNING';
    const job = await seedJob(prisma, {
      userId,
      status,
      attempts: claimed ? 1 : 0,
      startedAt: claimed ? new Date() : null,
    });
    const outbox = await prisma.outbox.create({
      data: {
        jobId: job.id,
        queue: JOBS_QUEUE,
        jobName: 'MOCK',
        payload: {},
        publishedAt: claimed ? null : new Date(),
      },
    });

    return {
      id: job.id,
      status: job.status,
      lease: job.lease,
      outboxId: outbox.id,
    };
  };

  const running = () => unfinished('RUNNING');

  const enqueue = (job: SweepCandidate, options: { delay?: number } = {}) =>
    queue.add(
      'MOCK',
      { jobId: job.id, correlationId: 'sweep' },
      { jobId: messageId(job.id, job.outboxId), attempts: 1, ...options },
    );

  // Takes the entry the way a worker does, under a lock this test holds.
  const take = async (job: SweepCandidate, token: string) => {
    await enqueue(job);

    const taken: QueueJob | undefined = await worker.getNextJob(token);

    expect(taken?.id).toBe(messageId(job.id, job.outboxId));

    return taken!;
  };

  const row = (jobId: string) =>
    prisma.job.findUniqueOrThrow({ where: { id: jobId } });

  // Past the margin the sweep leaves the 'failed' event to act in first.
  const later = () => Date.now() + 60_000;

  beforeAll(async () => {
    // The test drives the sweep itself; its own timer must never fire here.
    process.env.RELAY_SWEEP_INTERVAL_MS = String(3_600_000);

    moduleRef = await createTestModule({
      imports: [
        PrismaModule,
        RedisModule,
        BullModule.forRoot({ connection, prefix }),
        BullModule.registerQueue({ name: JOBS_QUEUE }),
      ],
      providers: [JobTransitionService, JobEventsPublisher, StrandedJobSweeper],
    });

    prisma = moduleRef.get(PrismaService);
    sweeper = moduleRef.get(StrandedJobSweeper);
    transitions = moduleRef.get(JobTransitionService);
    queue = moduleRef.get(getQueueToken(JOBS_QUEUE));
    worker = new Worker(JOBS_QUEUE, null, { connection, prefix });

    userId = await createThrowawayUser(prisma, 'sweep');
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await deleteUsers(prisma, [userId]);
    await moduleRef.close();
  });

  it('finishes a RUNNING job whose queue entry is gone', async () => {
    const job = await running();

    const swept = await sweeper.finishIfStranded(job);

    expect(swept).toMatchObject({ status: 'DEAD_LETTERED' });
    expect((await row(job.id)).error).toMatchObject({
      code: 'DELIVERY_ABANDONED',
      message: expect.stringContaining('missing'),
    });
  });

  it.each(['failed', 'completed'] as const)(
    'finishes a RUNNING job whose entry was %s long enough ago',
    async (state) => {
      const job = await running();
      const token = randomUUID();
      const taken = await take(job, token);

      if (state === 'failed') {
        await taken.moveToFailed(new Error('gone'), token, false);
      } else {
        await taken.moveToCompleted('done', token, false);
      }

      expect(await sweeper.finishIfStranded(job, later())).toMatchObject({
        status: 'DEAD_LETTERED',
      });
      expect((await row(job.id)).error).toMatchObject({
        message: expect.stringContaining(state),
      });
    },
  );

  it('leaves a just-failed entry for the failed event to finish', async () => {
    const job = await running();
    const token = randomUUID();

    await (
      await take(job, token)
    ).moveToFailed(new Error('gone'), token, false);

    expect(await sweeper.finishIfStranded(job)).toBeNull();
    expect((await row(job.id)).status).toBe('RUNNING');
  });

  it('leaves a job a worker still holds', async () => {
    const job = await running();
    const token = randomUUID();
    const taken = await take(job, token);

    expect(await sweeper.finishIfStranded(job, later())).toBeNull();
    expect((await row(job.id)).status).toBe('RUNNING');

    await taken.moveToCompleted('done', token, false);
  });

  it('never finishes a job claimed again since the sweep read it', async () => {
    const job = await running();

    await prisma.job.update({
      where: { id: job.id },
      data: { lease: { increment: 1 } },
    });

    expect(await sweeper.finishIfStranded(job)).toBeNull();
    expect((await row(job.id)).status).toBe('RUNNING');
  });

  it('never touches a job that is not RUNNING', async () => {
    const job = await running();

    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'SUCCEEDED', finishedAt: new Date() },
    });

    expect(await sweeper.finishIfStranded(job)).toBeNull();
    expect((await row(job.id)).status).toBe('SUCCEEDED');
  });

  // M5: Postgres unreachable at every delivery, so cancelBeforeClaim threw
  // each time and the queue failed the entry with the row never claimed.
  it('finishes a QUEUED job no attempt ever claimed, once its entry has failed', async () => {
    const job = await unfinished('QUEUED');
    const token = randomUUID();

    await (
      await take(job, token)
    ).moveToFailed(new Error('connect ECONNREFUSED'), token, false);

    // What the failed event does once Postgres is back, and why the sweep has
    // to: with nothing claimed there is no attempt to vouch for the write.
    expect(
      await transitions.abandon(job.id, {
        code: 'DELIVERY_ABANDONED',
        message: 'test',
      }),
    ).toBeNull();

    expect(await sweeper.finishIfStranded(job, later())).toMatchObject({
      status: 'DEAD_LETTERED',
      attempts: 0,
    });
    expect((await row(job.id)).error).toMatchObject({
      code: 'DELIVERY_ABANDONED',
      message: expect.stringContaining('failed'),
    });
  });

  it('never finishes a job re-driven since the sweep read it', async () => {
    const job = await unfinished('QUEUED');

    // The re-drive's own delivery: a newer outbox row, under the same lease.
    await prisma.outbox.create({
      data: { jobId: job.id, queue: JOBS_QUEUE, jobName: 'MOCK', payload: {} },
    });

    expect(await sweeper.finishIfStranded(job)).toBeNull();
    expect((await row(job.id)).status).toBe('QUEUED');
  });

  // The one test that runs sweep() itself, which reads every unfinished row in
  // the database: the decision is stubbed for every row but this test's, so
  // nothing else is touched. This test's ids start ffffffff and so sort after
  // every other row, which puts page boundaries among them whatever else is
  // in the table.
  it('asks about every candidate once, though it finishes the last row of a page', async () => {
    const run = randomUUID().slice(0, 4);
    const id = (n: number) =>
      `ffffffff-${run}-4000-8000-${String(n).padStart(12, '0')}`;
    const count = 210;
    const ids = Array.from({ length: count }, (_, n) => id(n));
    // Waits for the relay, not the queue: never a candidate.
    const unpublished = id(105);

    await prisma.job.createMany({
      data: ids.map((jobId, n) => ({
        id: jobId,
        userId,
        type: 'MOCK',
        payload: {},
        status: n % 2 === 0 ? 'RUNNING' : 'QUEUED',
        attempts: n % 2 === 0 ? 1 : 0,
        lease: n % 2 === 0 ? 1 : 0,
        idempotencyKey: `sweep-${randomUUID()}`,
        correlationId: 'sweep',
      })),
    });
    await prisma.outbox.createMany({
      data: ids.map((jobId) => ({
        jobId,
        queue: JOBS_QUEUE,
        jobName: 'MOCK',
        payload: {},
        publishedAt: jobId === unpublished ? null : new Date(),
      })),
    });

    const ours = new Set(ids);
    const decide = sweeper.finishIfStranded.bind(sweeper);
    const asked: string[] = [];
    const spy = vi
      .spyOn(sweeper, 'finishIfStranded')
      .mockImplementation(async (job, now) => {
        if (!ours.has(job.id)) {
          return null;
        }

        asked.push(job.id);

        // Their entries are missing under this file's prefix, so each one is
        // dead-lettered and leaves the filter as soon as it is asked about.
        return decide(job, now);
      });

    // Two hundred expected dead-letter lines would read as a failing run.
    const quiet = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    try {
      await sweeper.sweep();
    } finally {
      spy.mockRestore();
      quiet.mockRestore();
    }

    const candidates = ids.filter((jobId) => jobId !== unpublished);

    expect(asked).toEqual(candidates);
    expect(
      await prisma.job.count({
        where: { id: { in: candidates }, status: 'DEAD_LETTERED' },
      }),
    ).toBe(count - 1);
    expect((await row(unpublished)).status).toBe('QUEUED');
  });

  // Last: a waiting entry would be the next one getNextJob() hands out.
  it.each([
    ['RUNNING', 'waiting', {}],
    ['RUNNING', 'delayed', { delay: 60_000 }],
    ['QUEUED', 'waiting', {}],
    ['QUEUED', 'delayed', { delay: 60_000 }],
  ] as const)(
    'leaves a %s job whose entry is %s',
    async (status, _state, options) => {
      const job = await unfinished(status);

      await enqueue(job, options);

      expect(await sweeper.finishIfStranded(job, later())).toBeNull();
      expect((await row(job.id)).status).toBe(status);
    },
  );
});

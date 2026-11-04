import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Worker, type Job as QueueJob, type Queue } from 'bullmq';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { RedisModule } from '../../src/redis/redis.module.js';
import { JobTransitionService } from '../../src/jobs/job-transition.service.js';
import { JobEventsPublisher } from '../../src/jobs/job-events.publisher.js';
import { JOBS_QUEUE, messageId } from '../../src/jobs/job-queue.js';
import { workerEnvSchema } from '../../src/config/env.schema.js';
import {
  StrandedJobSweeper,
  type SweepCandidate,
} from '../../src/worker/stranded-job.sweeper.js';

// The sweep decides from the queue's state, so each state is built for real in
// Redis — under a prefix of its own, so nothing another tier left in the queue
// is in the way of the manual worker that drives them — and the sweeper is
// asked about these rows only, never about whatever else is RUNNING in the
// database.
describe('the stranded-job sweep', () => {
  const prefix = `sweep-test-${randomUUID()}`;
  const connection = { url: process.env.REDIS_URL };

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let sweeper: StrandedJobSweeper;
  let queue: Queue;
  let worker: Worker;
  let userId: string;

  const running = async (): Promise<SweepCandidate> => {
    const job = await prisma.job.create({
      data: {
        userId,
        type: 'MOCK',
        payload: {},
        status: 'RUNNING',
        attempts: 1,
        lease: 1,
        startedAt: new Date(),
        idempotencyKey: `sweep-${randomUUID()}`,
        correlationId: 'sweep',
        outbox: {
          create: { queue: JOBS_QUEUE, jobName: 'MOCK', payload: {} },
        },
      },
      include: { outbox: true },
    });

    return { id: job.id, lease: job.lease, outboxId: job.outbox[0].id };
  };

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

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          envFilePath: ['.env'],
          validationSchema: workerEnvSchema,
        }),
        PrismaModule,
        RedisModule,
        BullModule.forRoot({ connection, prefix }),
        BullModule.registerQueue({ name: JOBS_QUEUE }),
      ],
      providers: [JobTransitionService, JobEventsPublisher, StrandedJobSweeper],
    }).compile();

    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    sweeper = moduleRef.get(StrandedJobSweeper);
    queue = moduleRef.get(getQueueToken(JOBS_QUEUE));
    worker = new Worker(JOBS_QUEUE, null, { connection, prefix });

    const user = await prisma.user.create({
      data: {
        email: `sweep-${randomUUID()}@example.com`,
        passwordHash: 'not-a-real-hash',
      },
    });

    userId = user.id;
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await prisma.user.delete({ where: { id: userId } });
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

  // Last: a waiting entry would be the next one getNextJob() hands out.
  it.each([
    ['waiting', {}],
    ['delayed', { delay: 60_000 }],
  ] as const)('leaves a job whose entry is %s', async (_state, options) => {
    const job = await running();

    await enqueue(job, options);

    expect(await sweeper.finishIfStranded(job, later())).toBeNull();
    expect((await row(job.id)).status).toBe('RUNNING');
  });
});

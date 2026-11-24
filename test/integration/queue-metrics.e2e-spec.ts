import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { Registry } from '@prometheus-io/client';
import { Prisma } from '../../src/generated/prisma/client.js';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  DEAD_LETTERS_BY_TYPE,
  QueueMetrics,
} from '../../src/jobs/delivery/queue-metrics.js';
import type { JobQueues } from '../../src/jobs/delivery/job-queues.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
  seedJob,
} from '../support/db.js';

// The dead-letter count against the real database: what it counts, and how
// Postgres reads it. It spans every account, so a test compares it before and
// after its own rows rather than expecting a total.
describe('the dead-letter metric', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let registry: Registry;
  const users: string[] = [];

  // What a scrape shows, as `{ type: count }`.
  const deadLetters = async () => {
    const { values } = await registry
      .getSingleMetric('relay_dead_letters')!
      .get();

    return Object.fromEntries(
      values.map(({ labels, value }) => [labels.type as string, value]),
    );
  };

  beforeAll(async () => {
    moduleRef = await createTestModule({ imports: [PrismaModule] });
    prisma = moduleRef.get(PrismaService);
    registry = new Registry();

    // The queues' series are not under test here.
    const queues = { all: () => [] } as unknown as JobQueues;

    new QueueMetrics(registry, prisma, queues);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await moduleRef?.close();
  });

  it('counts dead letters by type across every account, and nothing else', async () => {
    const before = await deadLetters();
    const [one, other] = await Promise.all([
      createThrowawayUser(prisma, 'metric-one'),
      createThrowawayUser(prisma, 'metric-other'),
    ]);

    users.push(one, other);

    await seedJob(prisma, { userId: one, status: 'DEAD_LETTERED' });
    await seedJob(prisma, { userId: other, status: 'DEAD_LETTERED' });
    await seedJob(prisma, {
      userId: one,
      type: 'CHARGE',
      status: 'DEAD_LETTERED',
    });

    for (const status of [
      'QUEUED',
      'RUNNING',
      'SUCCEEDED',
      'CANCELLED',
    ] as const) {
      await seedJob(prisma, { userId: one, status });
    }

    const after = await deadLetters();

    expect(
      Object.fromEntries(
        Object.entries(after).map(([type, count]) => [
          type,
          count - (before[type] ?? 0),
        ]),
      ),
    ).toEqual({
      MOCK: 2,
      CHARGE: 1,
      'import.csv': 0,
      'image.process': 0,
      'ai.enrich': 0,
      'pipeline.finalize': 0,
    });
  });

  // Every scrape runs it across all accounts, so reading every job would cost
  // more the longer the service has run, not the more that is wrong.
  it('reads the index of dead letters, not every job', async () => {
    const plan = await prisma.$transaction(async (tx) => {
      // Off, so the plan shows whether Postgres can use the index at all: on a
      // table this small, reading all of it can be cheaper.
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;

      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>(
        Prisma.sql`EXPLAIN ${DEAD_LETTERS_BY_TYPE}`,
      );
    });

    expect(plan.map((line) => line['QUERY PLAN']).join('\n')).toContain(
      'Job_dead_letters_idx',
    );
  });
});

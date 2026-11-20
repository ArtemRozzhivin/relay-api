import { Logger } from '@nestjs/common';
import { Registry } from '@prometheus-io/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { QueueMetrics } from './queue-metrics.js';
import { AI_QUEUE, JOBS_QUEUE } from './job-queue.js';
import type { JobQueues } from './job-queues.js';

const down = () => Promise.reject(new Error('connect ECONNREFUSED'));

// Sources that answer until `fail` names them.
const sources = () => {
  const fail = { postgres: false, redis: false };

  const prisma = {
    // Unpublished rows by the queue they name; none for relay-ai.
    outbox: {
      groupBy: () =>
        fail.postgres
          ? down()
          : Promise.resolve([{ queue: JOBS_QUEUE, _count: { _all: 3 } }]),
    },
    // Only the dead-letter count is a raw query.
    $queryRaw: () =>
      fail.postgres ? down() : Promise.resolve([{ type: 'MOCK', count: 2 }]),
  } as unknown as PrismaService;

  const holding = (counts: Record<string, number>) => ({
    getJobCounts: () => (fail.redis ? down() : Promise.resolve(counts)),
  });

  const queues = {
    all: () => [
      [
        JOBS_QUEUE,
        holding({ waiting: 5, prioritized: 0, delayed: 1, active: 2 }),
      ],
      [
        AI_QUEUE,
        holding({ waiting: 4, prioritized: 0, delayed: 0, active: 1 }),
      ],
    ],
  } as unknown as JobQueues;

  return { fail, prisma, queues };
};

// What one scrape would show of `name`, as `{ label: value }`.
const scrape = async (registry: Registry, name: string, label: string) => {
  await registry.metrics();

  const { values } = await registry.getSingleMetric(name)!.get();

  return Object.fromEntries(
    values.map(({ labels, value }) => [
      (labels as Record<string, string>)[label],
      value,
    ]),
  );
};

// The backlog one scrape would show, as `{ queue: { state: value } }`.
const depth = async (registry: Registry) => {
  await registry.metrics();

  const { values } = await registry.getSingleMetric('relay_queue_depth')!.get();
  const byQueue: Record<string, Record<string, number>> = {};

  for (const { labels, value } of values) {
    const { queue, state } = labels as Record<string, string>;

    byQueue[queue] = { ...byQueue[queue], [state]: value };
  }

  return byQueue;
};

describe('QueueMetrics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  const setup = () => {
    const registry = new Registry();
    const { fail, prisma, queues } = sources();

    new QueueMetrics(registry, prisma, queues);

    return { registry, fail };
  };

  it("reads each queue's backlog from the outbox and the queue", async () => {
    const { registry } = setup();

    expect(await depth(registry)).toEqual({
      [JOBS_QUEUE]: {
        outbox: 3,
        waiting: 5,
        prioritized: 0,
        delayed: 1,
        active: 2,
      },
      [AI_QUEUE]: {
        outbox: 0,
        waiting: 4,
        prioritized: 0,
        delayed: 0,
        active: 1,
      },
    });
  });

  it('gives every job type a dead-letter count, none as 0', async () => {
    const { registry } = setup();

    expect(await scrape(registry, 'relay_dead_letters', 'type')).toEqual({
      MOCK: 2,
      CHARGE: 0,
      'import.csv': 0,
      'image.process': 0,
      'ai.enrich': 0,
    });
  });

  // A gap, not a stale number: what the last scrape read is no longer true.
  it('drops what Postgres gave once it cannot be read, and keeps the queue', async () => {
    const { registry, fail } = setup();

    await registry.metrics();
    fail.postgres = true;

    expect(await depth(registry)).toEqual({
      [JOBS_QUEUE]: { waiting: 5, prioritized: 0, delayed: 1, active: 2 },
      [AI_QUEUE]: { waiting: 4, prioritized: 0, delayed: 0, active: 1 },
    });
    expect(await scrape(registry, 'relay_dead_letters', 'type')).toEqual({});
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });

  it('drops the queue states once Redis cannot be read, and keeps the outbox', async () => {
    const { registry, fail } = setup();

    await registry.metrics();
    fail.redis = true;

    expect(await depth(registry)).toEqual({
      [JOBS_QUEUE]: { outbox: 3 },
      [AI_QUEUE]: { outbox: 0 },
    });
  });
});

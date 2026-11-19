import { Logger } from '@nestjs/common';
import { Registry } from '@prometheus-io/client';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { QueueMetrics } from './queue-metrics.js';

const down = () => Promise.reject(new Error('connect ECONNREFUSED'));

// Sources that answer until `fail` names them.
const sources = () => {
  const fail = { postgres: false, redis: false };

  const prisma = {
    outbox: { count: () => (fail.postgres ? down() : Promise.resolve(3)) },
    // Only the dead-letter count is a raw query.
    $queryRaw: () =>
      fail.postgres ? down() : Promise.resolve([{ type: 'MOCK', count: 2 }]),
  } as unknown as PrismaService;

  const queue = {
    getJobCounts: () =>
      fail.redis
        ? down()
        : Promise.resolve({
            waiting: 5,
            prioritized: 0,
            delayed: 1,
            active: 2,
          }),
  } as unknown as Queue;

  return { fail, prisma, queue };
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

describe('QueueMetrics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  const setup = () => {
    const registry = new Registry();
    const { fail, prisma, queue } = sources();

    new QueueMetrics(registry, prisma, queue);

    return { registry, fail };
  };

  it('reads the backlog from the outbox and the queue', async () => {
    const { registry } = setup();

    expect(await scrape(registry, 'relay_queue_depth', 'state')).toEqual({
      outbox: 3,
      waiting: 5,
      prioritized: 0,
      delayed: 1,
      active: 2,
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

    expect(await scrape(registry, 'relay_queue_depth', 'state')).toEqual({
      waiting: 5,
      prioritized: 0,
      delayed: 1,
      active: 2,
    });
    expect(await scrape(registry, 'relay_dead_letters', 'type')).toEqual({});
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });

  it('drops the queue states once Redis cannot be read, and keeps the outbox', async () => {
    const { registry, fail } = setup();

    await registry.metrics();
    fail.redis = true;

    expect(await scrape(registry, 'relay_queue_depth', 'state')).toEqual({
      outbox: 3,
    });
  });
});

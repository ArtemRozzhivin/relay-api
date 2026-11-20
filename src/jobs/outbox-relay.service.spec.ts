import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxRelayService } from './outbox-relay.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AI_QUEUE, JOBS_QUEUE, type JobMessage } from './job-queue.js';
import type { JobQueues } from './job-queues.js';

const row = (id: number, queue: string = JOBS_QUEUE) => ({
  id: BigInt(id),
  jobId: `job-${id}`,
  queue,
  jobName: 'MOCK',
  payload: { jobId: `job-${id}`, correlationId: 'req', maxAttempts: 5 },
});

const build = (
  rows: ReturnType<typeof row>[],
  fails: (jobId: string) => boolean,
) => {
  const published: bigint[] = [];
  const added: [queue: string, jobId: string][] = [];

  const prisma = {
    outbox: {
      findMany: async () => rows,
      update: async ({ where }: { where: { id: bigint } }) => {
        published.push(where.id);
      },
    },
  } as unknown as PrismaService;

  const queueNamed = (name: string) => ({
    add: async (_name: string, data: JobMessage) => {
      if (fails(data.jobId)) {
        throw new Error(`cannot enqueue ${data.jobId}`);
      }

      added.push([name, data.jobId]);
    },
  });

  const queues = {
    named: (name: string) => {
      if (name !== JOBS_QUEUE && name !== AI_QUEUE) {
        throw new Error(`No queue is named ${name}`);
      }

      return queueNamed(name);
    },
  } as unknown as JobQueues;

  return {
    relay: new OutboxRelayService(prisma, queues),
    published,
    added,
  };
};

describe('OutboxRelayService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  // The next tick starts from the oldest unpublished row again, so a row that
  // always fails would otherwise hold back every row behind it for good.
  it('publishes the rows behind one it cannot publish', async () => {
    const { relay, published } = build(
      [row(1), row(2), row(3)],
      (jobId) => jobId === 'job-2',
    );

    expect(await relay.publishPending()).toBe(2);
    expect(published).toEqual([1n, 3n]);
  });

  it('publishes each row to the queue it names', async () => {
    const { relay, added } = build(
      [row(1), row(2, AI_QUEUE), row(3)],
      () => false,
    );

    await relay.publishPending();

    expect(added).toEqual([
      [JOBS_QUEUE, 'job-1'],
      [AI_QUEUE, 'job-2'],
      [JOBS_QUEUE, 'job-3'],
    ]);
  });

  // Written by a deploy that knew a queue this one does not: it waits for one
  // that does, and holds nothing else back.
  it('leaves a row naming an unknown queue unpublished, and publishes the rest', async () => {
    const { relay, published } = build(
      [row(1), row(2, 'relay-later'), row(3)],
      () => false,
    );

    expect(await relay.publishPending()).toBe(2);
    expect(published).toEqual([1n, 3n]);
  });

  it('reports a tick of failures once, not once per row', async () => {
    const { relay, published } = build([row(1), row(2), row(3)], () => true);

    expect(await relay.publishPending()).toBe(0);
    expect(published).toEqual([]);
    expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('3 of 3'),
    );
  });
});

import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { OutboxRelayService } from './outbox-relay.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { JobMessage } from './job-queue.js';

const row = (id: number) => ({
  id: BigInt(id),
  jobId: `job-${id}`,
  jobName: 'MOCK',
  payload: { jobId: `job-${id}`, correlationId: 'req', maxAttempts: 5 },
});

const build = (
  rows: ReturnType<typeof row>[],
  fails: (jobId: string) => boolean,
) => {
  const published: bigint[] = [];

  const prisma = {
    outbox: {
      findMany: async () => rows,
      update: async ({ where }: { where: { id: bigint } }) => {
        published.push(where.id);
      },
    },
  } as unknown as PrismaService;

  const queue = {
    add: async (_name: string, data: JobMessage) => {
      if (fails(data.jobId)) {
        throw new Error(`cannot enqueue ${data.jobId}`);
      }
    },
  } as unknown as Queue<JobMessage>;

  return { relay: new OutboxRelayService(prisma, queue), published };
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

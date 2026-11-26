import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Queue, RateLimitError, Worker } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';

// The worker's limit on free hand-backs (FREE_HAND_BACKS) reads them off
// BullMQ's own counters: every start of a delivery is counted, and only a
// failure is an attempt made. Checked against the real queue, so an upgrade
// that counts differently fails here instead of handing a job back for ever.
describe("BullMQ's count of a delivery's starts", () => {
  const prefix = `starts-test-${randomUUID()}`;
  const connection = { url: process.env.REDIS_URL };
  const queue = new Queue('starts', { connection, prefix });
  let worker: Worker | undefined;

  afterAll(async () => {
    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('counts a hand-back as a start, and only a failure as an attempt made', async () => {
    const seen: [started: number, made: number][] = [];

    // Two hand-backs as the processor makes them, a failure, then success.
    const finished = new Promise<void>((resolve) => {
      worker = new Worker(
        'starts',
        async (job) => {
          seen.push([job.attemptsStarted, job.attemptsMade]);

          if (seen.length <= 2) {
            await queue.rateLimit(10);

            throw new RateLimitError();
          }

          if (seen.length === 3) {
            throw new Error('a failure');
          }

          resolve();
        },
        { connection, prefix, limiter: { max: 100, duration: 1000 } },
      );
    });

    await queue.add('job', {}, { attempts: 2 });
    await finished;

    expect(seen).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 1],
    ]);
  });
});

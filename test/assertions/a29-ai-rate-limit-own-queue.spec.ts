import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';
import { AI_QUEUE } from '../../src/jobs/job-queue.js';

const AI_JOBS = 4;
const LIMIT_WINDOW_MS = 1000;

// A29 — a provider's rate limit slows the jobs that call the provider and no
// others (D6a). The AI queue lets one job start a second here; jobs submitted
// behind a backlog of AI jobs still run at once, because they are on another
// queue that no limiter holds.
describe("A29 · the AI queue's rate limit slows only its own jobs", () => {
  let harness: RelayHarness;
  let account: Account;

  const submit = async (payload: Record<string, unknown>) => {
    const { status, body } = await harness.submit(account, payload);

    expect(status).toBe(202);

    return body.data.id as string;
  };

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a29');

    await harness.prisma.product.createMany({
      data: Array.from({ length: AI_JOBS }, (_, n) => ({
        userId: account.id,
        sku: `SKU-${n}`,
        name: `Product ${n}`,
        priceCents: 100,
        currency: 'EUR',
      })),
    });
  });

  afterAll(() => harness.stop());

  it('starts AI jobs one window apart while the other jobs run at once', async () => {
    // Queued before the worker starts, so the limiter alone decides when each
    // one runs, and the other jobs are behind all of them in submit order.
    const aiJobs: string[] = [];

    for (let n = 0; n < AI_JOBS; n++) {
      aiJobs.push(
        await submit({ type: 'ai.enrich', payload: { skus: [`SKU-${n}`] } }),
      );
    }

    const otherJobs: string[] = [];

    for (let n = 0; n < 3; n++) {
      otherJobs.push(
        await submit({ type: 'MOCK', payload: { durationMs: 1 } }),
      );
    }

    harness.startWorker('worker', {
      AI_WORKER_CONCURRENCY: '2',
      AI_QUEUE_LIMIT_MAX: '1',
      AI_QUEUE_LIMIT_DURATION_MS: String(LIMIT_WINDOW_MS),
    });

    const done = await Promise.all(
      [...aiJobs, ...otherJobs].map((jobId) =>
        harness.waitForJobStatus(jobId, ['SUCCEEDED', 'DEAD_LETTERED']),
      ),
    );

    expect(done.map(({ status }) => status)).toEqual(
      done.map(() => 'SUCCEEDED'),
    );

    for (const jobId of aiJobs) {
      expect(await harness.outbox(jobId)).toEqual([
        expect.objectContaining({ queue: AI_QUEUE }),
      ]);
    }

    const ai = done.slice(0, AI_JOBS);
    const others = done.slice(AI_JOBS);
    const starts = ai
      .map(({ startedAt }) => startedAt!.getTime())
      .sort((a, b) => a - b);
    const gaps = starts.slice(1).map((start, n) => start - starts[n]);

    // A window of slack under the full one: the limiter's key expires in
    // Redis, which answers in its own time.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(LIMIT_WINDOW_MS - 100);

    // All within the first window: no limiter held any of them back, where on
    // a shared queue they would have waited out every window.
    expect(
      Math.max(...others.map(({ finishedAt }) => finishedAt!.getTime())),
    ).toBeLessThan(starts[1]);
  });
});

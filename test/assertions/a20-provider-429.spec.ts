import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type ProcessHandle,
} from '../harness/relay-harness.js';

// The fake's Retry-After for a product named [llm:busy].
const RETRY_AFTER_MS = 1000;

interface Line {
  time: number;
  msg: string;
  jobId?: string;
}

// A20 — a provider's 429 slows the AI queue and fails no job (§6.3d). One job
// finds the model busy. Every job has a single attempt, so a 429 counted as a
// failure would dead-letter it. The queue starts nothing until the provider's
// Retry-After has passed, and no later than a moment after: handed back
// without its own pause, a job waits out the rest of the limiter's window
// instead, up to 30 s. Then the busy job first, then the rest.
describe('A20 · a busy provider slows the AI queue and fails no job', () => {
  let harness: RelayHarness;
  let account: Account;
  let worker: ProcessHandle;

  const submit = async (sku: string) => {
    const { status, body } = await harness.submit(account, {
      type: 'ai.enrich',
      payload: { skus: [sku] },
      maxAttempts: 1,
    });

    expect(status).toBe(202);

    return body.data.id as string;
  };

  const lines = () =>
    worker.log.split('\n').flatMap((text) => {
      try {
        return [JSON.parse(text) as Line];
      } catch {
        return [];
      }
    });

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a20');

    await harness.prisma.product.createMany({
      data: ['Desk [llm:busy]', 'Chair', 'Lamp', 'Shelf'].map((name, n) => ({
        userId: account.id,
        sku: `SKU-${n}`,
        name,
        priceCents: 100,
        currency: 'EUR',
      })),
    });
  });

  afterAll(() => harness.stop());

  it('waits out the Retry-After, then runs every job on its one attempt', async () => {
    // Queued before the worker starts, the busy one first, so it is the job
    // that meets the 429 and the rest are behind it.
    const [busy, ...rest] = [
      await submit('SKU-0'),
      await submit('SKU-1'),
      await submit('SKU-2'),
      await submit('SKU-3'),
    ];

    // One at a time, so every start after the 429 is the queue's choice, and
    // a limit high enough that only the provider's pause holds anything back.
    // JSON lines, for the time of the 429.
    worker = harness.startWorker('worker', {
      NODE_ENV: 'production',
      AI_WORKER_CONCURRENCY: '1',
      AI_QUEUE_LIMIT_MAX: '100',
    });

    const done = await Promise.all(
      [busy, ...rest].map((jobId) =>
        harness.waitForJobStatus(jobId, ['SUCCEEDED', 'DEAD_LETTERED']),
      ),
    );

    expect(done.map(({ status, attempts }) => ({ status, attempts }))).toEqual(
      done.map(() => ({ status: 'SUCCEEDED', attempts: 1 })),
    );
    expect(
      (await harness.products(account.id)).map(
        ({ enrichmentStatus }) => enrichmentStatus,
      ),
    ).toEqual(['READY', 'READY', 'READY', 'READY']);

    const refusals = lines().filter(
      (line) => line.jobId === busy && /found a service busy/.test(line.msg),
    );

    expect(refusals).toHaveLength(1);

    // Each job's last claim, against the time of the 429. A tenth of the
    // pause as slack below: the pause is a key expiring in Redis, which
    // answers in its own time. Two seconds above, for a slow machine.
    const [busyStart, ...restStarts] = done.map(
      ({ startedAt }) => startedAt!.getTime() - refusals[0].time,
    );

    for (const start of [busyStart, ...restStarts]) {
      expect(start).toBeGreaterThanOrEqual(RETRY_AFTER_MS - 100);
      expect(start).toBeLessThan(RETRY_AFTER_MS + 2000);
    }

    // Back at the head of the queue, not behind the jobs that waited with it.
    expect(busyStart).toBeLessThan(Math.min(...restStarts));
  });
});

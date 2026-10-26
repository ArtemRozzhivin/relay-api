import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

// A5b — the queue can give up on a job without ever calling process() again.
// Past maxStalledCount it fails the job itself, so the row would stay RUNNING
// for ever if nothing listened for 'failed' with finishedOn set.
describe('A5b · a job the queue abandons still reaches a terminal state', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a5b');
  });

  afterAll(() => harness.stop());

  it('dead-letters with DELIVERY_ABANDONED below its own attempt budget', async () => {
    const { body } = await harness.submit(account, {
      type: 'MOCK',
      payload: { durationMs: 10_000, failureRate: 0 },
      maxAttempts: 5,
    });
    const jobId = body.data.id;

    // Two stalls: the first is redelivered, the second exceeds
    // maxStalledCount (1) and the queue stops trying.
    for (const attempt of [1, 2]) {
      const worker = harness.startWorker(`worker-${attempt}`);

      await harness.waitUntil(
        async () => {
          const job = await harness.job(jobId);

          return job?.status === 'RUNNING' && job.attempts === attempt
            ? true
            : undefined;
        },
        { timeoutMs: 120_000, label: `delivery ${attempt}` },
      );

      worker.sigkill();
      await harness.expireQueueLock(jobId);
    }

    const last = harness.startWorker('worker-3');

    const abandoned = await harness.waitForJobStatus(
      jobId,
      ['DEAD_LETTERED'],
      180_000,
    );

    expect(abandoned.attempts).toBe(2);
    expect(abandoned.attempts).toBeLessThan(5);
    expect((abandoned.error as { code: string }).code).toBe(
      'DELIVERY_ABANDONED',
    );
    expect(last.count(/the queue stopped redelivering it/)).toBe(1);

    // An abandoned job must still be recoverable, and the 202 alone does not
    // show that: the re-drive has to be delivered to a worker.
    const redriven = await harness.redrive(account, jobId);
    expect(redriven.status).toBe(202);

    const rerun = await harness.waitUntil(
      async () => {
        const job = await harness.job(jobId);

        return job && job.attempts >= 1 && job.status !== 'QUEUED'
          ? job
          : undefined;
      },
      { timeoutMs: 60_000, label: 'the re-driven job to be delivered' },
    );

    expect(['RUNNING', 'SUCCEEDED']).toContain(rerun.status);
    expect(await harness.queueEntry(jobId)).toBeDefined();
  });
});

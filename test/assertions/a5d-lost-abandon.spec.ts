import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

// A5d — A5b's abandonment, with the one step that is at-most-once taken away:
// the worker that hears the 'failed' event drops it, as one killed at that
// moment would. Only the sweep can finish the job now, and the logs say which
// of the two did — without that, the event path passing would look the same.
describe('A5d · an abandonment the failed event loses is still finalised', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a5d');
  });

  afterAll(() => harness.stop());

  it('dead-letters the stranded job from the sweep', async () => {
    const { body } = await harness.submit(account, {
      type: 'MOCK',
      payload: { durationMs: 10_000, failureRate: 0 },
      maxAttempts: 5,
    });
    const jobId = body.data.id;

    // The same two stalls as A5b: the second exceeds maxStalledCount (1).
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

    const last = harness.startWorker('worker-3', {
      RELAY_FAULT_SKIP_ABANDON: '1',
      RELAY_SWEEP_INTERVAL_MS: '2000',
    });

    const abandoned = await harness.waitForJobStatus(
      jobId,
      ['DEAD_LETTERED', 'SUCCEEDED', 'CANCELLED'],
      180_000,
    );

    expect(abandoned.status).toBe('DEAD_LETTERED');
    expect(abandoned.attempts).toBe(2);
    expect(abandoned.error).toMatchObject({
      code: 'DELIVERY_ABANDONED',
      message: expect.stringContaining('failed'),
    });
    // Scoped to this job: the worker sweeps every RUNNING row, and an earlier
    // file's job can be stranded in the same window for the same reason.
    // Waited for, not just counted: the worker logs after the write this test
    // saw, and its output arrives through a pipe.
    const swept = new RegExp(`Job ${jobId} dead-lettered by the sweep`);

    await harness.waitForLog(last, swept);
    expect(last.count(swept)).toBe(1);
    expect(
      last.count(new RegExp(`Job ${jobId} dead-lettered: the queue stopped`)),
    ).toBe(0);
  });
});

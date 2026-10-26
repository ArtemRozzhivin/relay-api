import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

// A5 — retries are bounded, the terminal state records why, and re-drive is
// guarded by the transition rather than by an if.
describe('A5 · a poison job dead-letters exactly once', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    account = await harness.signUp('a5');
  });

  afterAll(() => harness.stop());

  it('spends exactly three attempts, then records the reason', async () => {
    const { body } = await harness.submit(account, {
      type: 'MOCK',
      payload: { durationMs: 1, failureRate: 1 },
      maxAttempts: 3,
    });
    const jobId = body.data.id;

    const dead = await harness.waitForJobStatus(jobId, ['DEAD_LETTERED']);

    // attempts = 3 is itself the evidence of three deliveries, so there is no
    // need to also count log lines for it.
    expect(dead.attempts).toBe(3);
    expect((dead.error as { code: string }).code).toBe('ATTEMPTS_EXHAUSTED');
    expect(dead.finishedAt).not.toBeNull();
  });

  it('re-drives a dead job and refuses to re-drive a healthy one', async () => {
    const { body } = await harness.submit(account, {
      type: 'MOCK',
      payload: { durationMs: 1, failureRate: 1 },
      maxAttempts: 2,
    });
    const jobId = body.data.id;

    await harness.waitForJobStatus(jobId, ['DEAD_LETTERED']);

    const redriven = await harness.redrive(account, jobId);
    expect(redriven.status).toBe(202);
    expect(redriven.body.data.status).toBe('QUEUED');
    expect(redriven.body.data.attempts).toBe(0);

    // The 202 is not evidence the work was re-queued; only a fresh run is.
    const second = await harness.waitUntil(
      async () => {
        const job = await harness.job(jobId);

        return job?.status === 'DEAD_LETTERED' && job.attempts === 2
          ? job
          : undefined;
      },
      { label: 'the re-driven run to spend a fresh budget' },
    );
    expect(second.attempts).toBe(2);

    const healthy = await harness.submit(account, {
      type: 'MOCK',
      payload: { durationMs: 1, failureRate: 0 },
    });
    await harness.waitForJobStatus(healthy.body.data.id, ['SUCCEEDED']);

    const refused = await harness.redrive(account, healthy.body.data.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('JOB_NOT_DEAD_LETTERED');
  });
});

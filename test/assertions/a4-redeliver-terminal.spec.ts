import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

// A4 — the queue is at-least-once, so a job that already finished will be
// delivered again. claim()'s WHERE clause is the only thing that stops it, and
// a refusal must be a no-op rather than an error.
describe('A4 · redelivering a finished job does nothing', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    account = await harness.signUp('a4');
  });

  afterAll(() => harness.stop());

  it('refuses the claim, leaves the status terminal and writes no second effect', async () => {
    const { body } = await harness.submit(account, {
      type: 'CHARGE',
      payload: { amountCents: 500, reference: 'inv-a4' },
    });
    const jobId = body.data.id;

    const finished = await harness.waitForJobStatus(jobId, ['SUCCEEDED']);
    expect(await harness.sideEffects(account.id)).toHaveLength(1);

    // The queue entry reaching 'completed' is what proves the delivery was
    // really processed; a log line only shows which branch was taken, and the
    // pretty-print transport lags behind the database.
    const delivered = await harness.redeliver(jobId);

    await harness.waitUntil(
      async () => ((await delivered.getState()) === 'completed' ? true : undefined),
      { label: 'the duplicate delivery to be processed' },
    );

    const after = await harness.job(jobId);
    expect(after?.status).toBe('SUCCEEDED');
    expect(after?.attempts).toBe(finished.attempts);
    expect(after?.finishedAt?.getTime()).toBe(finished.finishedAt?.getTime());
    expect(await harness.sideEffects(account.id)).toHaveLength(1);
  });
});

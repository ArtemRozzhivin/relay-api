import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

// A1 — the guarantee is a unique constraint, not a check in application code,
// so the test has to race the submits rather than issue them in sequence.
describe('A1 · a duplicate submit creates one job', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    account = await harness.signUp('a1');
  });

  afterAll(() => harness.stop());

  it('collapses ten concurrent submits of one key into one job and one effect', async () => {
    const idempotencyKey = `a1-${Date.now()}`;

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        harness.submit(
          account,
          {
            type: 'CHARGE',
            payload: { amountCents: 1000, reference: 'inv-a1' },
          },
          idempotencyKey,
        ),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: 10 }, () => 202),
    );

    const returnedIds = new Set(
      responses.map((response) => response.body.data.id),
    );
    expect(returnedIds.size).toBe(1);

    const jobs = await harness.jobs(account.id);
    expect(jobs).toHaveLength(1);

    await harness.waitForJobStatus(jobs[0].id, [
      'SUCCEEDED',
      'DEAD_LETTERED',
    ]);

    expect(await harness.sideEffects(account.id)).toHaveLength(1);
  });
});

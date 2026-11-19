import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

// A3d — a charge whose money moved never ends CANCELLED. The owner cancels
// after the ledger row is in; the worker then dies, and the redelivery finds
// the cancel request first. Finishing the job as CANCELLED there would tell
// the owner nothing was charged. It must claim the job instead, find the
// charge, and finish it as the success it is.
describe('A3d · a cancel after the charge cannot make it CANCELLED', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a3d');
  });

  afterAll(() => harness.stop());

  it('finishes the job SUCCEEDED, deduplicated, with one ledger row', async () => {
    const { body } = await harness.submit(account, {
      type: 'CHARGE',
      payload: { amountCents: 1500, reference: 'inv-a3d', delayMs: 30_000 },
    });
    const jobId = body.data.id as string;
    const first = harness.startWorker('worker-1');

    // The charge is in and the handler is in its sleep after it.
    await harness.waitUntil(
      async () =>
        (await harness.sideEffects(account.id)).length === 1 ? true : undefined,
      { label: 'the ledger row' },
    );

    const cancel = await harness.cancel(account, jobId);

    expect(cancel.status).toBe(202);
    expect(cancel.body.data).toMatchObject({
      status: 'RUNNING',
      cancelRequested: true,
    });

    first.sigkill();
    harness.startWorker('worker-2');

    const done = await harness.waitForJobStatus(
      jobId,
      ['SUCCEEDED', 'CANCELLED', 'DEAD_LETTERED'],
      180_000,
    );

    expect(done).toMatchObject({
      status: 'SUCCEEDED',
      result: { charged: 1500, deduplicated: true },
    });
    expect(await harness.sideEffects(account.id)).toHaveLength(1);
  });
});

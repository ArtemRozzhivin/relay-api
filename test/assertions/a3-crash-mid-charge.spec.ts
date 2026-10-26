import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

const JOBS = 6;

// A3 — the headline test. The CHARGE handler writes its ledger row and then
// sleeps, so a SIGKILL during the sleep is a crash with the effect already
// committed: the redelivery must dedupe rather than charge again.
describe('A3 · a worker killed mid-charge charges exactly once', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a3');
  });

  afterAll(() => harness.stop());

  it('redelivers every interrupted job and leaves one ledger row each', async () => {
    for (let i = 0; i < JOBS; i += 1) {
      const { status } = await harness.submit(account, {
        type: 'CHARGE',
        payload: {
          amountCents: 1000,
          reference: `inv-${i}`,
          delayMs: 10_000,
        },
      });

      expect(status).toBe(202);
    }

    const first = harness.startWorker('worker-1', {
      WORKER_CONCURRENCY: String(JOBS),
    });

    // Waiting for the condition rather than sleeping is what makes the kill
    // deterministic: every job is provably mid-charge before the process dies,
    // so this can never pass without exercising a redelivery.
    await harness.waitForCount(account.id, { status: 'RUNNING' }, JOBS);

    const ledgerAtKill = await harness.sideEffects(account.id);
    expect(ledgerAtKill).toHaveLength(JOBS);

    first.sigkill();

    harness.startWorker('worker-2', { WORKER_CONCURRENCY: String(JOBS) });

    await harness.waitForDrain(account.id, 180_000);

    expect(await harness.countByStatus(account.id, 'SUCCEEDED')).toBe(JOBS);
    expect(await harness.sideEffects(account.id)).toHaveLength(JOBS);
  });
});

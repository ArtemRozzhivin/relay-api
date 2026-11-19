import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

const JOBS = 12;

// A2 — the baseline the rest of §14 refines: nothing submitted is left behind.
describe('A2 · no lost work', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    account = await harness.signUp('a2');
  });

  afterAll(() => harness.stop());

  it('drains every submitted job to a terminal state', async () => {
    for (let i = 0; i < JOBS; i += 1) {
      const { status } = await harness.submit(account, {
        type: 'MOCK',
        payload: { durationMs: 50, failureRate: 0 },
      });

      expect(status).toBe(202);
    }

    await harness.waitForDrain(account.id);

    expect(await harness.countByStatus(account.id, 'SUCCEEDED')).toBe(JOBS);
    expect(await harness.countByStatus(account.id, 'QUEUED')).toBe(0);
    expect(await harness.countByStatus(account.id, 'RUNNING')).toBe(0);
  });
});

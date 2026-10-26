import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

const JOBS = 6;

// A3b — the case a crash test cannot reach. The first worker is never killed:
// it is frozen until its lock expires, then thawed, so two live processes each
// believe they own the same job. Only the attempts predicate separates them.
describe('A3b · a stale worker cannot overwrite the live one', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a3b');
  });

  afterAll(() => harness.stop());

  it('refuses every write from the attempt that lost ownership', async () => {
    const jobIds: string[] = [];

    for (let i = 0; i < JOBS; i += 1) {
      const { body } = await harness.submit(account, {
        type: 'MOCK',
        payload: { durationMs: 10_000, failureRate: 0 },
      });

      jobIds.push(body.data.id);
    }

    const stale = harness.startWorker('stale', {
      WORKER_CONCURRENCY: String(JOBS),
    });

    await harness.waitForCount(account.id, { status: 'RUNNING' }, JOBS);

    // Frozen, not killed: the process keeps its in-memory state and will try to
    // finish its handlers when thawed.
    stale.freeze();

    for (const jobId of jobIds) {
      await harness.expireQueueLock(jobId);
    }

    harness.startWorker('live', { WORKER_CONCURRENCY: String(JOBS) });

    // The live worker takes over through the stalled checker, which is what
    // bumps attempts to 2 and invalidates the frozen worker's token. The
    // condition is `attempts >= 2` and not `RUNNING with attempts = 2`: jobs are
    // reclaimed one at a time, so the early ones can finish before the last is
    // taken over and the instantaneous version may never hold for all six.
    await harness.waitForCount(
      account.id,
      { attempts: { gte: 2 } },
      JOBS,
      180_000,
    );

    stale.thaw();

    // The frozen worker's writes land after the thaw, so the count has to be
    // waited for; asserting immediately would measure before it had tried.
    await harness.waitUntil(
      async () => (stale.count(/no longer owns it/) === JOBS ? true : undefined),
      { label: `${JOBS} refused writes from the stale worker` },
    );

    await harness.waitForDrain(account.id, 180_000);

    expect(stale.count(/no longer owns it/)).toBe(JOBS);
    expect(await harness.countByStatus(account.id, 'SUCCEEDED')).toBe(JOBS);
    expect(await harness.countByStatus(account.id, 'RUNNING')).toBe(0);
    expect(await harness.countByStatus(account.id, 'QUEUED')).toBe(0);
  });
});

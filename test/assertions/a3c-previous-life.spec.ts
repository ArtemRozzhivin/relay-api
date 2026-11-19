import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

// A3c — A3b across a re-drive. A worker frozen holding a job's first claim
// wakes after the job has died, been re-driven and been claimed again — also as
// attempt 1, because a re-drive resets the budget. When the attempt number was
// the token, its writes matched the new life and landed; the lease never
// repeats, so they must be refused.
describe("A3c · a worker from a job's previous life cannot write over its next", () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a3c');
  });

  afterAll(() => harness.stop());

  it("refuses the stale worker's finish and lets the new life finish", async () => {
    const { body } = await harness.submit(account, {
      type: 'MOCK',
      payload: { durationMs: 20_000, failureRate: 0 },
      maxAttempts: 5,
    });
    const jobId = body.data.id;

    const runningAs = (attempts: number, label: string) =>
      harness.waitUntil(
        async () => {
          const job = await harness.job(jobId);

          return job?.status === 'RUNNING' && job.attempts === attempts
            ? job
            : undefined;
        },
        { timeoutMs: 120_000, label },
      );

    // Life 1, claim 1: the worker that will come back.
    const stale = harness.startWorker('stale');
    await runningAs(1, 'the first claim');

    stale.freeze();
    await harness.expireQueueLock(jobId);

    // Life 1, claim 2, then killed: the second stall exceeds maxStalledCount
    // and the queue abandons the job (A5b).
    const second = harness.startWorker('second');
    await runningAs(2, 'the second claim');
    second.sigkill();
    await harness.expireQueueLock(jobId);

    harness.startWorker('live');
    const dead = await harness.waitForJobStatus(
      jobId,
      ['DEAD_LETTERED'],
      180_000,
    );
    expect(dead.error).toMatchObject({ code: 'DELIVERY_ABANDONED' });

    // Life 2: the same attempt number the frozen worker holds.
    expect((await harness.redrive(account, jobId)).status).toBe(202);
    await runningAs(1, 'the re-driven claim');

    stale.thaw();

    // Its sleep ran out while it was frozen, so it finishes at once — and must
    // be told it no longer owns the job, rather than finishing the new life.
    const refused = new RegExp(
      `Job ${jobId} finished on attempt 1 but that attempt no longer owns it`,
    );

    await harness.waitUntil(
      async () => (stale.count(refused) === 1 ? true : undefined),
      { label: "the stale worker's refused finish" },
    );

    expect((await harness.job(jobId))?.status).toBe('RUNNING');

    const finished = await harness.waitForJobStatus(
      jobId,
      ['SUCCEEDED', 'DEAD_LETTERED', 'CANCELLED'],
      120_000,
    );

    expect(finished).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
      lease: 3,
    });
  });
});

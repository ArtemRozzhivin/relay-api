import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';
import type { DeadLetterCode } from '../../src/jobs/job-error-codes.js';
import { seedJob } from '../support/db.js';

// A5c — the dead-letter family's third case: a filtered bulk re-drive revives
// exactly the matching dead letters, and they actually run. Process-level
// because the bulk path, unlike the single re-drive, never enqueues anything
// itself — it commits outbox rows and the relay publishes them, so the claim
// "they run" is only proven by a real worker picking them up.
describe('A5c · a filtered bulk re-drive revives exactly the matching dead letters', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    account = await harness.signUp('a5c');
  });

  afterAll(() => harness.stop());

  // Written directly: how a job dies is A5 and A5b's subject, not this one's.
  // The payload succeeds, so a re-driven job can show that it ran.
  const deadLetter = async (code: DeadLetterCode) => {
    const job = await seedJob(harness.prisma, {
      userId: account.id,
      payload: { durationMs: 10 },
      status: 'DEAD_LETTERED',
      attempts: 3,
      error: { code, message: 'it died', attempt: 3 },
      finishedAt: new Date(),
    });

    return job.id;
  };

  it('runs every match exactly once, in bounded batches, and leaves the rest dead', async () => {
    const matching = [
      await deadLetter('DELIVERY_ABANDONED'),
      await deadLetter('DELIVERY_ABANDONED'),
      await deadLetter('DELIVERY_ABANDONED'),
    ];
    const others = [
      await deadLetter('ATTEMPTS_EXHAUSTED'),
      await deadLetter('ATTEMPTS_EXHAUSTED'),
    ];

    const filter = { errorCode: 'DELIVERY_ABANDONED', limit: 2 };

    // The loop an operator runs: call until nothing remains.
    const first = await harness.redriveMatching(account, filter);
    expect(first.status).toBe(202);
    expect(first.body.data).toEqual({ redriven: 2, remaining: 1 });

    const second = await harness.redriveMatching(account, filter);
    expect(second.body.data).toEqual({ redriven: 1, remaining: 0 });

    for (const jobId of matching) {
      const done = await harness.waitForJobStatus(jobId, [
        'SUCCEEDED',
        'DEAD_LETTERED',
      ]);

      // Ran, and ran once: the re-drive reset the counter to 0.
      expect(done).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });

      // Published by the relay and not by the API: only the relay increments
      // the outbox row's attempts when it marks the row published.
      const [entry] = await harness.outbox(jobId);
      expect(entry).toMatchObject({ attempts: 1 });
      expect(entry.publishedAt).not.toBeNull();
    }

    for (const jobId of others) {
      expect(await harness.job(jobId)).toMatchObject({
        status: 'DEAD_LETTERED',
        attempts: 3,
      });
      expect(await harness.outbox(jobId)).toHaveLength(0);
    }
  });
});

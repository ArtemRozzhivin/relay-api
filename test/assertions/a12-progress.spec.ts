import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';
import { readProgress } from '../../src/jobs/job-progress.js';

const JOBS = 3;
const STEPS = 20;

// A12 — progress cannot go backwards or be forged. The guard is a jsonb
// predicate plus the ownership token, and the case it exists for needs two live
// workers: the frozen one resumes mid-job and keeps reporting a count the row is
// already past, under an attempt number that has moved on.
describe('A12 · progress is monotonic and cannot be written by a stale attempt', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a12');
  });

  afterAll(() => harness.stop());

  it('refuses the stale attempt and never lets a count decrease', async () => {
    const jobIds: string[] = [];

    for (let i = 0; i < JOBS; i += 1) {
      const { body } = await harness.submit(account, {
        type: 'MOCK',
        payload: { durationMs: 20_000, steps: STEPS },
      });

      jobIds.push(body.data.id);
    }

    // Every distinct count ever observed per job. A write only lands when it is
    // strictly greater than the stored one, so this series must be ascending —
    // sampling can miss a value but can never legitimately see a decrease.
    const series = new Map<string, number[]>();
    let sampling = true;

    const sampler = (async () => {
      while (sampling) {
        for (const job of await harness.jobs(account.id)) {
          const { processed } = readProgress(job.progress);

          if (processed === undefined) {
            continue;
          }

          const seen = series.get(job.id) ?? [];

          if (seen.at(-1) !== processed) {
            seen.push(processed);
            series.set(job.id, seen);
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();

    const stale = harness.startWorker('stale', {
      WORKER_CONCURRENCY: String(JOBS),
    });

    // Not just RUNNING: the frozen worker has to have reported something, or
    // there is no earlier count for its stale writes to collide with.
    await harness.waitForCount(
      account.id,
      { progress: { path: ['processed'], gte: 2 } },
      JOBS,
      120_000,
    );

    const beforeFreeze = await Promise.all(
      jobIds.map(
        async (jobId) =>
          readProgress((await harness.job(jobId))?.progress ?? null).processed,
      ),
    );

    // Frozen, not killed: it keeps its loop counter and resumes reporting from
    // where it stopped, which is the whole point.
    stale.freeze();

    for (const jobId of jobIds) {
      await harness.expireQueueLock(jobId);
    }

    harness.startWorker('live', { WORKER_CONCURRENCY: String(JOBS) });

    await harness.waitForCount(
      account.id,
      { attempts: { gte: 2 } },
      JOBS,
      180_000,
    );

    stale.thaw();

    await harness.waitUntil(
      async () =>
        stale.count(/progress write refused/) >= JOBS ? true : undefined,
      { label: `${JOBS} refused progress writes from the stale worker` },
    );

    await harness.waitForDrain(account.id, 240_000);

    sampling = false;
    await sampler;

    for (const [index, jobId] of jobIds.entries()) {
      const observed = series.get(jobId) ?? [];

      expect(observed, `progress series for ${jobId}`).toEqual(
        [...observed].sort((a, b) => a - b),
      );
      expect(new Set(observed).size).toBe(observed.length);
      expect(observed.at(-1)).toBeGreaterThanOrEqual(beforeFreeze[index] ?? 0);
    }

    expect(await harness.countByStatus(account.id, 'SUCCEEDED')).toBe(JOBS);

    // The handler reports without awaiting, so the last report is still queued
    // when it returns. Every job must still finish showing its final step: that
    // is the processor flushing the context before it transitions the job.
    for (const jobId of jobIds) {
      const { processed, total } = readProgress(
        (await harness.job(jobId))?.progress ?? null,
      );

      expect({ processed, total }).toEqual({ processed: STEPS, total: STEPS });
    }
  });
});

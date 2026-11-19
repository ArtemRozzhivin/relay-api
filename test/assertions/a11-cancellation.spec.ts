import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';
import { readProgress } from '../../src/jobs/job-progress.js';

// A11 — a cancelled job stops at a safe point, and a cancel never strands a
// job. Process-level, because the interesting cases are races between an HTTP
// request in one process and a handler mid-step in another.
//
// "Effects committed" is read through progress here: a MOCK step's only
// observable effect is its report, and the processor flushes before every
// transition, so the stored count is exactly the steps that finished. The
// ledger-count form of A11 needs a handler with batched effects, which is the
// CSV import (PB).
describe('A11 · a cancelled job stops at a safe point', () => {
  describe('before any worker is running', () => {
    let harness: RelayHarness;
    let account: Account;

    beforeAll(async () => {
      harness = await RelayHarness.create();
      await harness.startApi();
      account = await harness.signUp('a11q');
    });

    afterAll(() => harness.stop());

    it('finishes a queued job on the spot, and no worker ever runs it', async () => {
      const { body } = await harness.submit(account, {
        type: 'MOCK',
        payload: { durationMs: 10 },
      });
      const cancelledId = body.data.id;

      const { status, body: cancelled } = await harness.cancel(
        account,
        cancelledId,
      );

      expect(status).toBe(202);
      expect(cancelled.data).toMatchObject({
        status: 'CANCELLED',
        attempts: 0,
      });

      // Prove the worker is consuming before asserting it left the cancelled
      // job alone — otherwise "never claimed" would only mean "not yet".
      harness.startWorker();

      const { body: control } = await harness.submit(account, {
        type: 'MOCK',
        payload: { durationMs: 10 },
      });

      await harness.waitForJobStatus(control.data.id, ['SUCCEEDED']);

      expect(await harness.job(cancelledId)).toMatchObject({
        status: 'CANCELLED',
        attempts: 0,
        startedAt: null,
      });
    });
  });

  describe('with a worker running', () => {
    let harness: RelayHarness;
    let account: Account;

    beforeAll(async () => {
      harness = await RelayHarness.create();
      await harness.startApi();
      harness.startWorker();
      account = await harness.signUp('a11r');
    });

    afterAll(() => harness.stop());

    it('stops a running job at the next boundary, not mid-step', async () => {
      const STEPS = 10;

      const { body } = await harness.submit(account, {
        type: 'MOCK',
        payload: { durationMs: 10_000, steps: STEPS },
      });
      const jobId = body.data.id;

      // Mid-flight, with work behind it and work ahead of it.
      await harness.waitUntil(
        async () => {
          const { processed } = readProgress(
            (await harness.job(jobId))?.progress ?? null,
          );

          return processed !== undefined && processed >= 2 ? true : undefined;
        },
        { timeoutMs: 30_000, label: 'the job to finish two steps' },
      );

      const { status, body: requested } = await harness.cancel(account, jobId);

      // The API only asks: the handler is mid-step, so the job is still running.
      expect(status).toBe(202);
      expect(requested.data).toMatchObject({
        status: 'RUNNING',
        cancelRequested: true,
      });

      const atRequest = readProgress(requested.data.progress).processed ?? 0;

      const finished = await harness.waitForJobStatus(jobId, [
        'CANCELLED',
        'SUCCEEDED',
        'DEAD_LETTERED',
      ]);
      const stoppedAt = readProgress(finished.progress).processed ?? 0;

      expect(finished.status).toBe('CANCELLED');
      expect(finished.attempts).toBe(1);

      // The step in progress when the request landed finishes; the next one
      // never starts. Measured against the row, that is up to two steps past
      // what the request saw, not one: the handler reports without awaiting,
      // so the row can lag it by one write still in flight when the cancel
      // commits.
      expect(stoppedAt).toBeGreaterThanOrEqual(atRequest);
      expect(stoppedAt).toBeLessThanOrEqual(atRequest + 2);
      expect(stoppedAt).toBeLessThan(STEPS);
    });

    it('never strands a job whose handler fails after the request', async () => {
      // One step, so the handler never checks — it sleeps, then fails. The
      // failure would normally schedule a retry; the retry must cancel the job
      // instead of running the handler a second time.
      const { body } = await harness.submit(account, {
        type: 'MOCK',
        payload: { durationMs: 3000, failureRate: 1 },
        maxAttempts: 5,
      });
      const jobId = body.data.id;

      await harness.waitForJobStatus(jobId, ['RUNNING']);

      const { body: requested } = await harness.cancel(account, jobId);

      expect(requested.data.cancelRequested).toBe(true);

      const finished = await harness.waitForJobStatus(
        jobId,
        ['CANCELLED', 'SUCCEEDED', 'DEAD_LETTERED'],
        30_000,
      );

      expect(finished.status).toBe('CANCELLED');

      // The redelivery was finished before it was claimed, so the counter never
      // moved past the attempt that failed.
      expect(finished.attempts).toBe(1);
      expect(finished.error).toMatchObject({ code: 'ATTEMPT_FAILED' });
    });

    it('refuses a finished job and leaves it exactly as it was', async () => {
      const { body } = await harness.submit(account, {
        type: 'MOCK',
        payload: { durationMs: 10 },
      });
      const jobId = body.data.id;

      const before = await harness.waitForJobStatus(jobId, ['SUCCEEDED']);

      const { status, body: answered } = await harness.cancel(account, jobId);

      // Too late, and the code says so: the job did everything it was going to.
      expect(status).toBe(409);
      expect(answered.error.code).toBe('JOB_ALREADY_FINISHED');

      // A no-op, not a status change — and not even a flag, since nothing was
      // left for the request to stop.
      expect(await harness.job(jobId)).toMatchObject({
        status: 'SUCCEEDED',
        cancelRequested: false,
        finishedAt: before.finishedAt,
      });
    });
  });
});

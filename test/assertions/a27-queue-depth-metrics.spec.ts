import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  freePort,
  RelayHarness,
  type Account,
  type ProcessHandle,
} from '../harness/relay-harness.js';
import { samples, sum, type Labels } from '../support/metrics.js';

// A27 — the backlog can be watched from outside: with no worker running,
// submitted jobs show up in the API's queue depth, and once a worker starts
// the depth falls back while the worker counts the attempts it ran. Read the
// way Prometheus reads it, over each process's own metrics port.

const JOBS = 20;

describe('A27 · queue depth rises and drains, as /metrics shows it', () => {
  let harness: RelayHarness;
  let account: Account;
  let apiMetrics: string;
  let workerPort: number;
  let workerMetrics: string;
  let worker: ProcessHandle | undefined;

  const scrape = async (url: string) => {
    const response = await fetch(url);

    expect(response.status).toBe(200);

    return response.text();
  };

  // Every job not yet finished, wherever it waits.
  const backlog = async () =>
    sum(
      samples(await scrape(apiMetrics), 'relay_queue_depth', { role: 'api' }),
    );

  // Attempts the worker has timed. It records one just after writing the
  // job's outcome, so a test waits for the count rather than reading it once.
  const attempts = async (labels: Labels) =>
    sum(
      samples(
        await scrape(workerMetrics),
        'relay_job_attempt_duration_seconds_count',
        { role: 'worker', ...labels },
      ),
    );

  // Started by the first test that needs it, so the first can watch the
  // backlog grow with none running, and a later one does not depend on it.
  const startWorker = () => {
    worker ??= harness.startWorker('worker', {
      METRICS_PORT: String(workerPort),
    });
  };

  const deadLetters = async () =>
    sum(
      samples(await scrape(apiMetrics), 'relay_dead_letters', {
        type: 'MOCK',
      }),
    );

  beforeAll(async () => {
    harness = await RelayHarness.create();

    const apiPort = await freePort();

    workerPort = await freePort();

    apiMetrics = `http://localhost:${apiPort}/metrics`;
    workerMetrics = `http://localhost:${workerPort}/metrics`;

    await harness.startApi({ METRICS_PORT: String(apiPort) });
    account = await harness.signUp('a27');
  });

  afterAll(() => harness.stop());

  it('shows the backlog grow with no worker and empty once one runs', async () => {
    // What earlier files left in the queue is in the reading too, so the
    // rise is measured from here.
    const before = await backlog();

    for (let i = 0; i < JOBS; i += 1) {
      const { status } = await harness.submit(account, {
        type: 'MOCK',
        payload: { durationMs: 100 },
      });

      expect(status).toBe(202);
    }

    await harness.waitUntil(
      async () => ((await backlog()) >= before + JOBS ? true : undefined),
      { timeoutMs: 15_000, label: `the backlog to rise by ${JOBS}` },
    );

    startWorker();
    await harness.waitForDrain(account.id);

    // Back to at most where it started: the worker may also have finished
    // what was already waiting.
    await harness.waitUntil(
      async () => ((await backlog()) <= before ? true : undefined),
      { timeoutMs: 15_000, label: 'the backlog to drain' },
    );

    await harness.waitUntil(
      async () =>
        (await attempts({ type: 'MOCK', outcome: 'succeeded' })) >= JOBS
          ? true
          : undefined,
      { timeoutMs: 10_000, label: `the worker to count ${JOBS} attempts` },
    );
  });

  it('counts a dead letter in the API and its attempt in the worker', async () => {
    startWorker();

    const before = await deadLetters();

    const { body } = await harness.submit(account, {
      type: 'MOCK',
      payload: { durationMs: 10, failureRate: 1 },
      maxAttempts: 1,
    });

    const job = await harness.waitForJobStatus(body.data.id, ['DEAD_LETTERED']);

    expect(job.status).toBe('DEAD_LETTERED');
    expect(await deadLetters()).toBeGreaterThanOrEqual(before + 1);

    await harness.waitUntil(
      async () =>
        (await attempts({ type: 'MOCK', outcome: 'dead_lettered' })) >= 1
          ? true
          : undefined,
      { timeoutMs: 10_000, label: 'the worker to count the failed attempt' },
    );
  });

  it("labels each process's own runtime metrics with its role", async () => {
    const lag = 'nodejs_eventloop_lag_seconds';

    startWorker();
    await harness.waitUntil(
      async () =>
        (await fetch(workerMetrics).catch(() => undefined))?.ok
          ? true
          : undefined,
      { timeoutMs: 30_000, label: "the worker's metrics port" },
    );

    expect(
      samples(await scrape(apiMetrics), lag, { role: 'api' }),
    ).toHaveLength(1);
    expect(
      samples(await scrape(workerMetrics), lag, { role: 'worker' }),
    ).toHaveLength(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type JobEvent,
} from '../harness/relay-harness.js';
import { readProgress } from '../../src/jobs/job-progress.js';
import { REPORT_WINDOW_MS } from '../../src/jobs/job-context.factory.js';

// A12b — the throttle's two halves, end to end rather than against fake
// timers: a handler reporting far faster than the window must not flood the
// socket, and the value a client is left looking at must still be the exact
// final one.
describe('A12b · progress is rate-limited but never loses its last value', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    account = await harness.signUp('a12b');
  });

  afterAll(() => harness.stop());

  it('coalesces a report per 50ms into a handful of events', async () => {
    const socket = await harness.connectEvents(account.token);

    const seen: JobEvent[] = [];
    socket.on('job.updated', (job: JobEvent) => seen.push(job));

    const STEPS = 60;

    const { body } = await harness.submit(account, {
      type: 'MOCK',
      payload: { durationMs: 3000, steps: STEPS },
    });
    const jobId = body.data.id;

    const terminal = await harness.waitForJobStatus(jobId, [
      'SUCCEEDED',
      'DEAD_LETTERED',
    ]);
    expect(terminal.status).toBe('SUCCEEDED');

    // The socket is best-effort, so the last event may still be in flight.
    await harness.waitUntil(
      async () =>
        seen.some((job) => job.id === jobId && job.status === 'SUCCEEDED')
          ? true
          : undefined,
      { timeoutMs: 10_000, label: 'the terminal event' },
    );

    const withProgress = seen.filter(
      (job) => job.id === jobId && job.progress !== undefined,
    );

    // 60 reports across 3s is one per 50ms. At one window per 500ms that is
    // around 7 events, plus the flush; the bound is loose because scheduling is
    // not exact, but it is nowhere near 60.
    expect(withProgress.length).toBeGreaterThan(1);
    expect(withProgress.length).toBeLessThan(20);

    // Whatever was coalesced away, the stored value is the last one reported.
    expect(readProgress(terminal.progress)).toEqual({
      processed: STEPS,
      total: STEPS,
    });
  });

  it('keeps the final value exact when every report lands in one window', async ({
    skip,
  }) => {
    const STEPS = 100;

    const { body } = await harness.submit(account, {
      type: 'MOCK',
      payload: { durationMs: 0, steps: STEPS },
    });

    const terminal = await harness.waitForJobStatus(body.data.id, [
      'SUCCEEDED',
      'DEAD_LETTERED',
    ]);

    // 100 reports as fast as the handler can make them — about 200 ms, since
    // each step reads the row for shouldStop() — so all but the first land
    // inside one window and only the processor's flush gets the last one out.
    expect(terminal.status).toBe('SUCCEEDED');
    expect(readProgress(terminal.progress)).toEqual({
      processed: STEPS,
      total: STEPS,
    });

    // The window opens after the claim and the first write, and the job
    // finished after the flush. Inside one window, then, the window's timer
    // never fired, and the flush is the only thing that can have written the
    // last value. Any slower, and the timer may have written it instead: the
    // value proves nothing about the flush, so the case is inconclusive
    // rather than passed.
    const ranMs =
      terminal.finishedAt!.getTime() - terminal.startedAt!.getTime();

    skip(
      ranMs >= REPORT_WINDOW_MS,
      `inconclusive: the job ran ${ranMs} ms, past the ${REPORT_WINDOW_MS} ms window, so the timer may have sent the last value`,
    );
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { RelayHarness, type Account } from '../harness/relay-harness.js';
import { readProgress } from '../../src/jobs/job-progress.js';

interface JobEvent {
  id: string;
  status: string;
  progress?: unknown;
}

const connect = (baseUrl: string, token: string) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = io(`${baseUrl}/events`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });

    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });

// A12b — the throttle's two halves, end to end rather than against fake
// timers: a handler reporting far faster than the window must not flood the
// socket, and the value a client is left looking at must still be the exact
// final one.
describe('A12b · progress is rate-limited but never loses its last value', () => {
  let harness: RelayHarness;
  let account: Account;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    account = await harness.signUp('a12b');
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.close();
    }

    await harness.stop();
  });

  it('coalesces a report per 50ms into a handful of events', async () => {
    const socket = await connect(harness.baseUrl, account.token);
    sockets.push(socket);

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

  it('keeps the final value exact when every report lands in one window', async () => {
    const STEPS = 100;

    const { body } = await harness.submit(account, {
      type: 'MOCK',
      payload: { durationMs: 0, steps: STEPS },
    });

    const terminal = await harness.waitForJobStatus(body.data.id, [
      'SUCCEEDED',
      'DEAD_LETTERED',
    ]);

    // 100 reports inside a millisecond: all but the first are held, and only
    // the processor's flush gets the last one out before the job finishes.
    expect(terminal.status).toBe('SUCCEEDED');
    expect(readProgress(terminal.progress)).toEqual({
      processed: STEPS,
      total: STEPS,
    });
  });
});

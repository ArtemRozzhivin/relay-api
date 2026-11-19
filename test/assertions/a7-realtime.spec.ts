import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type JobEvent,
} from '../harness/relay-harness.js';

// A7 — the realtime contract, including the half that is a deliberate loss:
// pub/sub is at-most-once, so an event sent while a client is away is gone and
// the client's recovery is to re-read the job.
describe('A7 · realtime delivery and reconciliation', () => {
  let harness: RelayHarness;
  let userA: Account;
  let userB: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    userA = await harness.signUp('a7a');
    userB = await harness.signUp('a7b');
  });

  afterAll(() => harness.stop());

  it.each([
    ['no token', undefined],
    ['a forged token', 'not.a.jwt'],
  ])('refuses %s at the handshake', async (_label, token) => {
    await expect(harness.connectEvents(token)).rejects.toThrow(/unauthorized/);
  });

  it('delivers a tenant its own events, loses the ones it is away for, and reconciles', async () => {
    const socketA = await harness.connectEvents(userA.token);
    const socketB = await harness.connectEvents(userB.token);

    const seenA: JobEvent[] = [];
    const seenB: JobEvent[] = [];
    socketA.on('job.updated', (job: JobEvent) => seenA.push(job));
    socketB.on('job.updated', (job: JobEvent) => seenB.push(job));

    const { body } = await harness.submit(userA, {
      type: 'MOCK',
      payload: { durationMs: 8000, failureRate: 0 },
    });
    const jobId = body.data.id;

    const sawStatus = (events: JobEvent[], status: string, timeoutMs: number) =>
      harness.waitUntil(
        async () =>
          events.find((job) => job.id === jobId && job.status === status),
        { timeoutMs, label: `a ${status} event for ${jobId}` },
      );

    await sawStatus(seenA, 'QUEUED', 10_000);

    // The worker writes this one, so receiving it is the whole point of D8:
    // it proves the Redis bridge carried it into the API process.
    await sawStatus(seenA, 'RUNNING', 30_000);

    expect(seenB.filter((job) => job.id === jobId)).toHaveLength(0);

    socketA.close();
    const deliveredBeforeClose = seenA.length;

    const terminal = await harness.waitForJobStatus(jobId, [
      'SUCCEEDED',
      'DEAD_LETTERED',
    ]);
    expect(terminal.status).toBe('SUCCEEDED');

    const reconnected = await harness.connectEvents(userA.token);

    const replayed: JobEvent[] = [];
    reconnected.on('job.updated', (job: JobEvent) => replayed.push(job));
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(seenA).toHaveLength(deliveredBeforeClose);
    expect(replayed.filter((job) => job.id === jobId)).toHaveLength(0);

    const reconciled = await harness.fetchJob(userA, jobId);
    expect(reconciled.body.data.status).toBe('SUCCEEDED');
  });
});

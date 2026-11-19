import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type ProcessHandle,
} from '../harness/relay-harness.js';

interface Line {
  process: string;
  time: number;
  msg: string;
  context?: string;
  correlationId?: string;
  jobId?: string;
  jobType?: string;
  attempt?: number;
  req?: { method: string; url: string };
  res?: { statusCode: number };
}

// A28 — a job's whole story is in the logs under its correlationId alone
// (§12.1): the request that queued it in the API's log, then every attempt and
// how it ended in the worker's, whichever class wrote the line. The id is the
// request's, so a client that sent X-Request-Id can quote it.
describe("A28 · a correlationId finds a job's story across both processes", () => {
  let harness: RelayHarness;
  let account: Account;
  let processes: ProcessHandle[];

  // Every JSON line both processes wrote, in the order they were written.
  const lines = () =>
    processes
      .flatMap((handle) =>
        handle.log.split('\n').flatMap((text) => {
          try {
            return [{ ...JSON.parse(text), process: handle.name } as Line];
          } catch {
            return [];
          }
        }),
      )
      .sort((a, b) => a.time - b.time);

  const under = (correlationId: string) =>
    lines().filter((line) => line.correlationId === correlationId);

  // The lines are written as things happen, a moment after the row changes.
  const waitForLine = (correlationId: string, pattern: RegExp) =>
    harness.waitUntil(
      async () =>
        under(correlationId).some((line) => pattern.test(line.msg))
          ? true
          : undefined,
      { timeoutMs: 10_000, label: `a line matching ${pattern}` },
    );

  // Sent with the caller's own request id, which the API adopts.
  const send = (path: string, requestId: string, body?: unknown) =>
    harness.request(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.token}`,
        'Idempotency-Key': randomUUID(),
        'X-Request-Id': requestId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    harness = await RelayHarness.create();
    // Production's format, one JSON object a line, as a log store reads it.
    const api = await harness.startApi({ NODE_ENV: 'production' });
    const worker = harness.startWorker('worker', { NODE_ENV: 'production' });

    processes = [api, worker];
    account = await harness.signUp('a28');
  });

  afterAll(() => harness.stop());

  let jobId: string;
  const submitted = `a28-submit-${randomUUID()}`;

  it('finds the submit, every attempt and the dead letter under the submit’s id', async () => {
    const { status, body } = await send('/jobs', submitted, {
      type: 'MOCK',
      payload: { durationMs: 1, failureRate: 1 },
      maxAttempts: 2,
    });

    expect(status).toBe(202);
    jobId = body.data.id;

    await harness.waitForJobStatus(jobId, ['DEAD_LETTERED']);
    await waitForLine(submitted, /dead-lettered after 2 attempt/);

    const story = under(submitted);

    expect(story.filter((line) => line.process === 'api')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msg: `Enqueued job ${jobId} (MOCK)` }),
        expect.objectContaining({
          msg: 'request completed',
          req: expect.objectContaining({ method: 'POST', url: '/jobs' }),
          res: expect.objectContaining({ statusCode: 202 }),
        }),
      ]),
    );

    const worker = story.filter((line) => line.process === 'worker');

    // Whichever class wrote it, the processor or the handler, each line names
    // the job and its type.
    expect(
      worker.filter((line) => line.jobId !== jobId || line.jobType !== 'MOCK'),
    ).toEqual([]);

    // One process, so its lines are in the order it wrote them.
    expect(
      worker.map(({ context, attempt, msg }) => [context, attempt, msg]),
    ).toEqual([
      ['JobsProcessor', 1, `Running job ${jobId} (MOCK) attempt 1/2`],
      ['JobHandler', 1, expect.stringContaining('sleeping')],
      [
        'JobsProcessor',
        1,
        expect.stringMatching(/attempt 1\/2 failed, will retry: .*on purpose$/),
      ],
      ['JobsProcessor', 2, `Running job ${jobId} (MOCK) attempt 2/2`],
      ['JobHandler', 2, expect.stringContaining('sleeping')],
      [
        'JobsProcessor',
        2,
        expect.stringMatching(
          /dead-lettered after 2 attempt\(s\): .*on purpose$/,
        ),
      ],
    ]);
  });

  it('logs nothing about the job without its correlationId', () => {
    const missing = lines().filter(
      (line) =>
        (line.jobId === jobId || line.msg.includes(jobId)) &&
        line.correlationId !== submitted,
    );

    expect(missing).toEqual([]);
  });

  // A re-drive is a request of its own: the runs it starts carry its id, and
  // the job's id joins them to the first.
  it('finds a re-drive under its own id, not the submit’s', async () => {
    const before = under(submitted).length;
    const redriven = `a28-redrive-${randomUUID()}`;

    expect((await send(`/jobs/${jobId}/retry`, redriven)).status).toBe(202);

    await harness.waitUntil(
      async () =>
        (await harness.job(jobId))?.status === 'DEAD_LETTERED' &&
        under(redriven).some((line) => /dead-lettered/.test(line.msg))
          ? true
          : undefined,
      { label: 'the re-driven job to dead-letter again' },
    );

    expect(under(redriven).map(({ process, msg }) => [process, msg])).toEqual(
      expect.arrayContaining([
        ['api', `Enqueued job ${jobId} (MOCK)`],
        ['api', 'request completed'],
        ['worker', `Running job ${jobId} (MOCK) attempt 1/2`],
        ['worker', `Running job ${jobId} (MOCK) attempt 2/2`],
      ]),
    );
    expect(under(submitted)).toHaveLength(before);
  });

  it('ends the story of a job that succeeds with a line that says so', async () => {
    const requestId = `a28-success-${randomUUID()}`;
    const { body } = await send('/jobs', requestId, {
      type: 'MOCK',
      payload: { durationMs: 1 },
    });

    await harness.waitForJobStatus(body.data.id, ['SUCCEEDED']);
    await waitForLine(requestId, /succeeded on attempt 1$/);
  });
});

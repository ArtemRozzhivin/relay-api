import { describe, expect, it } from 'vitest';
import { TerminalJobError } from '../common/errors/app-error.js';
import { MockJobHandler } from './handlers/mock.handler.js';
import { recordingContext } from './job-context.fixture.js';

describe('JobHandler', () => {
  it('rejects a malformed payload rather than throwing synchronously', async () => {
    const { context } = recordingContext();

    // Called outside expect() on purpose: a synchronous throw would fail here
    // instead of producing a rejected promise, which is what the processor and
    // every other caller handle.
    const run = new MockJobHandler().run(context, { durationMs: 'soon' });

    await expect(run).rejects.toBeInstanceOf(TerminalJobError);
  });

  it('ignores a payload field a newer deploy added', async () => {
    const { context } = recordingContext();

    // An older worker must still run a job whose payload grew a field it has
    // never heard of; rejecting it would dead-letter every job in flight during
    // a rollout.
    await expect(
      new MockJobHandler().run(context, { durationMs: 0, currency: 'EUR' }),
    ).resolves.toEqual({ sleptMs: 0 });
  });

  it('reports progress once per step', async () => {
    const { context, reports } = recordingContext();

    await new MockJobHandler().run(context, { durationMs: 0, steps: 4 });

    expect(reports).toEqual([
      { processed: 1, total: 4 },
      { processed: 2, total: 4 },
      { processed: 3, total: 4 },
      { processed: 4, total: 4 },
    ]);
  });

  it('leaves the progress of a failed attempt behind', async () => {
    const { context, reports } = recordingContext();

    // It fails just past halfway, so the steps before that are reported.
    await expect(
      new MockJobHandler().run(context, {
        durationMs: 0,
        steps: 4,
        failureRate: 1,
      }),
    ).rejects.toThrow('on purpose');

    expect(reports).toEqual([
      { processed: 1, total: 4 },
      { processed: 2, total: 4 },
    ]);
  });

  it('sleeps for the duration it was asked to, however many steps', async () => {
    const { context } = recordingContext();

    // floor(10 / 3) * 3 would be 9: the remainder is spread, not dropped.
    await expect(
      new MockJobHandler().run(context, { durationMs: 10, steps: 3 }),
    ).resolves.toEqual({ sleptMs: 10 });
  });

  it('tags its log line through the context', async () => {
    const { context, lines } = recordingContext();

    await new MockJobHandler().run(context, { durationMs: 0 });

    expect(lines).toEqual(['sleeping 0ms over 1 step(s)']);
  });
});

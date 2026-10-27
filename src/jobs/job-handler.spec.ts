import { describe, expect, it } from 'vitest';
import { TerminalJobError } from '../common/errors/app-error.js';
import { MockJobHandler } from './handlers/mock.handler.js';
import type { JobContext } from './job-context.js';

const context: JobContext = { jobId: 'a-job', attempt: 1 };

describe('JobHandler', () => {
  it('rejects a malformed payload rather than throwing synchronously', async () => {
    const handler = new MockJobHandler();

    // Called outside expect() on purpose: a synchronous throw would fail here
    // instead of producing a rejected promise, which is what the processor and
    // every other caller handle.
    const run = handler.run(context, { durationMs: 'soon' });

    await expect(run).rejects.toBeInstanceOf(TerminalJobError);
  });

  it('ignores a payload field a newer deploy added', async () => {
    const handler = new MockJobHandler();

    // An older worker must still run a job whose payload grew a field it has
    // never heard of; rejecting it would dead-letter every job in flight during
    // a rollout.
    await expect(
      handler.run(context, { durationMs: 0, currency: 'EUR' }),
    ).resolves.toEqual({ sleptMs: 0 });
  });
});

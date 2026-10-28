import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../generated/prisma/client.js';
import { JobContextFactory } from './job-context.factory.js';
import type { JobTransitionService } from './job-transition.service.js';
import type { JobProgress } from './job-progress.js';

const running = {
  jobId: 'a-job',
  attempt: 2,
  correlationId: 'req-1',
  progress: null,
};

type Write = (
  jobId: string,
  attempt: number,
  progress: JobProgress,
  options?: { reclaim?: boolean },
) => Promise<Job | null>;

const factoryWriting = (reportProgress: Write) =>
  new JobContextFactory({ reportProgress } as unknown as JobTransitionService);

const recorder = () => {
  const writes: JobProgress[] = [];

  const write: Write = async (_jobId, _attempt, progress) => {
    writes.push(progress);

    return {} as Job;
  };

  return { writes, write };
};

describe('JobContextFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  it('carries the attempt that claimed the job into every write', async () => {
    const seen: number[] = [];

    const context = factoryWriting(async (_jobId, attempt) => {
      seen.push(attempt);

      return {} as Job;
    }).create(running);

    await context.reportProgress({ processed: 1 });

    expect(seen).toEqual([2]);
  });

  it('drops a report that would move progress backwards', async () => {
    const { writes, write } = recorder();
    const context = factoryWriting(write).create(running);

    for (const processed of [5, 3, 6]) {
      await context.reportProgress({ processed });
    }

    expect(writes.map((progress) => progress.processed)).toEqual([5, 6]);
  });

  it('accepts an equal count, so a message can be revised without advancing', async () => {
    const { writes, write } = recorder();
    const context = factoryWriting(write).create(running);

    await context.reportProgress({ processed: 4, message: 'connecting' });
    await context.reportProgress({ processed: 4, message: 'downloading' });

    expect(writes).toEqual([
      { processed: 4, message: 'connecting' },
      { processed: 4, message: 'downloading' },
    ]);
  });

  it('remembers a total the first report published', async () => {
    const { writes, write } = recorder();
    const context = factoryWriting(write).create(running);

    // The write replaces the whole column, so a report that omits `total` would
    // erase it — the pattern JobProgress.total's own doc invites.
    await context.reportProgress({ processed: 1, total: 10 });
    await context.reportProgress({ processed: 2 });

    expect(writes).toEqual([
      { processed: 1, total: 10 },
      { processed: 2, total: 10 },
    ]);
  });

  it('starts from the total and count the claimed row already holds', async () => {
    const { writes, write } = recorder();
    const context = factoryWriting(write).create({
      ...running,
      progress: { processed: 8, total: 10, message: 'resuming' },
    });

    for (const processed of [1, 2, 9]) {
      await context.reportProgress({ processed });
    }

    expect(writes).toEqual([{ processed: 9, total: 10, message: 'resuming' }]);
  });

  it('reclaims a column whose stored shape it cannot read, once', async () => {
    const reclaims: boolean[] = [];

    const context = factoryWriting(
      async (_jobId, _attempt, _progress, options) => {
        reclaims.push(options?.reclaim === true);

        return {} as Job;
      },
    ).create({ ...running, progress: { phase: 'extract' } });

    await context.reportProgress({ processed: 1 });
    await context.reportProgress({ processed: 2 });

    // Only the first write may skip the monotonic predicate: by the second, the
    // column holds a value this version wrote.
    expect(reclaims).toEqual([true, false]);
  });

  it('does not reclaim a column that was simply never written', async () => {
    const reclaims: boolean[] = [];

    const context = factoryWriting(
      async (_jobId, _attempt, _progress, options) => {
        reclaims.push(options?.reclaim === true);

        return {} as Job;
      },
    ).create(running);

    await context.reportProgress({ processed: 1 });

    expect(reclaims).toEqual([false]);
  });

  it('writes in call order when a handler does not await', async () => {
    const written: number[] = [];

    // The later report resolves first, which is what an unordered pair of
    // writes would look like: both match the ownership predicate, so only the
    // chaining inside the context keeps them in order.
    const context = factoryWriting(async (_jobId, _attempt, progress) => {
      await new Promise((resolve) =>
        setTimeout(resolve, progress.processed === 1 ? 20 : 0),
      );
      written.push(progress.processed);

      return {} as Job;
    }).create(running);

    void context.reportProgress({ processed: 1 });

    await context.reportProgress({ processed: 2 });

    expect(written).toEqual([1, 2]);
  });

  it('flush waits for reports the handler never awaited', async () => {
    const { writes, write } = recorder();
    const context = factoryWriting(async (jobId, attempt, progress) => {
      await new Promise((resolve) => setTimeout(resolve, 10));

      return write(jobId, attempt, progress);
    }).create(running);

    void context.reportProgress({ processed: 1 });
    void context.reportProgress({ processed: 2 });

    expect(writes).toHaveLength(0);

    await context.flush();

    expect(writes.map((progress) => progress.processed)).toEqual([1, 2]);
  });

  it('tags a handler log line with the job, attempt and request', () => {
    factoryWriting(async () => ({}) as Job)
      .create(running)
      .log('row 12 skipped');

    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Job a-job attempt 2 [correlationId=req-1] row 12 skipped',
    );
  });

  it('does not fail the job when the write is refused', async () => {
    const context = factoryWriting(async () => null).create(running);

    await expect(
      context.reportProgress({ processed: 1 }),
    ).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('progress write refused at 1'),
    );
  });

  it('does not fail the job when the write throws', async () => {
    const context = factoryWriting(async () => {
      throw new Error('connection terminated');
    }).create(running);

    await expect(
      context.reportProgress({ processed: 1 }),
    ).resolves.toBeUndefined();

    // A later report must still be attempted: one failed write is not a reason
    // to stop reporting for the rest of a long job.
    await expect(
      context.reportProgress({ processed: 2 }),
    ).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
  });
});

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Prisma } from '../generated/prisma/client.js';
import {
  JobContextFactory,
  type ManagedJobContext,
} from './job-context.factory.js';
import type { JobEventsPublisher } from './job-events.publisher.js';
import type { JobTransitionService } from './job-transition.service.js';
import type { JobProgress } from './job-progress.js';

const WINDOW_MS = 500;

const running: {
  jobId: string;
  attempt: number;
  correlationId: string;
  progress: Prisma.JsonValue | null;
} = {
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

interface Harness {
  context: ManagedJobContext;
  writes: JobProgress[];
  emitted: Job[];
  counts: () => number[];
}

const build = (write: Write, job: Partial<typeof running> = {}): Harness => {
  const writes: JobProgress[] = [];
  const emitted: Job[] = [];

  const transitions = {
    reportProgress: (...args: Parameters<Write>) => {
      writes.push(args[2]);

      return write(...args);
    },
  } as unknown as JobTransitionService;

  const events = {
    jobUpdated: async (job: Job) => {
      emitted.push(job);
    },
  } as unknown as JobEventsPublisher;

  return {
    context: new JobContextFactory(transitions, events).create({
      ...running,
      ...job,
    }),
    writes,
    emitted,
    counts: () => writes.map((progress) => progress.processed),
  };
};

const accepts: Write = async (_jobId, _attempt, progress) =>
  ({ id: 'a-job', progress }) as unknown as Job;

/** Reports and then forces the report through, bypassing the window. */
const report = async (harness: Harness, progress: JobProgress) => {
  void harness.context.reportProgress(progress);
  await harness.context.flush();
};

describe('JobContextFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the guarded write', () => {
    it('carries the attempt that claimed the job', async () => {
      const seen: number[] = [];
      const harness = build(async (_jobId, attempt) => {
        seen.push(attempt);

        return accepts(_jobId, attempt, { processed: 0 });
      });

      await report(harness, { processed: 1 });

      expect(seen).toEqual([2]);
    });

    it('drops a report that would move progress backwards', async () => {
      const harness = build(accepts);

      for (const processed of [5, 3, 6]) {
        await report(harness, { processed });
      }

      expect(harness.counts()).toEqual([5, 6]);
    });

    it('accepts an equal count, so a message can be revised without advancing', async () => {
      const harness = build(accepts);

      await report(harness, { processed: 4, message: 'connecting' });
      await report(harness, { processed: 4, message: 'downloading' });

      expect(harness.writes).toEqual([
        { processed: 4, message: 'connecting' },
        { processed: 4, message: 'downloading' },
      ]);
    });

    it('remembers a total the first report published', async () => {
      const harness = build(accepts);

      // The write replaces the whole column, so a report that omits `total`
      // would erase it — the pattern JobProgress.total's own doc invites.
      await report(harness, { processed: 1, total: 10 });
      await report(harness, { processed: 2 });

      expect(harness.writes).toEqual([
        { processed: 1, total: 10 },
        { processed: 2, total: 10 },
      ]);
    });

    it('starts from the total and count the claimed row already holds', async () => {
      const harness = build(accepts, {
        progress: { processed: 8, total: 10, message: 'resuming' },
      });

      for (const processed of [1, 2, 9]) {
        await report(harness, { processed });
      }

      expect(harness.writes).toEqual([
        { processed: 9, total: 10, message: 'resuming' },
      ]);
    });

    it('reclaims a column whose stored shape it cannot read, once', async () => {
      const reclaims: boolean[] = [];
      const harness = build(
        async (jobId, attempt, progress, options) => {
          reclaims.push(options?.reclaim === true);

          return accepts(jobId, attempt, progress);
        },
        { progress: { phase: 'extract' } },
      );

      await report(harness, { processed: 1 });
      await report(harness, { processed: 2 });

      // Only the first write may skip the monotonic predicate: by the second,
      // the column holds a value this version wrote.
      expect(reclaims).toEqual([true, false]);
    });

    it('does not reclaim a column that was simply never written', async () => {
      const reclaims: boolean[] = [];
      const harness = build(async (jobId, attempt, progress, options) => {
        reclaims.push(options?.reclaim === true);

        return accepts(jobId, attempt, progress);
      });

      await report(harness, { processed: 1 });

      expect(reclaims).toEqual([false]);
    });
  });

  describe('the 500ms window', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('sends the first report at once, so a bar starts moving', async () => {
      const harness = build(accepts);

      void harness.context.reportProgress({ processed: 1 });
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.counts()).toEqual([1]);
    });

    it('replaces a held report rather than queueing it', async () => {
      const harness = build(accepts);

      for (const processed of [1, 2, 3, 4]) {
        void harness.context.reportProgress({ processed });
      }

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.counts()).toEqual([1]);

      // Only the newest of the three held reports is sent — a client has no use
      // for a replayed backlog.
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      expect(harness.counts()).toEqual([1, 4]);
    });

    it('collapses a tight loop to one write per window', async () => {
      const harness = build(accepts);

      for (let processed = 1; processed <= 100; processed += 1) {
        void harness.context.reportProgress({ processed, total: 100 });
      }

      await vi.advanceTimersByTimeAsync(0);

      // 100 reports in one tick: one write, not a hundred.
      expect(harness.counts()).toEqual([1]);

      await harness.context.flush();

      // And the last value is exact, which is the half that must never be lost.
      expect(harness.counts()).toEqual([1, 100]);
    });

    it('sends the held report when the window closes, then opens the next', async () => {
      const harness = build(accepts);

      void harness.context.reportProgress({ processed: 1 });
      void harness.context.reportProgress({ processed: 2 });

      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      expect(harness.counts()).toEqual([1, 2]);

      void harness.context.reportProgress({ processed: 3 });
      await vi.advanceTimersByTimeAsync(0);

      // Held, not sent: closing a window opens the next one, or a tight loop
      // would send twice in a millisecond.
      expect(harness.counts()).toEqual([1, 2]);

      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      expect(harness.counts()).toEqual([1, 2, 3]);
    });

    it('leaves no timer behind once flushed', async () => {
      const harness = build(accepts);

      void harness.context.reportProgress({ processed: 1 });
      void harness.context.reportProgress({ processed: 2 });
      await harness.context.flush();

      // A timer outliving the job would hold the worker open past shutdown.
      expect(vi.getTimerCount()).toBe(0);
      expect(harness.counts()).toEqual([1, 2]);
    });

    it('keeps writes in order even when one is slow', async () => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const harness = build(async (jobId, attempt, progress) => {
        if (progress.processed === 1) {
          await gate;
        }

        return accepts(jobId, attempt, progress);
      });

      void harness.context.reportProgress({ processed: 1 });
      void harness.context.reportProgress({ processed: 2 });

      // The window closes while the first write is still in flight, so the
      // second is queued behind it on the chain rather than racing it.
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      release();
      await harness.context.flush();

      expect(harness.counts()).toEqual([1, 2]);
    });
  });

  describe('the event', () => {
    it('is built from the row the write returned, not from the report', async () => {
      const harness = build(
        async () =>
          ({ id: 'a-job', progress: { processed: 7 } }) as unknown as Job,
      );

      await report(harness, { processed: 7, message: 'ignored' });

      expect(harness.emitted).toEqual([
        { id: 'a-job', progress: { processed: 7 } },
      ]);
    });

    it('is not sent when the write was refused', async () => {
      const harness = build(async () => null);

      await report(harness, { processed: 1 });

      expect(harness.emitted).toEqual([]);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('progress write refused at 1'),
      );
    });
  });

  describe('failure', () => {
    it('does not fail the job when the write is refused', async () => {
      const harness = build(async () => null);

      await expect(report(harness, { processed: 1 })).resolves.toBeUndefined();
    });

    it('does not fail the job when the write throws', async () => {
      const harness = build(async () => {
        throw new Error('connection terminated');
      });

      await expect(report(harness, { processed: 1 })).resolves.toBeUndefined();

      // A later report must still be attempted: one failed write is not a
      // reason to stop reporting for the rest of a long job.
      await expect(report(harness, { processed: 2 })).resolves.toBeUndefined();
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
    });
  });
});

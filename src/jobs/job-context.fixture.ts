import type { JobContext } from './job-context.js';
import type { JobProgress } from './job-progress.js';

/**
 * A `JobContext` that records what a handler reported instead of writing it.
 * Lives beside the code rather than in `test/` because the unit tier imports it
 * from `src/`.
 */
export const recordingContext = ({
  stopAfterChecks = Infinity,
}: {
  /** How many `shouldStop()` calls answer false before one answers true. */
  stopAfterChecks?: number;
} = {}) => {
  const reports: JobProgress[] = [];
  const lines: string[] = [];
  let checks = 0;

  const context: JobContext = {
    jobId: 'a-job',
    attempt: 1,
    reportProgress: async (progress) => {
      reports.push(progress);
    },
    shouldStop: async () => {
      checks += 1;

      return checks > stopAfterChecks;
    },
    log: (message) => {
      lines.push(message);
    },
  };

  return { context, reports, lines, checks: () => checks };
};

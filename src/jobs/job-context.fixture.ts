import type { JobContext } from './job-context.js';
import type { JobProgress } from './job-progress.js';

/**
 * A `JobContext` that records what a handler reported instead of writing it.
 * Lives beside the code rather than in `test/` because the unit tier imports it
 * from `src/`.
 */
export const recordingContext = () => {
  const reports: JobProgress[] = [];
  const lines: string[] = [];

  const context: JobContext = {
    jobId: 'a-job',
    attempt: 1,
    reportProgress: async (progress) => {
      reports.push(progress);
    },
    log: (message) => {
      lines.push(message);
    },
  };

  return { context, reports, lines };
};

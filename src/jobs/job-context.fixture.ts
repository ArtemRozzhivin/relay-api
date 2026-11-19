import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { JobContext } from './job-context.js';
import type { JobProgress } from './job-progress.js';

/**
 * A `JobContext` that records what a handler reported instead of writing it.
 * Lives beside the code rather than in `test/` because the unit tier imports it
 * from `src/`.
 */
export const recordingContext = ({
  stopAfterChecks = Infinity,
  userId = 'a-user',
  attempt = 1,
  lastAttempt = false,
  checkpoint = null,
  client,
}: {
  /** How many `shouldStop()` calls answer false before one answers true. */
  stopAfterChecks?: number;
  userId?: string;
  attempt?: number;
  lastAttempt?: boolean;

  /** What the context reports an earlier attempt committed. */
  checkpoint?: Prisma.JsonValue | null;

  /**
   * The database `commit()` writes through. Without one it throws, which is
   * right for a handler that has no batch to commit.
   */
  client?: PrismaService;
} = {}) => {
  const reports: JobProgress[] = [];
  const lines: string[] = [];
  const checkpoints: Prisma.InputJsonValue[] = [];
  let checks = 0;

  const context: JobContext = {
    jobId: 'a-job',
    userId,
    attempt,
    lastAttempt,
    checkpoint,
    reportProgress: async (progress) => {
      reports.push(progress);
    },
    shouldStop: async () => {
      checks += 1;

      return checks > stopAfterChecks;
    },
    commit: async (work, checkpointOf) => {
      if (!client) {
        throw new Error('This context has no database to commit through');
      }

      const value = await client.$transaction((tx) => work(tx));

      checkpoints.push(checkpointOf(value));

      return value;
    },
    commitEffect: async (work) => {
      if (!client) {
        throw new Error('This context has no database to commit through');
      }

      return client.$transaction((tx) => work(tx));
    },
    log: (message) => {
      lines.push(message);
    },
  };

  return { context, reports, lines, checkpoints, checks: () => checks };
};

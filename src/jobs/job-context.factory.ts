import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { JobTransitionService } from './job-transition.service.js';
import type { JobContext } from './job-context.js';
import { readProgress, type JobProgress } from './job-progress.js';

// Below any real count, so a handler's first report of `processed: 0` — the one
// that publishes the total before any work lands — is not mistaken for a repeat.
const NOTHING_REPORTED = -1;

interface RunningJob {
  jobId: string;
  attempt: number;
  correlationId: string;

  /** What the row already says, so a retry neither re-reports nor erases it. */
  progress: Prisma.JsonValue | null;
}

/**
 * The context as its owner sees it. The processor must {@link flush} before it
 * transitions the job, because a handler may report without awaiting and a
 * queued write would otherwise land on a row that is no longer `RUNNING`.
 */
export interface ManagedJobContext extends JobContext {
  flush(): Promise<void>;
}

class RunningJobContext implements ManagedJobContext {
  // Writes are chained, not fired: the SQL predicate rejects a *stale* attempt
  // but cannot order two writes from the live one, so a handler reporting batch
  // 4 after batch 5 would otherwise land them in either order.
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly jobId: string,
    readonly attempt: number,
    private readonly correlationId: string,
    // The highest count accepted so far, and the last `total`/`message` seen —
    // both seeded from the claimed row. The seed spares the database the writes
    // a retry would redo, and keeps a report that omits `total` from erasing the
    // one an earlier batch published, since a write replaces the whole column.
    private reported: number,
    private carried: Partial<JobProgress>,
    // Set when the claimed row held a progress value this version cannot read,
    // which the first write must say so it is not refused by a comparison
    // against a value that is not a number. Cleared once that write is queued.
    private reclaim: boolean,
    private readonly transitions: JobTransitionService,
    private readonly logger: Logger,
  ) {}

  reportProgress(progress: JobProgress) {
    if (progress.processed >= this.reported) {
      this.reported = progress.processed;
      this.carried = { ...this.carried, ...progress };

      const merged = { ...this.carried, processed: progress.processed };
      const reclaim = this.reclaim;

      this.reclaim = false;
      this.pending = this.pending.then(() => this.write(merged, reclaim));
    }

    return this.pending;
  }

  log(message: string) {
    this.logger.log(`${this.prefix} ${message}`);
  }

  flush() {
    return this.pending;
  }

  private get prefix() {
    return `Job ${this.jobId} attempt ${this.attempt} [correlationId=${this.correlationId}]`;
  }

  // Never rejects. Progress is presentational (D25), so losing a write must not
  // fail the job — and a handler may report without awaiting, where a rejection
  // would become an unhandled rejection and take the whole worker down.
  private async write(progress: JobProgress, reclaim: boolean) {
    try {
      const written = await this.transitions.reportProgress(
        this.jobId,
        this.attempt,
        progress,
        { reclaim },
      );

      if (!written) {
        // Two possible causes and the row count cannot tell them apart: a later
        // attempt owns the job, or it has already finished. Neither is worth
        // distinguishing — stopping is not decided here, because cancellation
        // gets one channel (A.6), and a handler that keeps working is harmless
        // while its effects are keyed (§7.1).
        this.logger.warn(
          `${this.prefix} progress write refused at ${progress.processed}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `${this.prefix} could not write progress: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

@Injectable()
export class JobContextFactory {
  // One logger name for every handler, so a handler's lines are distinguishable
  // from the processor's in a single stream.
  private readonly logger = new Logger('JobHandler');

  constructor(private readonly transitions: JobTransitionService) {}

  create({
    jobId,
    attempt,
    correlationId,
    progress,
  }: RunningJob): ManagedJobContext {
    const stored = readProgress(progress);

    return new RunningJobContext(
      jobId,
      attempt,
      correlationId,
      stored.processed ?? NOTHING_REPORTED,
      stored,
      progress !== null && stored.processed === undefined,
      this.transitions,
      this.logger,
    );
  }
}

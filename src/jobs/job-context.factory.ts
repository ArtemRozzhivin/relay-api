import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { JobTransitionService } from './job-transition.service.js';
import { JobEventsPublisher } from './job-events.publisher.js';
import type { JobContext } from './job-context.js';
import { JobCancelledError } from './job-handler.js';
import { readProgress, type JobProgress } from './job-progress.js';
import { describeError } from '../common/errors/describe-error.js';

// Below any real count, so a handler's first report of `processed: 0` — the one
// that publishes the total before any work lands — is not mistaken for a repeat.
const NOTHING_REPORTED = -1;

// At most one write and one event per job per window, and the window opens when
// a write settles. A handler chooses how often it reports, and reporting per row
// is both cheaper than the work and useless to a client: a bar repaints 60 times
// a second at best and is read ten times. 500ms keeps a bar visibly alive at 2Hz
// while collapsing a tight loop into almost nothing. The final report is exempt,
// which is what flush() is for.
const REPORT_WINDOW_MS = 500;

interface RunningJob {
  jobId: string;
  userId: string;
  attempt: number;

  /** Whether a failure of this attempt dead-letters the job; never, by default. */
  lastAttempt?: boolean;

  /** The ownership token claim() handed this delivery; every write carries it. */
  lease: number;
  correlationId: string;

  /** What the row already says, so a retry neither re-reports nor erases it. */
  progress: Prisma.JsonValue | null;
  checkpoint: Prisma.JsonValue | null;

  /** Whether the worker running it is shutting down; never, by default. */
  stopping?: () => boolean;
}

/**
 * The context as its owner sees it. The processor must {@link flush} before it
 * transitions the job: a handler may report without awaiting, and the throttle
 * holds the newest report back by design, so the last one would otherwise land
 * on a row that is no longer `RUNNING`.
 */
export interface ManagedJobContext extends JobContext {
  flush(): Promise<void>;
}

class RunningJobContext implements ManagedJobContext {
  readonly jobId: string;
  readonly userId: string;
  readonly attempt: number;
  readonly lastAttempt: boolean;
  readonly checkpoint: Prisma.JsonValue | null;
  private readonly lease: number;
  private readonly correlationId: string;
  private readonly stopping: () => boolean;

  // The highest count accepted so far, and the last `total`/`message` seen —
  // both seeded from the claimed row. The seed spares the database the writes
  // a retry would redo, and keeps a report that omits `total` from erasing the
  // one an earlier batch published, since a write replaces the whole column.
  private reported: number;
  private carried: Partial<JobProgress>;

  // Set when the claimed row held a progress value this version cannot read,
  // which a write must say so it is not refused by a comparison against a
  // value that is not a number. Cleared only once a write lands: one that
  // failed changed nothing, so the next must say it again.
  private reclaim: boolean;

  // The write in flight, if any. Never more than one: the SQL predicate rejects
  // a *stale* attempt but cannot order two writes from the live one, and a
  // second write sent while the first is slow is how a backlog starts — each
  // window would queue another, and a recovering database would replay them
  // all as a burst of stale values.
  private pending: Promise<void> = Promise.resolve();

  private inFlight = false;

  // Set while flush() empties the context, so a write settling meanwhile does
  // not open a window nobody will close.
  private draining = false;

  // The newest report the window is holding back. Later reports replace it
  // rather than queueing: nobody wants the bar to replay a backlog.
  private held?: JobProgress;

  private window?: NodeJS.Timeout;

  // The job as one named object: attempt and lease are both numbers, and as
  // positional parameters a swap of the two would still compile.
  constructor(
    job: Required<RunningJob>,
    private readonly transitions: JobTransitionService,
    private readonly events: JobEventsPublisher,
    private readonly logger: Logger,
  ) {
    this.jobId = job.jobId;
    this.userId = job.userId;
    this.attempt = job.attempt;
    this.lastAttempt = job.lastAttempt;
    this.checkpoint = job.checkpoint;
    this.lease = job.lease;
    this.correlationId = job.correlationId;
    this.stopping = job.stopping;

    const stored = readProgress(job.progress);

    this.reported = stored.processed ?? NOTHING_REPORTED;
    this.carried = stored;
    this.reclaim = job.progress !== null && stored.processed === undefined;
  }

  reportProgress(progress: JobProgress) {
    if (progress.processed >= this.reported) {
      this.reported = progress.processed;
      this.carried = { ...this.carried, ...progress };

      const merged = { ...this.carried, processed: progress.processed };

      if (this.inFlight || this.window) {
        this.held = merged;
      } else {
        this.send(merged);
      }
    }

    return this.pending;
  }

  async commit<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    checkpoint: (value: T) => Prisma.InputJsonValue,
  ) {
    const committed = await this.transitions.commitCheckpoint(
      this.jobId,
      this.lease,
      work,
      checkpoint,
    );

    // The same answer shouldStop() would give: nothing more this attempt does
    // will count, and the attempt that holds the job now resumes from the last
    // checkpoint that did.
    if (!committed) {
      throw new JobCancelledError();
    }

    return committed.value;
  }

  async commitEffect<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    const committed = await this.transitions.commitEffect(
      this.jobId,
      this.lease,
      work,
    );

    if (!committed) {
      throw new JobCancelledError();
    }

    return committed.value;
  }

  async shouldStop() {
    return (
      this.stopping() ||
      !(await this.transitions.isWanted(this.jobId, this.lease))
    );
  }

  log(message: string) {
    this.logger.log(`${this.prefix} ${message}`);
  }

  async flush() {
    this.draining = true;

    try {
      this.closeWindow();

      // A loop, not one send: a report can arrive while the last write is in
      // flight, and nothing would send it once this returns.
      for (;;) {
        await this.pending;

        if (!this.held) {
          return;
        }

        const last = this.held;

        this.held = undefined;
        this.send(last);
      }
    } finally {
      this.draining = false;
    }
  }

  private send(progress: JobProgress) {
    this.inFlight = true;

    // write() never rejects, so the window is sure to open.
    this.pending = this.write(progress).finally(() => {
      this.inFlight = false;

      if (!this.draining) {
        this.openWindow();
      }
    });
  }

  private openWindow() {
    this.window = setTimeout(() => {
      this.window = undefined;

      // Whatever arrived since the last write goes now, which both honours the
      // "always the last one" half of the contract and starts the next round.
      if (this.held) {
        const next = this.held;

        this.held = undefined;
        this.send(next);
      }
    }, REPORT_WINDOW_MS);
  }

  private closeWindow() {
    if (this.window) {
      clearTimeout(this.window);
      this.window = undefined;
    }
  }

  private get prefix() {
    return `Job ${this.jobId} attempt ${this.attempt} [correlationId=${this.correlationId}]`;
  }

  // Never rejects. Progress is presentational (D25), so losing a write must not
  // fail the job — and a handler may report without awaiting, where a rejection
  // would become an unhandled rejection and take the whole worker down.
  private async write(progress: JobProgress) {
    try {
      const written = await this.transitions.reportProgress(
        this.jobId,
        this.lease,
        progress,
        { reclaim: this.reclaim },
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

        return;
      }

      // The column now holds a value this version wrote.
      this.reclaim = false;

      // Built from the row the write returned, never from what the handler
      // reported: an event that describes a state the database does not hold
      // cannot be un-sent (§9.2a).
      await this.events.jobUpdated(written);
    } catch (error) {
      this.logger.warn(
        `${this.prefix} could not write progress: ${describeError(error)}`,
      );
    }
  }
}

@Injectable()
export class JobContextFactory {
  // One logger name for every handler, so a handler's lines are distinguishable
  // from the processor's in a single stream.
  private readonly logger = new Logger('JobHandler');

  constructor(
    private readonly transitions: JobTransitionService,
    private readonly events: JobEventsPublisher,
  ) {}

  create({
    lastAttempt = false,
    stopping = () => false,
    ...job
  }: RunningJob): ManagedJobContext {
    return new RunningJobContext(
      { ...job, lastAttempt, stopping },
      this.transitions,
      this.events,
      this.logger,
    );
  }
}

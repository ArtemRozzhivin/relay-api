import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { JobTransitionService } from '../jobs/job-transition.service.js';
import { JobEventsPublisher } from '../jobs/job-events.publisher.js';
import { JOBS_QUEUE, messageId, type JobMessage } from '../jobs/job-queue.js';
import type { DeadLetterCode } from '../jobs/job-error-codes.js';
import type { WorkerEnv } from '../config/env.schema.js';

const BATCH_SIZE = 100;

// How long a finished queue entry may sit beside a RUNNING row before the sweep
// acts on it. The 'failed' event finalises an abandoned job within
// milliseconds; waiting this long keeps the sweep the backstop rather than a
// racer that wins and leaves the event's own write refused.
const STRANDED_AFTER_MS = 30_000;

/** A `RUNNING` row, and the outbox row whose queue entry delivered it. */
export interface SweepCandidate {
  id: string;
  lease: number;
  outboxId: bigint;
}

/**
 * Dead-letters jobs whose row says `RUNNING` while the queue has stopped
 * delivering them.
 *
 * The `failed` event normally does this (§7.6), but it is heard once, in
 * memory, by one worker: if that worker dies, or Postgres refuses the write at
 * that moment, nothing else ever would, and the row stays `RUNNING` for ever —
 * past a re-drive, which only accepts dead letters. The sweep asks the queue
 * rather than a clock: a long job is legitimately `RUNNING` for hours, and only
 * the queue knows whether anyone still holds it.
 */
@Injectable()
export class StrandedJobSweeper
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(StrandedJobSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: JobTransitionService,
    private readonly events: JobEventsPublisher,
    private readonly config: ConfigService<WorkerEnv, true>,
    @InjectQueue(JOBS_QUEUE) private readonly queue: Queue<JobMessage>,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(
      () => void this.tick(),
      this.config.get('RELAY_SWEEP_INTERVAL_MS', { infer: true }),
    );
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async tick() {
    // A sweep slower than the interval must not overlap the next one.
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      await this.sweep();
    } catch (error) {
      this.logger.error(
        `Stranded-job sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Checks every `RUNNING` row, a page at a time, so none is starved. */
  async sweep(now = Date.now()) {
    let cursor: string | undefined;

    for (;;) {
      const page = await this.prisma.job.findMany({
        where: { status: 'RUNNING' },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        select: {
          id: true,
          lease: true,
          // The newest row is the delivery of this life: a re-drive is a new
          // row and so a new queue entry (§7.5a).
          outbox: { orderBy: { id: 'desc' }, take: 1, select: { id: true } },
        },
      });

      for (const { id, lease, outbox } of page) {
        const [latest] = outbox;

        // Every delivery has an outbox row; without one there is no entry to
        // ask about, and guessing would finish a job someone may hold.
        if (latest) {
          await this.finishIfStranded({ id, lease, outboxId: latest.id }, now);
        }
      }

      if (page.length < BATCH_SIZE) {
        return;
      }

      cursor = page.at(-1)?.id;
    }
  }

  /**
   * Dead-letters one job if its queue entry is gone, or finished at least
   * {@link STRANDED_AFTER_MS} before `now`. Waiting, delayed and active entries
   * are the queue still doing its job — a stalled one goes back to waiting and
   * is redelivered — so they are left alone.
   *
   * @returns the dead-lettered row, or `null` if the job is not stranded or
   * something else finished it first.
   */
  async finishIfStranded(job: SweepCandidate, now = Date.now()) {
    const entry = await this.queue.getJob(messageId(job.id, job.outboxId));

    let found: string;

    if (entry === undefined) {
      found = 'missing';
    } else if (
      entry.finishedOn !== undefined &&
      now - entry.finishedOn >= STRANDED_AFTER_MS
    ) {
      found = await entry.getState();
    } else {
      return null;
    }

    const abandoned = await this.transitions.abandonStranded(
      job.id,
      job.lease,
      {
        code: 'DELIVERY_ABANDONED' satisfies DeadLetterCode,
        message: `The queue no longer delivers this job (its entry is ${found})`,
      },
    );

    if (abandoned) {
      await this.events.jobUpdated(abandoned);

      this.logger.error(
        `Job ${job.id} dead-lettered by the sweep: still RUNNING, but its queue entry is ${found}`,
      );
    }

    return abandoned;
  }
}

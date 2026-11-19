import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Gauge, Registry } from '@prometheus-io/client';
import type { Queue } from 'bullmq';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { describeError } from '../common/errors/describe-error.js';
import { JOBS_QUEUE, type JobMessage } from './job-queue.js';
import { JOB_TYPES } from './jobs.schema.js';

// Where an unfinished job can wait in the queue. Completed and failed entries
// are history the queue trims, not work still to do.
const QUEUE_STATES = ['waiting', 'prioritized', 'delayed', 'active'] as const;

// SQL rather than a groupBy, with the status written into it: Postgres reads
// the small index of dead letters only when it can see, as it plans, that the
// query asks for that status. Prisma sends the status as a parameter cast at
// run time, which the planner cannot match, so every scrape read every job.
export const DEAD_LETTERS_BY_TYPE = Prisma.sql`
  -- An int: a bigint arrives as a BigInt, which a gauge does not take.
  SELECT "type", count(*)::int AS "count"
  FROM "Job"
  WHERE "status" = 'DEAD_LETTERED'
  GROUP BY "type"
`;

/**
 * The backlog, read from Postgres and Redis whenever Prometheus scrapes.
 *
 * Exported by the API alone. It is the same number from any process, and
 * every worker exporting it would make a sum across them count it once per
 * worker.
 *
 * A source that cannot be read drops its series from that scrape rather than
 * failing it: the process's own metrics still arrive, and a gap on a graph
 * says "unknown" where a zero would say "empty".
 */
@Injectable()
export class QueueMetrics {
  private readonly logger = new Logger(QueueMetrics.name);
  private readonly depth: Gauge<'state'>;
  private readonly deadLetters: Gauge<'type'>;

  constructor(
    registry: Registry,
    private readonly prisma: PrismaService,
    @InjectQueue(JOBS_QUEUE) private readonly queue: Queue<JobMessage>,
  ) {
    this.depth = new Gauge({
      name: 'relay_queue_depth',
      help: 'Unfinished jobs by where they wait: the outbox (committed, not yet queued) or a queue state',
      labelNames: ['state'],
      registers: [registry],
      collect: () => this.readDepth(),
    });

    this.deadLetters = new Gauge({
      name: 'relay_dead_letters',
      help: 'Dead-lettered jobs, by type, that nobody has re-driven',
      labelNames: ['type'],
      registers: [registry],
      collect: () => this.readDeadLetters(),
    });
  }

  private async readDepth() {
    const [outbox, queue] = await Promise.allSettled([
      this.prisma.outbox.count({ where: { publishedAt: null } }),
      this.queue.getJobCounts(...QUEUE_STATES),
    ]);

    if (outbox.status === 'fulfilled') {
      this.depth.set({ state: 'outbox' }, outbox.value);
    } else {
      this.depth.remove({ state: 'outbox' });
      this.skipped('the outbox', outbox.reason);
    }

    for (const state of QUEUE_STATES) {
      if (queue.status === 'fulfilled') {
        this.depth.set({ state }, queue.value[state] ?? 0);
      } else {
        this.depth.remove({ state });
      }
    }

    if (queue.status === 'rejected') {
      this.skipped('the queue', queue.reason);
    }
  }

  private async readDeadLetters() {
    try {
      const counts =
        await this.prisma.$queryRaw<{ type: string; count: number }[]>(
          DEAD_LETTERS_BY_TYPE,
        );

      // Every type, so one with none reads 0 rather than nothing.
      for (const type of JOB_TYPES) {
        this.deadLetters.set({ type }, 0);
      }

      for (const { type, count } of counts) {
        this.deadLetters.set({ type }, count);
      }
    } catch (error) {
      this.deadLetters.reset();
      this.skipped('dead letters', error);
    }
  }

  private skipped(source: string, error: unknown) {
    this.logger.warn(
      `Metrics left out ${source}, which could not be read: ${describeError(error)}`,
    );
  }
}

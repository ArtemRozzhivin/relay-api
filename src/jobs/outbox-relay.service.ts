import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  JOBS_QUEUE,
  jobOptions,
  type JobMessage,
  type OutboxMessage,
} from './job-queue.js';
import { describeError } from '../common/errors/describe-error.js';
import { nonOverlapping } from '../common/scheduling/non-overlapping.js';

// At most 100 rows a second, and that is a pace, not a throughput limit: a
// bulk re-drive writes thousands of outbox rows at once and relies on this to
// release them as a ramp against a downstream that has only just recovered
// (D11). The direct path carries normal submits, so raising it buys nothing.
const BATCH_SIZE = 100;

@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);

  private readonly publishOnce = nonOverlapping(
    () => this.publishPending(),
    (error) =>
      this.logger.error(`Outbox relay failed: ${describeError(error)}`),
  );

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(JOBS_QUEUE) private readonly queue: Queue<JobMessage>,
  ) {}

  @Interval(1000)
  tick() {
    return this.publishOnce();
  }

  async publishPending() {
    const pending = await this.prisma.outbox.findMany({
      where: { publishedAt: null },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });

    let published = 0;
    let firstFailure: { rowId: bigint; reason: string } | undefined;

    for (const row of pending) {
      // Json in the schema, so typed only by agreement: JobsService writes
      // every row's payload as an OutboxMessage.
      const message = row.payload as unknown as OutboxMessage;

      // Per row, not per tick: the next tick starts again from the oldest
      // unpublished row, so a row that always fails would otherwise hold back
      // every row behind it for good. It stays unpublished and is retried on
      // every tick; the rows behind it go out in the meantime, which costs only
      // their order relative to it — and each row is a separate message.
      try {
        await this.queue.add(
          row.jobName,
          { jobId: message.jobId, correlationId: message.correlationId },
          jobOptions(message.jobId, row.id, message.maxAttempts),
        );

        await this.prisma.outbox.update({
          where: { id: row.id },
          data: { publishedAt: new Date(), attempts: { increment: 1 } },
        });

        published += 1;
      } catch (error) {
        firstFailure ??= {
          rowId: row.id,
          reason: describeError(error),
        };
      }
    }

    if (published > 0) {
      this.logger.log(`Outbox relay published ${published} job(s)`);
    }

    // One line per tick, not per row: with Redis down every row fails, and a
    // hundred identical lines a second would bury the one that says why.
    if (firstFailure) {
      this.logger.error(
        `Outbox relay could not publish ${pending.length - published} of ${pending.length} row(s); first was row ${firstFailure.rowId}: ${firstFailure.reason}`,
      );
    }

    return published;
  }
}

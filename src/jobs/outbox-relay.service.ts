import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { JOBS_QUEUE, messageId, type JobMessage } from './job-queue.js';

const BATCH_SIZE = 100;

@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(JOBS_QUEUE) private readonly queue: Queue<JobMessage>,
  ) {}

  @Interval(1000)
  async tick() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      await this.publishPending();
    } catch (error) {
      this.logger.error(
        `Outbox relay failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
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
      const message = row.payload as unknown as JobMessage & {
        maxAttempts: number;
      };

      // Per row, not per tick: the next tick starts again from the oldest
      // unpublished row, so a row that always fails would otherwise hold back
      // every row behind it for good. It stays unpublished and is retried on
      // every tick; the rows behind it go out in the meantime, which costs only
      // their order relative to it — and each row is a separate message.
      try {
        await this.queue.add(
          row.jobName,
          { jobId: message.jobId, correlationId: message.correlationId },
          {
            jobId: messageId(message.jobId, row.id),
            attempts: message.maxAttempts,
            backoff: { type: 'exponential', delay: 1000, jitter: 1 },
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 86_400 },
          },
        );

        await this.prisma.outbox.update({
          where: { id: row.id },
          data: { publishedAt: new Date(), attempts: { increment: 1 } },
        });

        published += 1;
      } catch (error) {
        firstFailure ??= {
          rowId: row.id,
          reason: error instanceof Error ? error.message : String(error),
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

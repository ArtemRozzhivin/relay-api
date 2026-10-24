import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { JOBS_QUEUE, type JobMessage } from './job-queue.js';

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

    for (const row of pending) {
      const message = row.payload as unknown as JobMessage & {
        maxAttempts: number;
      };

      await this.queue.remove(message.jobId).catch(() => undefined);

      await this.queue.add(
        row.jobName,
        { jobId: message.jobId, correlationId: message.correlationId },
        {
          jobId: message.jobId,
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
    }

    if (pending.length > 0) {
      this.logger.log(`Outbox relay published ${pending.length} job(s)`);
    }

    return pending.length;
  }
}

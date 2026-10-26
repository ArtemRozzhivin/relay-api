import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import type { Job } from '../generated/prisma/client.js';
import { JOB_EVENTS_CHANNEL, toJobUpdatedEvent } from './job-events.js';

@Injectable()
export class JobEventsPublisher {
  private readonly logger = new Logger(JobEventsPublisher.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // Callers publish after their transaction has committed: an event cannot be
  // un-sent, so broadcasting a state the database then rolls back is permanent.
  async jobUpdated(job: Job) {
    try {
      await this.redis.publish(
        JOB_EVENTS_CHANNEL,
        JSON.stringify(toJobUpdatedEvent(job)),
      );
    } catch (error) {
      // Delivery is at-most-once by design; a client reconciles with
      // GET /jobs/:id on reconnect, so a failed publish must never fail a job.
      this.logger.warn(
        `Could not publish job.updated for ${job.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

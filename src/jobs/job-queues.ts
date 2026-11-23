import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AI_QUEUE, JOBS_QUEUE, type JobMessage } from './job-queue.js';

/** Every queue a job can be delivered through, by name. */
@Injectable()
export class JobQueues {
  private readonly byName: ReadonlyMap<string, Queue<JobMessage>>;

  constructor(
    @InjectQueue(JOBS_QUEUE) jobs: Queue<JobMessage>,
    @InjectQueue(AI_QUEUE) ai: Queue<JobMessage>,
  ) {
    this.byName = new Map([
      [JOBS_QUEUE, jobs],
      [AI_QUEUE, ai],
    ]);
  }

  /**
   * @throws when no queue has that name: an outbox row written by a deploy
   * that knew a queue this one does not.
   */
  named(name: string) {
    const queue = this.byName.get(name);

    if (!queue) {
      throw new Error(`No queue is named ${name}`);
    }

    return queue;
  }

  all() {
    return [...this.byName];
  }
}

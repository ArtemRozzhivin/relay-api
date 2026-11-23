import type { JobsOptions } from 'bullmq';

export const JOBS_QUEUE = 'relay-jobs';

// Its own queue because a BullMQ limiter applies to a whole queue: the
// provider's rate limit, set on relay-jobs, would slow imports and images too
// (D6a).
export const AI_QUEUE = 'relay-ai';

export const QUEUES = [JOBS_QUEUE, AI_QUEUE] as const;

const AI_TYPES: ReadonlySet<string> = new Set(['ai.enrich']);

/**
 * The queue a job of `type` is delivered through. Decided when the job's
 * outbox row is written and recorded on it, so a delivery always goes where
 * that row says, whatever a later deploy routes the type to.
 */
export const queueFor = (type: string) =>
  AI_TYPES.has(type) ? AI_QUEUE : JOBS_QUEUE;

export interface JobMessage {
  jobId: string;
  correlationId: string;
}

/**
 * An outbox row's `payload`: the queue message, plus what the queue entry's
 * options need. Written by `JobsService`, read back by the relay.
 */
export type OutboxMessage = JobMessage & { maxAttempts: number };

// One queue entry per Outbox row, not per job. A re-drive is a new row and so a
// new entry, which is what stops BullMQ from silently deduplicating it against
// the finished entry of an earlier run. `.` because BullMQ rejects `:` in a
// custom job id unless it splits into exactly three parts.
export const messageId = (jobId: string, outboxId: bigint) =>
  `${jobId}.${outboxId}`;

/**
 * The options of the queue entry that delivers one outbox row. One builder for
 * the direct path and the relay, so a job is retried and kept the same way
 * however it reached the queue.
 */
export const jobOptions = (
  jobId: string,
  outboxId: bigint,
  maxAttempts: number,
): JobsOptions => ({
  jobId: messageId(jobId, outboxId),
  attempts: maxAttempts,
  backoff: { type: 'exponential', delay: 1000, jitter: 1 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86_400 },
});

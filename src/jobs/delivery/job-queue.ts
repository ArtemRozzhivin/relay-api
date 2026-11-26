import type { JobsOptions } from 'bullmq';
import { z } from 'zod';
import type { Job } from '../../generated/prisma/client.js';
import type { JobType } from '../jobs.schema.js';

export const JOBS_QUEUE = 'relay-jobs';

// Its own queue because a BullMQ limiter applies to a whole queue: the
// provider's rate limit, set on relay-jobs, would slow imports and images too
// (D6a).
export const AI_QUEUE = 'relay-ai';

export const QUEUES = [JOBS_QUEUE, AI_QUEUE] as const;

// Typed as job types, so a renamed type fails to compile rather than quietly
// leaving the AI queue.
const AI_TYPES: ReadonlySet<string> = new Set<JobType>(['ai.enrich']);

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

const outboxMessageSchema = z.object({
  jobId: z.string(),
  correlationId: z.string(),
  maxAttempts: z.number().int().positive(),
});

/**
 * An outbox row's `payload`: the queue message, plus what the queue entry's
 * options need. Written by {@link outboxEntry}, read back by
 * {@link readOutboxMessage}.
 */
export type OutboxMessage = z.infer<typeof outboxMessageSchema>;

/**
 * An outbox row's `payload`, checked. The column is Json, so without the check
 * its shape is only agreed: a field renamed in {@link OutboxMessage} would still
 * compile, and every reader would read `undefined`.
 *
 * @returns `null` for a payload {@link outboxEntry} did not write.
 */
export const readOutboxMessage = (payload: unknown): OutboxMessage | null => {
  const parsed = outboxMessageSchema.safeParse(payload);

  return parsed.success ? parsed.data : null;
};

/**
 * The outbox row that delivers `job`. One shape for every message the outbox
 * carries — a submit, a re-drive, a pipeline's batches — so the relay and the
 * direct path publish the same thing however a job reached the queue.
 */
export const outboxEntry = (
  job: Pick<Job, 'id' | 'type' | 'maxAttempts'>,
  correlationId: string,
) => ({
  jobId: job.id,
  queue: queueFor(job.type),
  jobName: job.type,
  payload: {
    jobId: job.id,
    correlationId,
    maxAttempts: job.maxAttempts,
  } satisfies OutboxMessage,
});

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

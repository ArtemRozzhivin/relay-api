export const JOBS_QUEUE = 'relay-jobs';

export interface JobMessage {
  jobId: string;
  correlationId: string;
}

// One queue entry per Outbox row, not per job. A re-drive is a new row and so a
// new entry, which is what stops BullMQ from silently deduplicating it against
// the finished entry of an earlier run. `.` because BullMQ rejects `:` in a
// custom job id unless it splits into exactly three parts.
export const messageId = (jobId: string, outboxId: bigint) =>
  `${jobId}.${outboxId}`;

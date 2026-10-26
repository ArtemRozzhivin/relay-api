import type { Job } from '../generated/prisma/client.js';

export const JOB_EVENTS_CHANNEL = 'relay:job-updated';

export interface JobUpdatedPayload {
  id: string;
  status: string;
  attempts: number;
  result?: unknown;
  error?: unknown;
  updatedAt: string;
}

// userId rides along for routing only; the API strips it and emits just the job,
// so §9.2's payload is what a client actually receives.
export interface JobUpdatedEvent {
  userId: string;
  job: JobUpdatedPayload;
}

export const toJobUpdatedEvent = (job: Job): JobUpdatedEvent => ({
  userId: job.userId,
  job: {
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    ...(job.result === null ? {} : { result: job.result }),
    ...(job.error === null ? {} : { error: job.error }),
    updatedAt: job.updatedAt.toISOString(),
  },
});

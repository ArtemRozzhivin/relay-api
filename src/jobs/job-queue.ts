export const JOBS_QUEUE = 'relay-jobs';

export interface JobMessage {
  jobId: string;
  correlationId: string;
}

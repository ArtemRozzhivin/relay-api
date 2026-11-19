/**
 * The `Job.error.code` values a dead-lettered job can carry — one per way a job
 * dies. A bulk re-drive filters on these, so they live in one list: a filter
 * naming a code nothing ever writes would match no rows and look like "nothing
 * to re-drive" instead of a typo.
 */
export const DEAD_LETTER_CODES = [
  // The handler said retrying cannot help: an unknown type, a malformed
  // payload, a permanent error from downstream.
  'TERMINAL_FAILURE',
  // Every attempt the job was allowed failed.
  'ATTEMPTS_EXHAUSTED',
  // The queue stopped delivering the job before any attempt finished it: its
  // workers kept disappearing, or every delivery failed before the claim
  // (§7.6). Earlier deliveries may have run the handler, so its effects may
  // already have landed.
  'DELIVERY_ABANDONED',
] as const;

export type DeadLetterCode = (typeof DEAD_LETTER_CODES)[number];

/**
 * `Job.error` on a dead letter. `message` is written for the job's owner;
 * `reason` is a handler's own name for a terminal failure (`TerminalJobError`).
 */
export type DeadLetterError = {
  code: DeadLetterCode;
  message: string;
  attempt?: number;
  reason?: string;
};

/**
 * `Job.error` on a job the queue will try again: why its last attempt failed.
 * Not a dead-letter code — a bulk re-drive never matches it.
 */
export type AttemptFailedError = {
  code: 'ATTEMPT_FAILED';
  message: string;
  attempt: number;
};

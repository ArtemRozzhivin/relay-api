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
  // The queue gave up redelivering a job whose worker kept disappearing,
  // without ever calling the handler (§7.6).
  'DELIVERY_ABANDONED',
] as const;

export type DeadLetterCode = (typeof DEAD_LETTER_CODES)[number];

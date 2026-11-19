import type { Prisma } from '../generated/prisma/client.js';

/**
 * How far along a job is. Presentational: a client reads it to draw a bar, and
 * nothing in the system makes a decision from it (a resumable job keeps its own
 * checkpoint — D26).
 */
export interface JobProgress {
  /**
   * Units of work finished. Never decreases while one attempt owns the job; an
   * equal count is accepted, so a handler can revise `message` without
   * advancing (A12).
   */
  readonly processed: number;

  /** Total units, when the handler knows it. Carried forward once reported. */
  readonly total?: number;

  /** One short line for whoever is watching the job. Carried forward once reported. */
  readonly message?: string;
}

/** The jsonb path the monotonic predicate compares. */
export const PROCESSED_PATH = ['processed'];

/**
 * Reads back a stored progress value, keeping only the fields this version
 * understands.
 *
 * The column is `jsonb` and nothing constrains its shape, so a row written by
 * another version of this code — or by hand — may hold anything. Unreadable
 * fields are simply absent from the result.
 */
export const readProgress = (
  stored: Prisma.JsonValue | null,
): Partial<JobProgress> => {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return {};
  }

  const { processed, total, message } = stored;

  return {
    ...(typeof processed === 'number' ? { processed } : {}),
    ...(typeof total === 'number' ? { total } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  };
};

/**
 * Builds the value written to the column.
 *
 * Keys are enumerated rather than spread because `undefined` is not a JSON
 * value: spreading the object would store `"total": null` for a handler that
 * never knew the total. The write replaces the whole column, so whatever is
 * missing here is erased — {@link JobProgress} says which fields the caller is
 * expected to carry forward.
 */
export const toStoredProgress = (
  progress: JobProgress,
): Prisma.InputJsonObject => ({
  processed: progress.processed,
  ...(progress.total === undefined ? {} : { total: progress.total }),
  ...(progress.message === undefined ? {} : { message: progress.message }),
});

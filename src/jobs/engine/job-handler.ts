import type { ZodType } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { TerminalJobError } from '../../common/errors/app-error.js';
import type { JobContext } from './job-context.js';
import type { JobType } from '../jobs.schema.js';

export const JOB_HANDLERS = Symbol('JOB_HANDLERS');

/**
 * Thrown by a handler that stopped because {@link JobContext.shouldStop} said
 * so. Control flow for the processor, never an HTTP error.
 *
 * A throw rather than a return: a handler that returned early would be recorded
 * as `SUCCEEDED` with half its work done, and nothing downstream could tell.
 */
export class JobCancelledError extends Error {
  constructor() {
    super(
      'Stopped at a safe point because the job no longer wants this attempt',
    );
    this.name = 'JobCancelledError';
  }
}

// Under a second would ask the busy service again at once, and Redis refuses a
// pause of 0 ms or of NaN.
const MIN_RATE_LIMIT_MS = 1000;

/**
 * Thrown by a handler whose outside service refused it for now and said for
 * how long: a 429 with `Retry-After`. Not the job's failure. The processor
 * pauses the job's queue for {@link retryAfterMs}, so nothing else on it asks
 * the busy service meanwhile, and hands the attempt back uncounted (§6.3d).
 * Only a queue with a limiter can be paused; on any other it is an ordinary
 * failure.
 */
export class JobRateLimitedError extends Error {
  /** At least a second, whatever the service said. */
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    const wait = Number.isFinite(retryAfterMs)
      ? Math.max(Math.ceil(retryAfterMs), MIN_RATE_LIMIT_MS)
      : MIN_RATE_LIMIT_MS;

    super(`A service the job calls is busy; retry after ${wait} ms`);
    this.name = 'JobRateLimitedError';
    this.retryAfterMs = wait;
  }
}

/**
 * The shape the registry holds: handlers of unrelated payload types in one map.
 * Extend {@link JobHandler} instead of implementing this — a direct
 * implementation runs with whatever is in the payload column.
 */
export interface RunnableJobHandler {
  readonly type: JobType;
  run(context: JobContext, rawPayload: unknown): Promise<Prisma.InputJsonValue>;
}

/**
 * Base class for a job type. A subclass declares the type it serves, the schema
 * its payload must satisfy, and `execute`; the registry and the processor never
 * name a job type.
 *
 * What `execute` must assume:
 * - It can run **more than once** for the same job. A delivery is retried after
 *   a transient failure and redelivered after a crash, so every outside effect
 *   needs its own guard (§7.1).
 * - Its return value is stored as `Job.result` and returned to the job's owner,
 *   so it must be JSON-serialisable and must hold nothing the owner may not see.
 * - Throwing `Error` means retry, its message kept from the owner, who is
 *   shown where the log has it; throw `RetryableJobError` when the message is
 *   written for them (§7.7). Throwing `TerminalJobError` means dead-letter
 *   now, without spending the remaining attempts. Throwing `JobCancelledError`
 *   means "I was asked to stop, and stopped somewhere safe". Throwing
 *   `JobRateLimitedError` means "a service I call is busy for this long", and
 *   the whole run happens again after it, from the start — uncounted the
 *   first 20 times a delivery, then as an attempt.
 * - A handler that does its work in batches should call `context.shouldStop()`
 *   between them — never in the middle of one, so a stopped job leaves no
 *   batch half applied. A handler with a single atomic effect need not call it
 *   at all; it simply runs to completion, which is the honest answer to a
 *   cancellation it has no safe point to honour.
 */
export abstract class JobHandler<P> implements RunnableJobHandler {
  abstract readonly type: JobType;

  protected abstract readonly payloadSchema: ZodType<P>;

  protected abstract execute(
    context: JobContext,
    payload: P,
  ): Promise<Prisma.InputJsonValue>;

  // The payload is re-parsed here rather than trusted from the row: a job
  // written by a newer deploy can be delivered to an older worker, and a
  // redelivery can outlive a schema change. `async` so a rejected payload
  // surfaces as a rejected promise like every other failure, instead of
  // escaping the caller's `.catch`.
  async run(context: JobContext, rawPayload: unknown) {
    const parsed = this.payloadSchema.safeParse(rawPayload);

    if (!parsed.success) {
      // Neither retrying nor waiting can make a malformed payload valid.
      throw new TerminalJobError(
        `Payload does not match the schema for ${this.type}: ${parsed.error.message}`,
      );
    }

    return this.execute(context, parsed.data);
  }
}

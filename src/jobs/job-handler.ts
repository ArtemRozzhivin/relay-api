import type { ZodType } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { TerminalJobError } from '../common/errors/app-error.js';
import type { JobContext } from './job-context.js';
import type { JobType } from './jobs.schema.js';

export const JOB_HANDLERS = Symbol('JOB_HANDLERS');

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
 * - Throwing `Error` means retry. Throwing `TerminalJobError` means dead-letter
 *   now, without spending the remaining attempts.
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

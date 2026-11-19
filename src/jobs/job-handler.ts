import type { ZodType } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { TerminalJobError } from '../common/errors/app-error.js';
import type { JobContext } from './job-context.js';
import type { JobType } from './jobs.schema.js';

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
 *   now, without spending the remaining attempts. Throwing `JobCancelledError`
 *   means "I was asked to stop, and stopped somewhere safe".
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

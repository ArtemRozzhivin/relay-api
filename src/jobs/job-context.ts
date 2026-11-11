import type { Prisma } from '../generated/prisma/client.js';
import type { JobProgress } from './job-progress.js';

/**
 * What a handler is allowed to know and do. Handlers receive this rather than
 * the Prisma client, so the surface they can touch is a deliberate list.
 *
 * The job's `idempotencyKey` is deliberately absent. It is unique per tenant,
 * while `SideEffect.effectKey` is unique globally, so a handler keying its
 * effect on it would let one tenant's key suppress another tenant's effect —
 * the victim's job would report success with no effect performed. Effects key on
 * `jobId`, which is unguessable and globally unique.
 */
export interface JobContext {
  readonly jobId: string;

  /** The account the job belongs to: what every write it makes is scoped to. */
  readonly userId: string;

  /**
   * The attempt now running, counted against `maxAttempts` — for logs and
   * messages. Not the ownership token: that is a separate lease the context
   * carries on every write for the handler, so a worker the queue has given up
   * on cannot overwrite the attempt that replaced it (D25).
   */
  readonly attempt: number;

  /**
   * Whether this is the last attempt the job's retry budget allows: if it
   * fails, the job is dead-lettered. A handler that would leave work for a
   * retry records it as failed instead, since no retry is coming.
   */
  readonly lastAttempt: boolean;

  /**
   * Records how far along the job is, for a client to read from
   * `GET /jobs/:id`.
   *
   * Never rejects and never fails a job: progress is presentational, and a
   * handler is free to report without awaiting.
   *
   * Reports are **throttled**: one write at a time reaches the database and the
   * socket, the next no sooner than 500ms after it finished, and a report
   * arriving in between replaces whatever was waiting. So awaiting this does *not* mean "my value is
   * stored" — an intermediate value may be coalesced away. What is guaranteed
   * is that the **last** value reported lands before the job finishes, which is
   * why reporting per row is safe and needs no throttling by the handler.
   *
   * A report that goes *backwards*, or that arrives once this attempt has lost
   * the job, is dropped; an equal count is accepted, so `message` can be revised
   * without advancing. `total` and `message` are remembered, so a later report
   * may omit them.
   */
  reportProgress(progress: JobProgress): Promise<void>;

  /**
   * Whether this attempt should stop at the boundary it has reached. True when
   * the job's owner asked for it to be cancelled, when this attempt no longer
   * owns the job — nothing more it does will count — or when the worker is
   * shutting down and the job goes back to the queue for the next one. One
   * question covers all three so a handler has a single thing to check.
   *
   * Reads the database, so call it between batches rather than per item. When
   * it is true, stop and throw `JobCancelledError`; never return, which would
   * record a partial run as a success.
   *
   * @throws when the database cannot be reached. Unlike a progress report this
   * is a decision about whether to keep doing work, so a failure to answer it
   * fails the attempt rather than being guessed.
   */
  shouldStop(): Promise<boolean>;

  /**
   * What the last {@link commit} recorded for this job — by an earlier attempt,
   * or by an earlier life before a re-drive — or `null` when nothing has been
   * committed. Its shape is the handler's own, and so is checking it: a value an
   * older version wrote may not parse, and must not be trusted if it does not.
   */
  readonly checkpoint: Prisma.JsonValue | null;

  /**
   * Commits one batch of work together with the checkpoint that describes it,
   * in one transaction, so a later attempt can skip exactly the work that
   * committed.
   *
   * One of the two places a handler is handed a database client, because
   * atomicity needs it: `work` must make every write through `tx` and do nothing else
   * — no event, no HTTP call — since a rollback cannot take those back (A10).
   *
   * @param checkpoint builds the value to store from what `work` returned; it
   * must be enough to resume from, including any running totals the result
   * reports.
   * @returns what `work` returned.
   * @throws JobCancelledError when this attempt no longer owns the job. The
   * batch was rolled back, so let it propagate.
   */
  commit<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    checkpoint: (value: T) => Prisma.InputJsonValue,
  ): Promise<T>;

  /**
   * Commits the job's one irreversible effect — a charge's ledger row — in a
   * transaction that also marks the job as having it. From then on nothing
   * cancels the job from outside: a cancel answers that it was asked, and the
   * next delivery's handler finds the effect and finishes the job as a
   * success. For a job whose work is a single effect, not batches.
   *
   * `work` writes through `tx` only, as for `commit`.
   *
   * @returns what `work` returned.
   * @throws JobCancelledError when this attempt no longer owns the job; the
   * effect was rolled back. Whatever `work` throws — a unique violation that
   * proves an earlier attempt's effect, say — propagates unchanged.
   */
  commitEffect<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;

  /** Writes one line tagged with the job, the attempt and the request that submitted it. */
  log(message: string): void;
}

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

  /**
   * The attempt now running. Also the ownership token: a write made on behalf of
   * this attempt must carry it, so a worker the queue has given up on cannot
   * overwrite the attempt that replaced it (D25).
   */
  readonly attempt: number;

  /**
   * Records how far along the job is, for a client to read from
   * `GET /jobs/:id`.
   *
   * Never rejects and never fails a job: progress is presentational, and a
   * handler is free to report without awaiting.
   *
   * Reports are **throttled**: at most one reaches the database and the socket
   * per job every 500ms, and a report arriving inside that window replaces
   * whatever was waiting. So awaiting this does *not* mean "my value is
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
   * the job's owner asked for it to be cancelled, **or** when this attempt no
   * longer owns the job — both mean nothing more it does will count, and one
   * question covers both so a handler has a single thing to check.
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

  /** Writes one line tagged with the job, the attempt and the request that submitted it. */
  log(message: string): void;
}

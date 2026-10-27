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
}

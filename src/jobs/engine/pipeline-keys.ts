// What every key the server mints for a pipeline's jobs begins with. A client's
// own Idempotency-Key may not: the two share UNIQUE (userId, idempotencyKey),
// and a client key in this form could take a batch's key first (§6.3e).
export const PIPELINE_KEY_PREFIX = 'pipeline:';

/**
 * The idempotency key of one of a pipeline's jobs: deterministic, so writing
 * the job again is refused by the unique key rather than doubling it (D23).
 *
 * @example pipelineKey(id, 'enrich', 3) // 'pipeline:<id>:enrich:3'
 */
export const pipelineKey = (
  pipelineId: string,
  ...parts: (string | number)[]
) => [PIPELINE_KEY_PREFIX + pipelineId, ...parts].join(':');

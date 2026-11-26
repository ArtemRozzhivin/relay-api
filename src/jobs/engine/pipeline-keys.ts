// What every key the server mints for a pipeline's jobs begins with. A client's
// own Idempotency-Key may not: the two share UNIQUE (userId, idempotencyKey),
// and a client key in this form could take a batch's key first (§6.3e).
export const PIPELINE_KEY_PREFIX = 'pipeline:';

/**
 * The stages a pipeline's jobs belong to. Part of every key below, which is
 * stored and read back — finalize finds the import by rebuilding its key — so
 * a stage is one of these or does not compile.
 */
export type PipelineStage = 'import' | 'enrich' | 'images' | 'finalize';

/**
 * The idempotency key of one of a pipeline's jobs: deterministic, so writing
 * the job again is refused by the unique key rather than doubling it (D23).
 *
 * @param batch a batch's place among its stage's batches; none for the
 * stage's one job.
 * @example pipelineKey(id, 'enrich', 3) // 'pipeline:<id>:enrich:3'
 */
export const pipelineKey = (
  pipelineId: string,
  stage: PipelineStage,
  batch?: number,
) =>
  [
    PIPELINE_KEY_PREFIX + pipelineId,
    stage,
    ...(batch === undefined ? [] : [batch]),
  ].join(':');

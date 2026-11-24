import { z, type ZodType } from 'zod';
import type { Prisma } from '../../../generated/prisma/client.js';
import type {
  JobStatus,
  PipelineStatus,
} from '../../../generated/prisma/enums.js';

/** One of a pipeline's jobs, as its summary reads it. */
export interface SummarizedJob {
  type: string;
  status: JobStatus;
  result: Prisma.JsonValue | null;
}

const count = z.number().int().nonnegative();

// Only the counts a summary adds up. A result an older version wrote without
// one is read as nothing, never as a reason to fail the summary.
const importCounts = z.object({
  rows: count,
  imported: count,
  invalid: count,
});
const enrichCounts = z.object({ enriched: count, failed: count });
const imageCounts = z.object({ processed: count, failed: count });

const total = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0);

const stage = <T>(
  batches: SummarizedJob[],
  type: string,
  counts: ZodType<T>,
) => {
  const ofType = batches.filter((batch) => batch.type === type);
  const succeeded = ofType.filter(({ status }) => status === 'SUCCEEDED');

  return {
    batches: ofType.length,
    failedBatches: ofType.length - succeeded.length,
    results: succeeded.flatMap(({ result }) => {
      const parsed = counts.safeParse(result);

      return parsed.success ? [parsed.data] : [];
    }),
  };
};

/**
 * What a pipeline did, added up from its jobs (§6.3e): each stage from the
 * jobs of its type. A product's count comes only from a batch that succeeded:
 * a dead-lettered batch recorded nothing it could be counted by.
 */
export const summarize = (
  importJob: SummarizedJob | undefined,
  jobs: SummarizedJob[],
) => {
  const imported =
    importJob?.status === 'SUCCEEDED'
      ? importCounts.safeParse(importJob.result)
      : undefined;
  const enrich = stage(jobs, 'ai.enrich', enrichCounts);
  const images = stage(jobs, 'image.process', imageCounts);

  return {
    import: imported?.success ? imported.data : null,
    enrich: {
      batches: enrich.batches,
      failedBatches: enrich.failedBatches,
      enriched: total(enrich.results.map(({ enriched }) => enriched)),
      failed: total(enrich.results.map(({ failed }) => failed)),
    },
    images: {
      batches: images.batches,
      failedBatches: images.failedBatches,
      processed: total(images.results.map(({ processed }) => processed)),
      failed: total(images.results.map(({ failed }) => failed)),
    },
  };
};

/**
 * How a pipeline ended (§6.3e). From the import's status as the pipeline
 * finishes, and from how many of its jobs did not succeed the first time they
 * finished — which a re-drive since cannot change.
 */
export const finalStatus = (
  importSucceeded: boolean,
  failedChildren: number,
): Exclude<PipelineStatus, 'RUNNING'> => {
  if (!importSucceeded) {
    return 'FAILED';
  }

  return failedChildren > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
};

import { describe, expect, it } from 'vitest';
import {
  finalStatus,
  summarize,
  type SummarizedJob,
} from './pipeline-summary.js';

const importJob: SummarizedJob = {
  type: 'import.csv',
  status: 'SUCCEEDED',
  result: { rows: 120, imported: 118, invalid: 2, invalidSamples: [] },
};

const enrich = (
  status: SummarizedJob['status'],
  result: SummarizedJob['result'] = null,
): SummarizedJob => ({ type: 'ai.enrich', status, result });

const images = (
  status: SummarizedJob['status'],
  result: SummarizedJob['result'] = null,
): SummarizedJob => ({ type: 'image.process', status, result });

describe('summarize', () => {
  it("adds up the import's rows and each stage's products, by stage", () => {
    expect(
      summarize(importJob, [
        enrich('SUCCEEDED', { enriched: 18, failed: 2, superseded: 0 }),
        enrich('SUCCEEDED', { enriched: 5, failed: 0, superseded: 0 }),
        images('SUCCEEDED', { processed: 40, failed: 1, alreadyReady: 9 }),
      ]),
    ).toEqual({
      import: { rows: 120, imported: 118, invalid: 2 },
      enrich: { batches: 2, failedBatches: 0, enriched: 23, failed: 2 },
      images: { batches: 1, failedBatches: 0, processed: 40, failed: 1 },
    });
  });

  it('counts a batch that did not succeed, and none of its products', () => {
    expect(
      summarize(importJob, [
        enrich('SUCCEEDED', { enriched: 20, failed: 0 }),
        enrich('DEAD_LETTERED'),
        enrich('CANCELLED'),
      ]).enrich,
    ).toEqual({ batches: 3, failedBatches: 2, enriched: 20, failed: 0 });
  });

  it('has no import counts for an import that did not succeed', () => {
    expect(
      summarize({ ...importJob, status: 'DEAD_LETTERED', result: null }, [])
        .import,
    ).toBeNull();
  });

  it('reads a result it cannot read as no products, not as an error', () => {
    expect(
      summarize(importJob, [enrich('SUCCEEDED', { enriched: 'many' })]).enrich,
    ).toEqual({ batches: 1, failedBatches: 0, enriched: 0, failed: 0 });
  });

  it('has empty stages for a pipeline that made no batches', () => {
    expect(summarize(importJob, [])).toMatchObject({
      enrich: { batches: 0, failedBatches: 0, enriched: 0, failed: 0 },
      images: { batches: 0, failedBatches: 0, processed: 0, failed: 0 },
    });
  });
});

describe('finalStatus', () => {
  it.each([
    [true, 0, 'COMPLETED'],
    [true, 1, 'COMPLETED_WITH_ERRORS'],
    [false, 1, 'FAILED'],
    // Whatever the count: without its import, nothing else in the pipeline
    // had a file to come from.
    [false, 0, 'FAILED'],
  ] as const)(
    'import succeeded %s, %i failed first finishes: %s',
    (importSucceeded, failedChildren, status) => {
      expect(finalStatus(importSucceeded, failedChildren)).toBe(status);
    },
  );
});

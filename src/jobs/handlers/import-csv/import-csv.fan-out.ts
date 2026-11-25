import { ENRICH_BATCH_MAX, IMAGE_BATCH_MAX } from '../../jobs.schema.js';
import { chunked } from '../../../common/collections/chunked.js';
import type { PipelineBatch } from '../../engine/job-context.js';
import {
  hasImageForCurrentUrl,
  isEnrichedForCurrentText,
} from '../../../products/product-state.js';

/** A batch of the two stages an import fans out into. */
export type ImportBatch = Extract<
  PipelineBatch,
  { type: 'ai.enrich' | 'image.process' }
>;

/** A product as the fan-out reads it. */
export type FanOutProduct = Parameters<typeof isEnrichedForCurrentText>[0] &
  Parameters<typeof hasImageForCurrentUrl>[0] & { sku: string };

/**
 * Sorts a pipeline's products into its batches as they are read (§6.3e). A
 * product goes to the stages it still needs, by the skips the two handlers
 * make themselves, so no batch is made that would do nothing. Keeps skus
 * only, however long the file.
 */
export class FanOutPlan {
  private readonly enrich: string[] = [];
  private readonly images: string[] = [];

  add(product: FanOutProduct) {
    if (!isEnrichedForCurrentText(product)) {
      this.enrich.push(product.sku);
    }

    if (product.imageUrl !== null && !hasImageForCurrentUrl(product)) {
      this.images.push(product.sku);
    }
  }

  /**
   * In the order the products were added, so the same products make the same
   * batches, under the same keys, on every attempt.
   */
  batches(): ImportBatch[] {
    return [
      ...chunked(this.enrich, ENRICH_BATCH_MAX).map((skus) => ({
        stage: 'enrich' as const,
        type: 'ai.enrich' as const,
        payload: { skus },
      })),
      ...chunked(this.images, IMAGE_BATCH_MAX).map((skus) => ({
        stage: 'images' as const,
        type: 'image.process' as const,
        payload: { skus },
      })),
    ];
  }
}

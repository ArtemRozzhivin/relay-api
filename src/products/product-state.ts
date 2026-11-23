import { hashEnrichmentInput } from '../enrichment/enrichment-input.js';

/**
 * Whether ai.enrich has an answer for the product's current name and
 * description (§6.3d). A `FAILED` one has not: asking again is how its owner
 * gets another answer.
 */
export const isEnrichedForCurrentText = (product: {
  name: string;
  description: string | null;
  enrichmentStatus: string | null;
  enrichmentInputHash: string | null;
}) =>
  product.enrichmentStatus === 'READY' &&
  product.enrichmentInputHash === hashEnrichmentInput(product);

/**
 * Whether image.process has made the sizes of the product's current
 * `imageUrl` (§6.3c). A `FAILED` one has not: the seller may have fixed the
 * file behind the same URL.
 */
export const hasImageForCurrentUrl = (product: {
  imageUrl: string | null;
  imageStatus: string | null;
  imageSourceUrl: string | null;
}) =>
  product.imageUrl !== null &&
  product.imageSourceUrl === product.imageUrl &&
  product.imageStatus === 'READY';

import { hashEnrichmentInput } from '../enrichment/enrichment-input.js';

/**
 * What a handler concluded about one input of a product: `imageStatus` and
 * `enrichmentStatus` hold one of these, or nothing yet (a `CHECK`).
 */
export type Conclusion = 'READY' | 'FAILED';

/** Where a product stands for its input as it is now. */
export type ProductState = Conclusion | 'PENDING';

// Text in the schema; anything but a conclusion reads as none.
const concluded = (status: string | null): ProductState =>
  status === 'READY' || status === 'FAILED' ? status : 'PENDING';

/**
 * What image.process concluded about the product's current `imageUrl`
 * (§6.3c), or `PENDING`: never concluded, or concluded about a URL the
 * product has since replaced.
 */
export const imageState = (product: {
  imageUrl: string | null;
  imageStatus: string | null;
  imageSourceUrl: string | null;
}): ProductState =>
  product.imageUrl !== null && product.imageSourceUrl === product.imageUrl
    ? concluded(product.imageStatus)
    : 'PENDING';

/**
 * What ai.enrich concluded from the product's current name and description
 * (§6.3d), or `PENDING`: never concluded, or concluded from text the product
 * has since replaced.
 */
export const enrichmentState = (product: {
  name: string;
  description: string | null;
  enrichmentStatus: string | null;
  enrichmentInputHash: string | null;
}): ProductState =>
  product.enrichmentInputHash === hashEnrichmentInput(product)
    ? concluded(product.enrichmentStatus)
    : 'PENDING';

/**
 * Whether ai.enrich has an answer for the product's current name and
 * description. A `FAILED` one has not: asking again is how its owner gets
 * another answer.
 */
export const isEnrichedForCurrentText = (
  product: Parameters<typeof enrichmentState>[0],
) => enrichmentState(product) === 'READY';

/**
 * Whether image.process has made the sizes of the product's current
 * `imageUrl`. A `FAILED` one has not: the seller may have fixed the file
 * behind the same URL.
 */
export const hasImageForCurrentUrl = (
  product: Parameters<typeof imageState>[0],
) => imageState(product) === 'READY';

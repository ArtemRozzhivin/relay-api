// What a product image is made as, apart from the renderer that makes it: the
// keys it is stored under and the view that links to it read this, and have no
// reason to depend on an image library.

/**
 * The sizes every product image is made in, by their longest side: a 1200 px
 * large is at most 1200 × 1200, whatever shape the source.
 */
export const IMAGE_SIZES = [
  { name: 'thumb', width: 200 },
  { name: 'medium', width: 600 },
  { name: 'large', width: 1200 },
] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number]['name'];

/**
 * What every size is made as. The renderer, the stored key's extension and the
 * upload's Content-Type read it here, so the three cannot disagree.
 */
export const RENDERED_FORMAT = {
  extension: 'webp',
  contentType: 'image/webp',
} as const;

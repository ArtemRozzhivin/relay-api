import sharp from 'sharp';

/** The sizes every product image is made in, by width. */
export const IMAGE_SIZES = [
  { name: 'thumb', width: 200 },
  { name: 'medium', width: 600 },
  { name: 'large', width: 1200 },
] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number]['name'];

// A small file can declare enormous dimensions — a "decompression bomb" — and
// decoding it would take gigabytes. 40 megapixels is a 7 300 × 5 500 photo,
// beyond anything a product page shows.
const MAX_INPUT_PIXELS = 40_000_000;

/**
 * Makes each size of an image as WebP: turned upright by its EXIF orientation,
 * never enlarged, and without the source's metadata, which can carry the
 * camera's location.
 *
 * @throws when the bytes are not an image sharp can decode, or exceed the
 * pixel limit.
 */
export const renderSizes = async (source: Buffer) => {
  const image = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS });

  return Promise.all(
    IMAGE_SIZES.map(async ({ name, width }) => ({
      name,
      body: await image
        .clone()
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer(),
    })),
  );
};

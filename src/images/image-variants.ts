import sharp from 'sharp';
import { IMAGE_SIZES, RENDERED_FORMAT } from './image-output.js';

// A small file can declare enormous dimensions — a "decompression bomb" — and
// decoding it would take gigabytes. 40 megapixels is a 7 300 × 5 500 photo,
// beyond anything a product page shows.
const MAX_INPUT_PIXELS = 40_000_000;

// What sharp found in the bytes, whatever the server said they were: sharp
// picks its decoder by sniffing, so a Content-Type check alone would still
// hand it an SVG — a document that can refer to other files — or a TIFF. AVIF
// reads as heif.
const DECODED_FORMATS: ReadonlySet<string> = new Set([
  'jpeg',
  'png',
  'webp',
  'gif',
  'heif',
]);

/**
 * Makes each size of an image in {@link RENDERED_FORMAT}: turned upright by its EXIF orientation,
 * fitted inside a square of the size's side, never enlarged, and without the
 * source's metadata, which can carry the camera's location. Bounding both
 * sides is what bounds the bytes: by width alone, a 1200 × 16 000 source made
 * a 13 MB product in a folder that never expires.
 *
 * @throws when the bytes are not a photo format sharp can decode, or exceed
 * the pixel limit.
 */
export const renderSizes = async (source: Buffer) => {
  const image = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS });
  const { format } = await image.metadata();

  if (!DECODED_FORMATS.has(format)) {
    throw new Error(`${format} is not an accepted image format`);
  }

  return Promise.all(
    IMAGE_SIZES.map(async ({ name, width }) => ({
      name,
      body: await image
        .clone()
        .rotate()
        .resize({
          width,
          height: width,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toFormat(RENDERED_FORMAT.extension, { quality: 80 })
        .toBuffer(),
    })),
  );
};

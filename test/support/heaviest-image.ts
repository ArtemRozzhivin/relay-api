import sharp from 'sharp';

/**
 * The most decoding a byte can buy within `image.process`'s limits: a PNG of
 * 35 megapixels, just under the 40 MP refusal, in under a megabyte — repeated
 * rows compress to almost nothing, and PNG, unlike JPEG, cannot be shrunk
 * while it is decoded, so every pixel is.
 */
export const heaviestImage = async () => {
  const [width, height] = [7000, 5000];
  const row = await sharp({
    create: {
      width: width / 10,
      height: 1,
      channels: 3,
      background: '#000',
      noise: { type: 'gaussian', mean: 128, sigma: 60 },
    },
  })
    .png()
    .toBuffer();
  const pixels = await sharp(row)
    .resize(width, height, { kernel: 'nearest', fit: 'fill' })
    .raw()
    .toBuffer();

  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
};

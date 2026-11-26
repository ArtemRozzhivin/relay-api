import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { renderSizes } from './image-variants.js';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#36c' } });

const dimensionsOf = async (sizes: { name: string; body: Buffer }[]) =>
  Promise.all(
    sizes.map(async ({ name, body }) => {
      const { format, width, height } = await sharp(body).metadata();

      return `${name} ${format} ${width}×${height}`;
    }),
  );

describe('renderSizes', () => {
  // By width alone, a 1200 × 16 000 source made a 13 MB product in a folder
  // that never expires.
  it('fits a tall image inside each size’s square', async () => {
    const sizes = await renderSizes(await solid(300, 3000).png().toBuffer());

    expect(await dimensionsOf(sizes)).toEqual([
      'thumb webp 20×200',
      'medium webp 60×600',
      'large webp 120×1200',
    ]);
  });

  it('fits a wide one by its width, as before', async () => {
    const sizes = await renderSizes(await solid(2400, 1200).jpeg().toBuffer());

    expect(await dimensionsOf(sizes)).toEqual([
      'thumb webp 200×100',
      'medium webp 600×300',
      'large webp 1200×600',
    ]);
  });

  // sharp picks its decoder from the bytes, whatever the server called them.
  it.each([
    [
      'svg',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
      ),
    ],
    ['tiff', null],
  ])('refuses %s bytes', async (format, bytes) => {
    const source = bytes ?? (await solid(10, 10).tiff().toBuffer());

    await expect(renderSizes(source)).rejects.toThrow(
      `${format} is not an accepted image format`,
    );
  });
});

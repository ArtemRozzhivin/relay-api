import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cursorParam, toPage } from './cursor.js';

const position = cursorParam(z.object({ sku: z.string() }));

describe('toPage', () => {
  const skuOf = (sku: string) => ({ sku });

  it('returns a cursor only when the extra row proves a next page', () => {
    expect(toPage(['a', 'b', 'c'], 2, skuOf)).toEqual({
      items: ['a', 'b'],
      nextCursor: expect.any(String),
    });
    expect(toPage(['a', 'b'], 2, skuOf)).toEqual({
      items: ['a', 'b'],
      nextCursor: null,
    });
    expect(toPage([], 2, skuOf)).toEqual({ items: [], nextCursor: null });
  });

  it('issues a cursor its list reads back as the last item', () => {
    const { nextCursor } = toPage(['a', 'b', 'c'], 2, skuOf);

    expect(position.parse(nextCursor)).toEqual({ sku: 'b' });
  });
});

describe('cursorParam', () => {
  it.each([
    ['garbage', 'not a cursor'],
    ['base64 of something other than JSON', 'bm90LWpzb24'],
    ['JSON of another shape', Buffer.from('{"id":1}').toString('base64url')],
  ])('refuses %s', (_label, token) => {
    expect(position.safeParse(token).success).toBe(false);
  });
});

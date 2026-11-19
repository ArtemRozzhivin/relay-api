import { describe, expect, it } from 'vitest';
import { toPage } from '../common/pagination/cursor.js';
import { SKU_MAX_LENGTH, listProductsSchema } from './products.schema.js';

const cursorAfter = (sku: string) =>
  toPage([{ sku }, { sku: 'next' }], 1, (product) => ({ sku: product.sku }))
    .nextCursor;

describe('listProductsSchema', () => {
  // JSON writes each control character as six, and an import accepts a sku
  // of them: the list must still read back the cursor it issued after one.
  it('reads back its cursor after the longest sku of the widest characters', () => {
    const sku = '\u0001'.repeat(SKU_MAX_LENGTH);

    expect(listProductsSchema.parse({ cursor: cursorAfter(sku) })).toEqual({
      limit: 20,
      cursor: { sku },
    });
  });

  it('refuses a cursor carrying a NUL character, which Postgres cannot compare', () => {
    expect(
      listProductsSchema.safeParse({ cursor: cursorAfter('A\u0000') }).success,
    ).toBe(false);
  });
});

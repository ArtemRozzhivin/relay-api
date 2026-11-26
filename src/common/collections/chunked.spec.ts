import { describe, expect, it } from 'vitest';
import { chunked } from './chunked.js';

describe('chunked', () => {
  it('keeps the order, and puts what is left in the last slice', () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('makes no empty slice for an exact multiple, nor for nothing', () => {
    expect(chunked([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(chunked([], 2)).toEqual([]);
  });
});

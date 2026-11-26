import { describe, expect, it } from 'vitest';
import { hashEnrichmentInput } from '../enrichment/enrichment-input.js';
import { enrichmentState, imageState } from './product-state.js';

describe('imageState', () => {
  const url = 'https://example.com/mug.png';

  it.each([
    [
      'no conclusion yet',
      { imageStatus: null, imageSourceUrl: null },
      'PENDING',
    ],
    [
      'a conclusion about a URL since replaced',
      { imageStatus: 'READY', imageSourceUrl: 'https://example.com/old.png' },
      'PENDING',
    ],
    [
      'made for this URL',
      { imageStatus: 'READY', imageSourceUrl: url },
      'READY',
    ],
    [
      'failed for this URL',
      { imageStatus: 'FAILED', imageSourceUrl: url },
      'FAILED',
    ],
  ] as const)('reads %s as %s', (_label, columns, state) => {
    expect(imageState({ imageUrl: url, ...columns })).toBe(state);
  });

  it('reads a product with no image URL as nothing concluded', () => {
    expect(
      imageState({ imageUrl: null, imageStatus: null, imageSourceUrl: null }),
    ).toBe('PENDING');
  });
});

describe('enrichmentState', () => {
  const text = { name: 'Mug', description: 'Blue' };
  const current = hashEnrichmentInput(text);

  it.each([
    [
      'no conclusion yet',
      { enrichmentStatus: null, enrichmentInputHash: null },
      'PENDING',
    ],
    [
      'a conclusion about text since replaced',
      {
        enrichmentStatus: 'READY',
        enrichmentInputHash: hashEnrichmentInput({ ...text, name: 'Cup' }),
      },
      'PENDING',
    ],
    [
      'enriched from this text',
      { enrichmentStatus: 'READY', enrichmentInputHash: current },
      'READY',
    ],
    [
      'failed on this text',
      { enrichmentStatus: 'FAILED', enrichmentInputHash: current },
      'FAILED',
    ],
  ] as const)('reads %s as %s', (_label, columns, state) => {
    expect(enrichmentState({ ...text, ...columns })).toBe(state);
  });
});

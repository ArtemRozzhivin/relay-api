import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from './llm-provider.js';

describe('estimateCostUsd', () => {
  const price = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5 };

  // Output costs several times input at every provider, so a swap of the two
  // would understate most jobs' cost.
  it('prices each direction at its own rate', () => {
    expect(estimateCostUsd(price, { tokensIn: 1_000_000, tokensOut: 0 })).toBe(
      1,
    );
    expect(estimateCostUsd(price, { tokensIn: 0, tokensOut: 1_000_000 })).toBe(
      5,
    );
    expect(
      estimateCostUsd(price, { tokensIn: 1000, tokensOut: 200 }),
    ).toBeCloseTo(0.002, 12);
  });
});

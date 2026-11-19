import { describe, expect, it } from 'vitest';
import { requestHash } from './request-hash.js';
import { submitJobSchema } from './jobs.schema.js';

const parsed = (body: unknown) => submitJobSchema.parse(body);

describe('requestHash', () => {
  it('ignores the order of keys', () => {
    expect(
      requestHash(
        parsed({
          type: 'CHARGE',
          payload: { amountCents: 100, reference: 'inv-1' },
        }),
      ),
    ).toBe(
      requestHash(
        parsed({
          payload: { reference: 'inv-1', amountCents: 100 },
          type: 'CHARGE',
        }),
      ),
    );
  });

  it('treats a default left out and the same default sent as one request', () => {
    expect(
      requestHash(parsed({ type: 'MOCK', payload: { durationMs: 10 } })),
    ).toBe(
      requestHash(
        parsed({ type: 'MOCK', payload: { durationMs: 10 }, maxAttempts: 5 }),
      ),
    );
  });

  it.each([
    ['a payload value', { payload: { amountCents: 200, reference: 'inv-1' } }],
    ['the retry budget', { maxAttempts: 3 }],
  ])('tells two requests apart by %s', (_label, change) => {
    const original = {
      type: 'CHARGE',
      payload: { amountCents: 100, reference: 'inv-1' },
    };

    expect(requestHash(parsed({ ...original, ...change }))).not.toBe(
      requestHash(parsed(original)),
    );
  });
});

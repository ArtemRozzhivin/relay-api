import { describe, expect, it } from 'vitest';
import {
  JOB_TYPES,
  mockPayloadSchema,
  submitJobSchema,
} from './jobs.schema.js';

describe('submitJobSchema', () => {
  it('rejects an unknown field in the payload', () => {
    const parsed = submitJobSchema.safeParse({
      type: 'MOCK',
      payload: { durationMs: 10, durationMS: 10 },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown field in the body', () => {
    const parsed = submitJobSchema.safeParse({
      type: 'MOCK',
      payload: { durationMs: 10 },
      status: 'SUCCEEDED',
    });

    expect(parsed.success).toBe(false);
  });

  it('lists every type the union accepts', () => {
    expect(JOB_TYPES).toEqual(['MOCK', 'CHARGE']);
  });
});

describe('payload schemas', () => {
  it('drop an unknown field instead of failing, for the worker re-parse', () => {
    const parsed = mockPayloadSchema.safeParse({
      durationMs: 10,
      currency: 'EUR',
    });

    expect(parsed).toMatchObject({
      success: true,
      data: { durationMs: 10, failureRate: 0 },
    });
    expect(parsed.success && 'currency' in parsed.data).toBe(false);
  });
});

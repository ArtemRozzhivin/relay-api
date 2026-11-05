import { describe, expect, it } from 'vitest';
import {
  JOB_TYPES,
  bulkRedriveSchema,
  listJobsSchema,
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
    expect(JOB_TYPES).toEqual(['MOCK', 'CHARGE', 'import.csv']);
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

describe('listJobsSchema', () => {
  // Derived from the generated enum, so a status added to the state machine is
  // filterable without anyone remembering to add it here.
  it.each(['QUEUED', 'RUNNING', 'SUCCEEDED', 'DEAD_LETTERED', 'CANCELLED'])(
    'accepts %s as a status filter',
    (status) => {
      expect(listJobsSchema.safeParse({ status }).success).toBe(true);
    },
  );

  it('rejects a status the state machine does not have', () => {
    expect(listJobsSchema.safeParse({ status: 'FAILED' }).success).toBe(false);
  });
});

describe('bulkRedriveSchema', () => {
  const window = {
    deadLetteredFrom: '2026-10-28T02:00:00Z',
    deadLetteredTo: '2026-10-28T03:00:00Z',
  };

  // An empty body is what a client bug sends, and it would mean every dead
  // letter the caller has.
  it('refuses a request with no filter at all', () => {
    expect(bulkRedriveSchema.safeParse({}).success).toBe(false);
    expect(bulkRedriveSchema.safeParse({ dryRun: true }).success).toBe(false);
  });

  it.each([
    ['a type', { type: 'MOCK' }],
    ['an error code', { errorCode: 'DELIVERY_ABANDONED' }],
    ['a window', window],
    ['an open-ended window', { deadLetteredFrom: window.deadLetteredFrom }],
  ])('accepts %s on its own', (_label, filter) => {
    expect(bulkRedriveSchema.safeParse(filter).success).toBe(true);
  });

  it('turns the window into instants', () => {
    const parsed = bulkRedriveSchema.parse(window);

    expect(parsed.deadLetteredFrom).toEqual(new Date('2026-10-28T02:00:00Z'));
    expect(parsed.deadLetteredTo).toEqual(new Date('2026-10-28T03:00:00Z'));
  });

  // "02:00" with no zone is a different instant on every machine that reads it.
  it('refuses a time without a timezone', () => {
    expect(
      bulkRedriveSchema.safeParse({ deadLetteredFrom: '2026-10-28T02:00:00' })
        .success,
    ).toBe(false);
  });

  it('accepts an offset as well as Z', () => {
    expect(
      bulkRedriveSchema.safeParse({
        deadLetteredFrom: '2026-10-28T04:00:00+02:00',
      }).success,
    ).toBe(true);
  });

  it('refuses a window that ends before it starts', () => {
    expect(
      bulkRedriveSchema.safeParse({
        deadLetteredFrom: window.deadLetteredTo,
        deadLetteredTo: window.deadLetteredFrom,
      }).success,
    ).toBe(false);
  });

  // A misspelt code would otherwise match nothing and read as "nothing to do".
  it('refuses an error code no job is ever dead-lettered with', () => {
    expect(
      bulkRedriveSchema.safeParse({ errorCode: 'ATTEMPT_FAILED' }).success,
    ).toBe(false);
    expect(
      bulkRedriveSchema.safeParse({ errorCode: 'ATTEMPTS_EXHAUSTD' }).success,
    ).toBe(false);
  });

  it('bounds the batch, and defaults to a real run of 500', () => {
    expect(bulkRedriveSchema.parse({ type: 'MOCK' })).toMatchObject({
      limit: 500,
      dryRun: false,
    });
    expect(
      bulkRedriveSchema.safeParse({ type: 'MOCK', limit: 1001 }).success,
    ).toBe(false);
    expect(
      bulkRedriveSchema.safeParse({ type: 'MOCK', limit: 0 }).success,
    ).toBe(false);
  });
});

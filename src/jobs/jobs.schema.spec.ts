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
    expect(JOB_TYPES).toEqual([
      'MOCK',
      'CHARGE',
      'import.csv',
      'image.process',
    ]);
  });
});

describe('the image.process payload', () => {
  const submit = (skus: unknown) =>
    submitJobSchema.safeParse({ type: 'image.process', payload: { skus } })
      .success;

  it('takes a batch of up to 50 skus', () => {
    expect(submit(['A-1'])).toBe(true);
    expect(submit(Array.from({ length: 50 }, (_, i) => `S-${i}`))).toBe(true);
  });

  it.each([
    ['no skus', []],
    ['more than 50', Array.from({ length: 51 }, (_, i) => `S-${i}`)],
    ['a blank sku', ['  ']],
    ['a sku longer than a product can have', ['x'.repeat(101)]],
  ])('refuses %s', (_label, skus) => {
    expect(submit(skus)).toBe(false);
  });
});

// Postgres refuses it in jsonb, so a payload carrying one failed at the
// insert, as a 500.
describe('a NUL character in a payload', () => {
  it.each([
    [
      'a charge reference',
      {
        type: 'CHARGE',
        payload: { amountCents: 100, reference: 'inv\u00001' },
      },
    ],
    [
      'an image sku',
      { type: 'image.process', payload: { skus: ['A\u00001'] } },
    ],
  ])('in %s is refused at the edge', (_label, body) => {
    expect(submitJobSchema.safeParse(body).success).toBe(false);
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

  it('reads a cursor as the instant and id the last page ended on', () => {
    const cursor = Buffer.from(
      JSON.stringify({
        createdAt: '2026-11-09T10:00:00.123Z',
        id: '0318b953-7c93-4af3-ba9b-d51c30a11d8b',
      }),
    ).toString('base64url');

    expect(listJobsSchema.parse({ cursor }).cursor).toEqual({
      createdAt: new Date('2026-11-09T10:00:00.123Z'),
      id: '0318b953-7c93-4af3-ba9b-d51c30a11d8b',
    });
  });

  // An offset would be ignored by keyset paging, and a client still sending
  // one would be shown page one for ever.
  it('refuses an offset rather than ignoring it', () => {
    expect(listJobsSchema.safeParse({ offset: '20' }).success).toBe(false);
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

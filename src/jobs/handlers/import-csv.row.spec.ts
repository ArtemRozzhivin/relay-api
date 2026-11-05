import { describe, expect, it } from 'vitest';
import { TerminalJobError } from '../../common/errors/app-error.js';
import {
  csvRowSchema,
  describeInvalidRow,
  readHeader,
} from './import-csv.row.js';

const row = (overrides: Record<string, string | undefined> = {}) => ({
  sku: 'A-1',
  name: 'Mug',
  price: '8.99',
  currency: 'EUR',
  ...overrides,
});

const reason = (record: Record<string, string | undefined>) => {
  const parsed = csvRowSchema.safeParse(record);

  return parsed.success ? undefined : describeInvalidRow(parsed.error);
};

describe('readHeader', () => {
  it('maps the columns it knows, whatever their case, and skips the rest', () => {
    expect(
      readHeader(['SKU', ' Name ', 'Price', 'currency', 'ImageURL', 'Weight']),
    ).toEqual(['sku', 'name', 'price', 'currency', 'imageUrl', undefined]);
  });

  it('refuses a file without a required column, naming it', () => {
    expect(() => readHeader(['sku', 'name', 'currency'])).toThrow(
      TerminalJobError,
    );
    expect(() => readHeader(['sku', 'name', 'currency'])).toThrow(/price/);
  });
});

describe('csvRowSchema', () => {
  it.each([
    ['19.99', 1999],
    ['5', 500],
    ['5.5', 550],
    ['0.05', 5],
    ['9999999.99', 999_999_999],
  ])('reads a price of %s as %i cents, without a float', (price, cents) => {
    expect(csvRowSchema.parse(row({ price }))).toMatchObject({
      priceCents: cents,
    });
  });

  it.each(['1.999', '-1', '1e3', '12345678', '', 'free'])(
    'refuses a price of %j',
    (price) => {
      expect(reason(row({ price }))).toMatch(/^price:/);
    },
  );

  it('upper-cases the currency and refuses one that is not three letters', () => {
    expect(csvRowSchema.parse(row({ currency: 'usd' }))).toMatchObject({
      currency: 'USD',
    });
    expect(reason(row({ currency: 'EURO' }))).toMatch(/^currency:/);
  });

  it('treats an empty or missing optional cell as nothing given', () => {
    expect(
      csvRowSchema.parse(row({ description: '', imageUrl: undefined })),
    ).toMatchObject({ description: null, imageUrl: null });
  });

  it('refuses a blank or missing required cell', () => {
    expect(reason(row({ name: '  ' }))).toMatch(/^name:/);
    expect(reason(row({ sku: undefined }))).toMatch(/^sku:/);
  });

  // The URL is fetched in phase C; only web addresses may reach that point.
  it.each(['ftp://example.com/a.jpg', 'file:///etc/passwd', 'not a url'])(
    'refuses an image address of %s',
    (imageUrl) => {
      expect(reason(row({ imageUrl }))).toMatch(/^imageUrl:/);
    },
  );

  it('keeps an http or https image address', () => {
    expect(
      csvRowSchema.parse(row({ imageUrl: 'https://example.com/a.jpg' })),
    ).toMatchObject({ imageUrl: 'https://example.com/a.jpg' });
  });
});

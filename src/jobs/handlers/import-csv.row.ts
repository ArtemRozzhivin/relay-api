import { z } from 'zod';
import { TerminalJobError } from '../../common/errors/app-error.js';
import type { ProductRow } from '../../products/products.service.js';

// Header names are matched case-insensitively and mapped to the keys the row
// schema reads; any other column — a store export carries dozens — is skipped.
const COLUMNS = {
  sku: 'sku',
  name: 'name',
  description: 'description',
  price: 'price',
  currency: 'currency',
  imageurl: 'imageUrl',
} as const;

const REQUIRED = ['sku', 'name', 'price', 'currency'] as const;

/**
 * Reads a file's header row into the keys its records will carry, `undefined`
 * for a column the import does not use.
 *
 * @throws TerminalJobError when a required column is missing: then this is not
 * the file the caller thinks it is, and no retry can change that.
 */
export const readHeader = (header: string[]) => {
  const keys = header.map(
    (name) => COLUMNS[name.trim().toLowerCase() as keyof typeof COLUMNS],
  );
  const missing = REQUIRED.filter((column) => !keys.includes(column));

  if (missing.length > 0) {
    throw new TerminalJobError(
      `The file has no ${missing.join(', ')} column — the header must name sku, name, price and currency`,
    );
  }

  return keys;
};

// At most 7 whole digits: priceCents is a 32-bit integer, and 9 999 999.99 is
// the largest price whose cents still fit. Two decimals, so this reads EUR or
// USD correctly but not a currency with 0 or 3 minor digits, such as JPY.
const PRICE = /^\d{1,7}(\.\d{1,2})?$/;

// From the text, never through a float: parseFloat('19.99') * 100 is
// 1998.9999999999998.
const toCents = (price: string) => {
  const [whole, fraction = ''] = price.split('.');

  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

// An empty cell and a missing one mean the same: nothing was given.
const optional = (schema: z.ZodString) =>
  schema.optional().transform((value) => (value ? value : null));

/** One data row of an import file, as the product it becomes. */
export const csvRowSchema = z
  .object({
    sku: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(500),
    description: optional(z.string().trim().max(5000)),
    price: z
      .string()
      .trim()
      .regex(PRICE, 'expected a price such as 19.99')
      .transform(toCents),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, 'expected a three-letter currency code')
      .transform((code) => code.toUpperCase()),
    imageUrl: optional(z.string().trim()).pipe(
      z
        .url({ protocol: /^https?$/ })
        .max(2000)
        .nullable(),
    ),
  })
  .transform(({ price, ...product }): ProductRow => ({
    ...product,
    priceCents: price,
  }));

/** Why a row was refused, short enough to sit in a result or a report line. */
export const describeInvalidRow = (error: z.ZodError) => {
  const [issue] = error.issues;
  const column = issue?.path.join('.') || 'row';

  return `${column}: ${issue?.message ?? 'invalid'}`;
};

import { z } from 'zod';

/** How many items a list returns when the caller does not say. */
const DEFAULT_LIMIT = 20;

/** A list's `?limit=`: a query string carries it as text. */
export const limitParam = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(DEFAULT_LIMIT);

// Opaque on purpose: a client that cannot read the position cannot come to
// depend on its fields, so a list can change what it orders by. It is not
// signed, because there is nothing to protect: every list is filtered to the
// caller's own rows on the server, so an edited cursor only moves the caller
// through their own data.
const encodeCursor = (position: Record<string, string>) =>
  Buffer.from(JSON.stringify(position)).toString('base64url');

/**
 * A list's `?cursor=`, decoded into the position `shape` describes. A token
 * that is not one the list issued — edited, truncated, or another list's — is
 * a 400 like any other malformed parameter, not an empty page.
 */
export const cursorParam = <T>(shape: z.ZodType<T>) =>
  z
    .string()
    .max(512)
    .transform((token, context) => {
      try {
        const parsed = shape.safeParse(
          JSON.parse(Buffer.from(token, 'base64url').toString('utf8')),
        );

        if (parsed.success) {
          return parsed.data;
        }
      } catch {
        // Not base64url JSON at all; reported below with every other refusal.
      }

      context.addIssue({
        code: 'custom',
        message: 'expected a cursor this list returned as nextCursor',
      });

      return z.NEVER;
    });

/**
 * One page of a list read with `take: limit + 1`: the extra row, when there is
 * one, proves a next page exists without counting the rest.
 *
 * @param positionOf the last item's position, as the list's cursor encodes it.
 * @returns the page, and the cursor for the next one — `null` on the last.
 */
export const toPage = <T>(
  rows: T[],
  limit: number,
  positionOf: (last: T) => Record<string, string>,
) => {
  const items = rows.slice(0, limit);
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      rows.length > limit && last ? encodeCursor(positionOf(last)) : null,
  };
};

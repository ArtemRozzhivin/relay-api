import { z } from 'zod';

/**
 * A string Postgres can store. U+0000 is the one character `text` and `jsonb`
 * refuse, and a value carrying it fails the whole write it belongs to — a
 * submit answers 500, an import batch is retried until the job dead-letters —
 * so it is refused where the value comes in, as a reason on that one value.
 *
 * No stored value can hold it, so a payload schema the worker re-parses takes
 * this check without failing any job already in flight.
 */
export const storableText = () =>
  z.string().refine((value) => !value.includes('\u0000'), {
    error: 'must not contain a NUL character',
  });

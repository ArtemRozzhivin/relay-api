import { createHash } from 'node:crypto';
import type { SubmitJobInput } from './jobs.schema.js';

// Key order is not part of a JSON object's meaning, so it must not be part of
// its fingerprint: a client that rebuilds the same body from a map whose
// iteration order changed is retrying, not asking for a different job. Array
// order is meaning, so it stays.
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }

  return value;
};

/**
 * Fingerprints a submit body, so a retry under the same `Idempotency-Key` can
 * be told apart from a different request that reused the key (D28).
 *
 * @param input the body as the edge parsed it — defaults applied, so leaving a
 * field to its default and sending the default are the same request.
 * @returns the hex SHA-256 of the body's canonical JSON.
 */
export const requestHash = (input: SubmitJobInput) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex');

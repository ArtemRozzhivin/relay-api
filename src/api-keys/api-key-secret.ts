import { createHash, randomBytes } from 'node:crypto';

/**
 * What every key begins with, so a leaked one is recognisable — to its owner,
 * and to the secret scanners of the places keys leak to (§6.3f).
 */
export const API_KEY_PREFIX = 'relay_';

// 256 bits: there is nothing to guess, so a fast hash keeps it as safe as a
// slow one would, and a slow one would cost every request (§6.3f).
const SECRET_BYTES = 32;

// The prefix and six characters: enough to tell an account's few keys apart,
// and nothing towards the 43 that are secret.
const SHOWN_LENGTH = API_KEY_PREFIX.length + 6;

/** SHA-256 of a key, hex: what the table stores, and finds a presented key by. */
export const hashApiKey = (key: string) =>
  createHash('sha256').update(key).digest('hex');

/**
 * Makes a new key. `key` is the secret, for its owner once; `prefix` and
 * `hash` are what is stored.
 */
export const mintApiKey = () => {
  const key = API_KEY_PREFIX + randomBytes(SECRET_BYTES).toString('base64url');

  return { key, prefix: key.slice(0, SHOWN_LENGTH), hash: hashApiKey(key) };
};

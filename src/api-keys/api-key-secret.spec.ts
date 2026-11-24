import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashApiKey, mintApiKey } from './api-key-secret.js';

describe('mintApiKey', () => {
  it('makes relay_ and 43 base64url characters: 32 random bytes', () => {
    const { key } = mintApiKey();

    expect(key).toMatch(/^relay_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key.slice('relay_'.length), 'base64url')).toHaveLength(
      32,
    );
  });

  it('shows the prefix and six characters, none of the rest', () => {
    const { key, prefix } = mintApiKey();

    expect(prefix).toBe(key.slice(0, 12));
    expect(prefix).toMatch(/^relay_.{6}$/);
  });

  it('stores the SHA-256 of the whole key, never the key', () => {
    const { key, hash } = mintApiKey();

    expect(hash).toBe(createHash('sha256').update(key).digest('hex'));
    expect(hash).not.toContain(key.slice('relay_'.length));
  });

  it('makes a different key each time', () => {
    const keys = new Set(Array.from({ length: 100 }, () => mintApiKey().key));

    expect(keys.size).toBe(100);
  });
});

describe('hashApiKey', () => {
  it('finds a key by the hash it was stored under', () => {
    const { key, hash } = mintApiKey();

    expect(hashApiKey(key)).toBe(hash);
    expect(hashApiKey(`${key}x`)).not.toBe(hash);
  });
});

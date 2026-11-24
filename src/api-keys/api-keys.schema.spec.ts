import { describe, expect, it } from 'vitest';
import { createApiKeySchema } from './api-keys.schema.js';

describe('createApiKeySchema', () => {
  it('takes a name and the scopes, each once', () => {
    expect(
      createApiKeySchema.parse({
        name: '  Nightly sync  ',
        scopes: ['write', 'read', 'write'],
      }),
    ).toEqual({ name: 'Nightly sync', scopes: ['write', 'read'] });
  });

  it.each([
    ['no scope', { name: 'Sync', scopes: [] }],
    ['a scope that does not exist', { name: 'Sync', scopes: ['admin'] }],
    ['an empty name', { name: '   ', scopes: ['read'] }],
    ['a name of 101 characters', { name: 'x'.repeat(101), scopes: ['read'] }],
    ['a NUL in the name', { name: 'Sy\u0000nc', scopes: ['read'] }],
    ['a field of its own', { name: 'Sync', scopes: ['read'], hash: 'x' }],
  ])('refuses %s', (_what, body) => {
    expect(createApiKeySchema.safeParse(body).success).toBe(false);
  });
});

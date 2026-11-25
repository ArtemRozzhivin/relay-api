import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type ProcessHandle,
} from '../harness/relay-harness.js';

// A25 — revoking a key takes effect on the next request (§6.3f): the API looks
// every key up by its hash and caches no answer, so nothing has to restart, or
// expire, for a revoked key to stop working.
describe('A25 · a revoked API key is refused at once, without a restart', () => {
  let harness: RelayHarness;
  let account: Account;
  let api: ProcessHandle;

  const withKey = (key: string, path: string, init: RequestInit = {}) =>
    harness.request(path, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, ...init.headers },
    });

  beforeAll(async () => {
    harness = await RelayHarness.create();
    api = await harness.startApi();
    account = await harness.signUp('a25');
  });

  afterAll(() => harness.stop());

  it('lets the key in, then refuses it on the very next request', async () => {
    const made = await harness.request('/api-keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.token}` },
      body: JSON.stringify({ name: 'Script', scopes: ['read', 'write'] }),
    });

    expect(made.status).toBe(201);

    const { key, id } = made.body.data as { key: string; id: string };
    const pid = api.pid;

    expect((await withKey(key, '/jobs')).status).toBe(200);

    const revoked = await harness.request(`/api-keys/${id}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.token}` },
    });

    expect(revoked.status).toBe(200);

    expect((await withKey(key, '/jobs')).status).toBe(401);
    expect(
      (
        await withKey(key, '/jobs', {
          method: 'POST',
          headers: { 'Idempotency-Key': 'after-revoke' },
          body: JSON.stringify({ type: 'MOCK', payload: {} }),
        })
      ).status,
    ).toBe(401);

    // The same process, never restarted, answered both.
    expect(api.pid).toBe(pid);
    expect(api.exited).toBe(false);
    expect(
      await harness.prisma.job.count({ where: { userId: account.id } }),
    ).toBe(0);
  });
});

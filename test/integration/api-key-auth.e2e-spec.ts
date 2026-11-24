import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { registerAndLogin, startApp } from '../support/http.js';
import { deleteUsers, seedJob } from '../support/db.js';

// A request that carries an API key instead of a login (§6.3f): let in as the
// key's owner, on the routes and methods its scopes reach, and on no others.
describe('a request with an API key', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  const users: string[] = [];

  const register = async (label: string) => {
    const account = await registerAndLogin(server, `key-auth-${label}`);

    users.push(account.userId);

    return account;
  };

  // A seller and the key they made, with the scopes given.
  const keyed = async (scopes: string[] = ['read', 'write']) => {
    const seller = await register('seller');
    const { body } = await request(server)
      .post('/api-keys')
      .set('Authorization', `Bearer ${seller.token}`)
      .send({ name: 'Script', scopes })
      .expect(201);

    return { ...seller, key: body.data.key as string, keyId: body.data.id };
  };

  const withKey = (key: string) => ({
    get: (path: string) =>
      request(server).get(path).set('Authorization', `Bearer ${key}`),
    post: (path: string, body: object = {}) =>
      request(server)
        .post(path)
        .set('Authorization', `Bearer ${key}`)
        .set('Idempotency-Key', randomUUID())
        .send(body),
  });

  const mock = { type: 'MOCK', payload: {} };

  const lastUsedAtOf = async (id: string) =>
    (await prisma.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt;

  beforeAll(async () => {
    ({ app, server } = await startApp());
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await app.close();
  });

  it("acts as the key's owner", async () => {
    const { key, userId } = await keyed();

    const { body } = await withKey(key).post('/jobs', mock).expect(202);
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: body.data.id },
    });

    expect(job.userId).toBe(userId);
    await withKey(key).get(`/jobs/${job.id}`).expect(200);
  });

  it("finds none of another account's jobs", async () => {
    const { key } = await keyed();
    const stranger = await register('stranger');
    const theirs = await seedJob(prisma, { userId: stranger.userId });

    await withKey(key).get(`/jobs/${theirs.id}`).expect(404);
  });

  it.each([
    ['/jobs', 'GET'],
    ['/products', 'GET'],
    ['/pipelines/' + randomUUID(), 'GET'],
  ])('lets a read key read %s', async (path) => {
    const { key } = await keyed(['read']);
    const { status } = await withKey(key).get(path);

    // A pipeline that does not exist is the caller's 404: past the guards.
    expect([200, 404]).toContain(status);
  });

  it('refuses a read key a write', async () => {
    const { key, userId } = await keyed(['read']);

    const { body } = await withKey(key).post('/jobs', mock).expect(403);

    expect(body.error.code).toBe('API_KEY_SCOPE_MISSING');
    expect(await prisma.job.count({ where: { userId } })).toBe(0);
  });

  it('refuses a write key a read, and lets it write', async () => {
    const { key } = await keyed(['write']);

    const { body } = await withKey(key).get('/jobs').expect(403);

    expect(body.error.code).toBe('API_KEY_SCOPE_MISSING');
    await withKey(key).post('/jobs', mock).expect(202);
  });

  it.each([
    ['GET', '/api-keys'],
    ['POST', '/api-keys'],
    ['POST', `/api-keys/${randomUUID()}/revoke`],
    ['GET', '/admin/api-keys'],
    ['POST', '/admin/api-keys/revoke'],
    ['POST', '/auth/logout'],
  ])('refuses a key on %s %s, a route for a person', async (method, path) => {
    const { key, userId } = await keyed();
    const client = withKey(key);

    const { body } = await (
      method === 'GET'
        ? client.get(path)
        : client.post(path, { name: 'Successor', scopes: ['read'] })
    ).expect(403);

    expect(body.error.code).toBe('API_KEY_NOT_ALLOWED');
    // Not a successor key, nor a revoke of the one there is.
    expect(await prisma.apiKey.count({ where: { userId } })).toBe(1);
  });

  it('refuses a key from the request after it is revoked', async () => {
    const { key, keyId, token } = await keyed();

    await withKey(key).get('/jobs').expect(200);
    await request(server)
      .post(`/api-keys/${keyId}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await withKey(key).get('/jobs').expect(401);
  });

  it.each([
    [
      'a key no key hashes to',
      `relay_${randomBytes(32).toString('base64url')}`,
    ],
    ['the prefix alone', 'relay_'],
  ])('refuses %s', async (_what, key) => {
    await withKey(key).get('/jobs').expect(401);
  });

  it('records when a key was used, at most once a minute', async () => {
    const { key, keyId } = await keyed();

    await withKey(key).get('/jobs').expect(200);

    // Written after the request was let through, not as part of it.
    const first = await waitFor(() => lastUsedAtOf(keyId));

    await withKey(key).get('/jobs').expect(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await lastUsedAtOf(keyId)).toEqual(first);

    const twoMinutesAgo = new Date(Date.now() - 120_000);

    await prisma.apiKey.update({
      where: { id: keyId },
      data: { lastUsedAt: twoMinutesAgo },
    });
    await withKey(key).get('/jobs').expect(200);

    const later = await waitFor(async () => {
      const at = await lastUsedAtOf(keyId);

      return at && at > twoMinutesAgo ? at : null;
    });

    expect(later.getTime()).toBeGreaterThan(first.getTime());
  });
});

// Polls until `read` gives something, for a write the request does not wait for.
const waitFor = async <T>(read: () => Promise<T | null>) => {
  const deadline = Date.now() + 3_000;

  for (;;) {
    const value = await read();

    if (value !== null) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the write');
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

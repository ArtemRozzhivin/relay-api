import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { logIn, registerAndLogin, startApp } from '../support/http.js';
import { deleteUsers } from '../support/db.js';

// The keys a seller's own system uses instead of a login (§6.3f): made with
// the secret shown once, listed without it, and revoked for good.
describe('API keys over HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  const users: string[] = [];

  const register = async (label: string) => {
    const account = await registerAndLogin(server, `keys-${label}`);

    users.push(account.userId);

    return account;
  };

  const make = (
    token: string,
    body: unknown = { name: 'Nightly sync', scopes: ['read', 'write'] },
  ) =>
    request(server)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  const list = (token: string) =>
    request(server).get('/api-keys').set('Authorization', `Bearer ${token}`);

  const revoke = (token: string, id: string) =>
    request(server)
      .post(`/api-keys/${id}/revoke`)
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ({ app, server } = await startApp());
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await app.close();
  });

  it('makes a key, shows its secret once, and stores only its hash', async () => {
    const { token, userId } = await register('make');

    const { body } = await make(token).expect(201);
    const { key, ...shown } = body.data as { key: string };

    expect(key).toMatch(/^relay_[A-Za-z0-9_-]{43}$/);
    expect(shown).toEqual({
      id: expect.any(String),
      name: 'Nightly sync',
      prefix: key.slice(0, 12),
      scopes: ['read', 'write'],
      createdAt: expect.any(String),
      lastUsedAt: null,
      revokedAt: null,
    });

    const row = await prisma.apiKey.findUniqueOrThrow({
      where: { id: body.data.id },
    });

    expect(row).toMatchObject({
      userId,
      hash: createHash('sha256').update(key).digest('hex'),
    });
    // Nothing in the row holds the secret part, in any column.
    expect(JSON.stringify(row)).not.toContain(key.slice(12));
  });

  it("lists the caller's keys newest first, without their secret or hash", async () => {
    const { token } = await register('list');
    const other = await register('list-other');

    const { body: first } = await make(token, {
      name: 'First',
      scopes: ['read'],
    }).expect(201);

    await revoke(token, first.data.id).expect(200);
    await make(token, { name: 'Second', scopes: ['write'] }).expect(201);
    await make(other.token, { name: 'Theirs', scopes: ['read'] }).expect(201);

    const { body } = await list(token).expect(200);

    expect(body.data.map(({ name }: { name: string }) => name)).toEqual([
      'Second',
      'First',
    ]);

    for (const key of body.data) {
      expect(key).not.toHaveProperty('key');
      expect(key).not.toHaveProperty('hash');
      expect(key).not.toHaveProperty('userId');
    }
  });

  it('revokes a key, and answers a second revoke with the first one', async () => {
    const { token } = await register('revoke');
    const { body: made } = await make(token).expect(201);

    const { body: first } = await revoke(token, made.data.id).expect(200);

    expect(first.data.revokedAt).toEqual(expect.any(String));

    const { body: again } = await revoke(token, made.data.id).expect(200);

    expect(again.data.revokedAt).toBe(first.data.revokedAt);

    const { body: listed } = await list(token).expect(200);

    expect(listed.data[0].revokedAt).toBe(first.data.revokedAt);
  });

  it.each([
    ["another account's key", true],
    ['a key that does not exist', false],
  ])('answers 404 for %s', async (_what, exists) => {
    const owner = await register('owner');
    const other = await register('other');
    const { body } = await make(owner.token).expect(201);

    const { body: refused } = await revoke(
      other.token,
      exists ? body.data.id : randomUUID(),
    ).expect(404);

    expect(refused.error.code).toBe('API_KEY_NOT_FOUND');
    expect(
      (await prisma.apiKey.findUniqueOrThrow({ where: { id: body.data.id } }))
        .revokedAt,
    ).toBeNull();
  });

  it('holds one unrevoked key, and revoking it makes room for the next', async () => {
    const { token, userId } = await register('cap');
    const { body: made } = await make(token).expect(201);

    const { body } = await make(token).expect(429);

    expect(body.error.code).toBe('TOO_MANY_API_KEYS');
    expect(await prisma.apiKey.count({ where: { userId } })).toBe(1);

    await revoke(token, made.data.id).expect(200);
    await make(token).expect(201);
  });

  it('makes one key when the requests arrive at once', async () => {
    const { token, userId } = await register('race');

    const statuses = (
      await Promise.all(Array.from({ length: 5 }, () => make(token)))
    ).map(({ status }) => status);

    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 429)).toHaveLength(4);
    expect(await prisma.apiKey.count({ where: { userId } })).toBe(1);
  });

  it('refuses a key that may do nothing', async () => {
    const { token } = await register('scopeless');

    await make(token, { name: 'Sync', scopes: [] }).expect(400);
  });

  it.each([
    ['POST', '/api-keys'],
    ['GET', '/api-keys'],
    ['POST', `/api-keys/${randomUUID()}/revoke`],
  ])('answers %s %s without a session with 401', async (method, path) => {
    await (
      method === 'GET' ? request(server).get(path) : request(server).post(path)
    ).expect(401);
  });

  // The floor under the code that writes keys: a key with no scope is refused
  // whatever writes it, a list Prisma leaves nullable included.
  it.each([
    ['no scope', `'{}'::"ApiKeyScope"[]`],
    ['a NULL list', 'NULL'],
  ])('is refused by the database: %s', async (_what, scopes) => {
    const { userId } = await register('check');

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ApiKey" ("id", "userId", "name", "prefix", "hash", "scopes")
         VALUES (gen_random_uuid(), $1::uuid, 'k', 'relay_x', $2, ${scopes})`,
        userId,
        randomUUID(),
      ),
    ).rejects.toThrow(/ApiKey_has_a_scope/);
  });

  // POST /admin/api-keys/revoke: the operator's, across accounts.
  describe('revoked in bulk by an admin', () => {
    const revokeMatching = (token: string, body: unknown) =>
      request(server)
        .post('/admin/api-keys/revoke')
        .set('Authorization', `Bearer ${token}`)
        .send(body as object);

    // The role is read at login, so the account logs in again once promoted.
    const admin = async () => {
      const account = await register('admin');

      await prisma.user.update({
        where: { id: account.userId },
        data: { role: 'ADMIN' },
      });

      return logIn(server, account.email);
    };

    const revokedAtOf = async (id: string) =>
      (await prisma.apiKey.findUniqueOrThrow({ where: { id } })).revokedAt;

    it("revokes one seller's key by their email, and no one else's", async () => {
      const token = await admin();
      const seller = await register('seller');
      const other = await register('other-seller');
      const { body: theirs } = await make(seller.token).expect(201);
      const { body: kept } = await make(other.token).expect(201);

      const { body } = await revokeMatching(token, {
        email: seller.email,
      }).expect(200);

      expect(body.data).toEqual({ matched: 1, revoked: 1 });
      expect(await revokedAtOf(theirs.data.id)).toEqual(expect.any(Date));
      expect(await revokedAtOf(kept.data.id)).toBeNull();
    });

    it('leaves a key revoked earlier as it was', async () => {
      const token = await admin();
      const seller = await register('seller');
      const { body: made } = await make(seller.token).expect(201);
      const { body: first } = await revoke(seller.token, made.data.id).expect(
        200,
      );

      const { body } = await revokeMatching(token, {
        email: seller.email,
      }).expect(200);

      expect(body.data).toEqual({ matched: 0, revoked: 0 });
      expect((await revokedAtOf(made.data.id))?.toISOString()).toBe(
        first.data.revokedAt,
      );
    });

    // Counted, not revoked: a test that revoked every key in the database
    // would revoke keys that are not its own.
    it.each([
      ['one seller', true],
      ['every account', false],
    ])('counts and changes nothing on a dry run for %s', async (_who, one) => {
      const token = await admin();
      const seller = await register('seller');
      const other = await register('other-seller');
      const { body: theirs } = await make(seller.token).expect(201);
      const { body: others } = await make(other.token).expect(201);

      const { body } = await revokeMatching(token, {
        ...(one ? { email: seller.email } : {}),
        dryRun: true,
      }).expect(200);

      expect(body.data.revoked).toBe(0);

      if (one) {
        expect(body.data.matched).toBe(1);
      } else {
        expect(body.data.matched).toBeGreaterThanOrEqual(2);
      }

      expect(await revokedAtOf(theirs.data.id)).toBeNull();
      expect(await revokedAtOf(others.data.id)).toBeNull();
    });

    const listAll = (token: string, query = '') =>
      request(server)
        .get(`/admin/api-keys${query}`)
        .set('Authorization', `Bearer ${token}`);

    // One seller's keys, oldest first: made, revoked, made again, so the
    // account holds two revoked keys and one in use.
    const rotatedTwice = async () => {
      const seller = await register('rotating');
      const ids: string[] = [];

      for (let round = 0; round < 3; round += 1) {
        const { body } = await make(seller.token, {
          name: `Key ${round}`,
          scopes: ['read'],
        }).expect(201);

        ids.push(body.data.id);

        if (round < 2) {
          await revoke(seller.token, body.data.id).expect(200);
        }
      }

      return { seller, ids };
    };

    it("lists every account's keys, newest first, with whose each is", async () => {
      const token = await admin();
      const first = await register('listed');
      const second = await register('listed');
      const { body: older } = await make(first.token).expect(201);
      const { body: newer } = await make(second.token).expect(201);

      const { body } = await listAll(token, '?limit=100').expect(200);
      const ids = body.data.items.map(({ id }: { id: string }) => id);

      expect(ids.indexOf(newer.data.id)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(newer.data.id)).toBeLessThan(
        ids.indexOf(older.data.id),
      );

      const listed = body.data.items.find(
        ({ id }: { id: string }) => id === older.data.id,
      );

      expect(listed).toEqual({
        ...older.data,
        key: undefined,
        owner: { id: first.userId, email: first.email },
      });
      expect(listed).not.toHaveProperty('hash');
    });

    it("filters one seller's keys by status", async () => {
      const token = await admin();
      const { seller, ids } = await rotatedTwice();
      const query = `?email=${encodeURIComponent(seller.email)}`;

      const active = await listAll(token, `${query}&status=active`).expect(200);
      const revoked = await listAll(token, `${query}&status=revoked`).expect(
        200,
      );

      expect(
        active.body.data.items.map(({ id }: { id: string }) => id),
      ).toEqual([ids[2]]);
      expect(
        revoked.body.data.items.map(({ id }: { id: string }) => id),
      ).toEqual([ids[1], ids[0]]);
    });

    it('pages through them with the cursor it returns', async () => {
      const token = await admin();
      const { seller, ids } = await rotatedTwice();
      const query = `?email=${encodeURIComponent(seller.email)}&limit=2`;

      const first = await listAll(token, query).expect(200);

      expect(first.body.data.nextCursor).toEqual(expect.any(String));

      const second = await listAll(
        token,
        `${query}&cursor=${first.body.data.nextCursor}`,
      ).expect(200);

      expect(second.body.data.nextCursor).toBeNull();
      expect(
        [...first.body.data.items, ...second.body.data.items].map(
          ({ id }: { id: string }) => id,
        ),
      ).toEqual([ids[2], ids[1], ids[0]]);
    });

    it.each([
      ['a status that does not exist', '?status=expired'],
      ['a cursor it did not return', '?cursor=not-one'],
    ])('refuses a list with %s', async (_what, query) => {
      await listAll(await admin(), query).expect(400);
    });

    it('refuses a seller the list with 403', async () => {
      const seller = await register('not-admin');

      await listAll(seller.token).expect(403);
    });

    it('refuses a seller with 403, revoking nothing', async () => {
      const seller = await register('not-admin');
      const { body: made } = await make(seller.token).expect(201);

      const { body } = await revokeMatching(seller.token, {
        email: seller.email,
      }).expect(403);

      expect(body.error).toBeDefined();
      expect(await revokedAtOf(made.data.id)).toBeNull();
    });

    it.each([
      ['an address that is not an email', { email: 'nobody' }],
      ['a field of its own', { userId: randomUUID() }],
    ])('refuses %s', async (_what, filter) => {
      await revokeMatching(await admin(), filter).expect(400);
    });

    it('refuses without a session', async () => {
      await request(server).post('/admin/api-keys/revoke').send({}).expect(401);
    });
  });
});

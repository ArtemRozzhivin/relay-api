import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { mintApiKey } from '../../src/api-keys/api-key-secret.js';
import { registerAndLogin, startApp } from '../support/http.js';
import { deleteUsers } from '../support/db.js';

// Before the imports above run: AppModule validates its configuration as it
// loads.
vi.hoisted(() => {
  vi.stubEnv('API_KEYS_ENABLED', 'false');
});

// The operator's switch (§6.3f): with keys turned off, none is made, while an
// owner can still see and revoke the ones there are.
describe('API keys turned off', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  const users: string[] = [];

  beforeAll(async () => {
    ({ app, server } = await startApp());
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await app.close();
  });

  it('makes no key', async () => {
    const { token, userId } = await registerAndLogin(server, 'keys-off');

    users.push(userId);

    const { body } = await request(server)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nightly sync', scopes: ['read'] })
      .expect(403);

    expect(body.error.code).toBe('API_KEYS_DISABLED');
    expect(await prisma.apiKey.count({ where: { userId } })).toBe(0);
  });

  it('still lets an owner see and revoke a key made before', async () => {
    const { token, userId } = await registerAndLogin(server, 'keys-off');

    users.push(userId);

    const { prefix, hash } = mintApiKey();
    const made = await prisma.apiKey.create({
      data: { userId, name: 'Before', prefix, hash, scopes: ['read'] },
    });

    const { body } = await request(server)
      .get('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(body.data.map(({ id }: { id: string }) => id)).toEqual([made.id]);

    await request(server)
      .post(`/api-keys/${made.id}/revoke`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});

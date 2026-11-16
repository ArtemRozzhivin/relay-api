import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Registry } from '@prometheus-io/client';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { registerAndLogin, startApp } from '../support/http.js';
import { deleteUsers } from '../support/db.js';
import { samples, sum } from '../support/metrics.js';

const ALLOWED = 'https://dashboard.example';

// Before the imports above run: AppModule validates its configuration as it
// loads. The test sends from loopback, so with that trusted as the proxy every
// request names its own address — and no test spends another's limit.
vi.hoisted(() => {
  vi.stubEnv('RATE_LIMITS', 'true');
  vi.stubEnv('TRUST_PROXY', 'loopback');
  vi.stubEnv('CORS_ORIGINS', 'https://dashboard.example');
});

let last = 0;
// A fresh address from a block reserved for documentation (RFC 5737).
const newAddress = () => `198.51.100.${++last}`;

describe('rate limits', () => {
  let app: INestApplication;
  let server: Server;
  let alice: string;
  let bob: string;
  const users: string[] = [];

  const register = async (label: string) => {
    const { token, userId } = await registerAndLogin(server, `rl-${label}`);

    users.push(userId);

    return token;
  };

  beforeAll(async () => {
    ({ app, server } = await startApp());
    alice = await register('alice');
    bob = await register('bob');
  });

  afterAll(async () => {
    await deleteUsers(app.get(PrismaService), users);
    await app.close();
    vi.unstubAllEnvs();
  });

  const expectRefused = (res: request.Response, window: number) => {
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);

    const retryAfter = Number(res.headers['retry-after']);

    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(window);
    // Readable from a dashboard, which has to know when to try again.
    expect(res.headers['access-control-expose-headers']).toContain(
      'Retry-After',
    );
  };

  // An empty body is refused by validation — after the limiter has counted
  // it, and before any password is hashed or account made.
  it.each([
    { route: '/auth/login', limit: 10, window: 60 },
    { route: '/auth/register', limit: 5, window: 3600 },
    { route: '/auth/refresh', limit: 60, window: 60 },
  ])(
    'allows $limit requests to $route per address',
    async ({ route, limit, window }) => {
      const from = newAddress();
      const send = (address = from) =>
        request(server)
          .post(route)
          .set('X-Forwarded-For', address)
          .set('Origin', ALLOWED)
          .send({});

      for (let i = 0; i < limit; i++) {
        expect((await send()).status).toBe(400);
      }

      expectRefused(await send(), window);
      expect((await send(newAddress())).status).toBe(400);
    },
  );

  it.each([
    // Refused for its missing Idempotency-Key, so no job is made.
    { route: 'POST /jobs', path: () => '/jobs', limit: 60, allowed: 400 },
    { route: 'POST /uploads', path: () => '/uploads', limit: 10, allowed: 200 },
    // A different job each time, all counted against the one route; none is
    // the caller's to re-drive.
    {
      route: 'POST /jobs/:id/retry',
      path: () => `/jobs/${randomUUID()}/retry`,
      limit: 60,
      allowed: 404,
    },
    // Refused for its empty filter, so nothing is re-driven.
    {
      route: 'POST /jobs/retry',
      path: () => '/jobs/retry',
      limit: 10,
      allowed: 400,
    },
  ])(
    'allows $limit requests to $route per account, from any address',
    async ({ path, limit, allowed }) => {
      const send = (token: string, from: string) =>
        request(server)
          .post(path())
          .set('Authorization', `Bearer ${token}`)
          .set('X-Forwarded-For', from)
          .set('Origin', ALLOWED)
          .send({});

      for (let i = 0; i < limit; i++) {
        expect((await send(alice, newAddress())).status).toBe(allowed);
      }

      const from = newAddress();

      expectRefused(await send(alice, from), 60);
      expect((await send(bob, from)).status).toBe(allowed);
    },
  );

  it('allows 300 requests a minute to a route with no limit of its own', async () => {
    const from = newAddress();
    const get = (path: string) =>
      request(server)
        .get(path)
        .set('X-Forwarded-For', from)
        .set('Origin', ALLOWED);

    for (let i = 0; i < 300; i++) {
      expect((await get('/health')).status).toBe(200);
    }

    expectRefused(await get('/health'), 60);
    // Counted per route: the same address still reaches another.
    expect((await get('/ready')).status).toBe(200);
  });

  it('counts the refusals by route in the metrics', async () => {
    const registry = app.get(Registry);
    const refused = async () =>
      sum(
        samples(
          await registry.metrics(),
          'relay_http_request_duration_seconds_count',
          { method: 'POST', route: '/auth/login', status: '429' },
        ),
      );
    const before = await refused();
    const from = newAddress();

    for (let i = 0; i <= 10; i++) {
      await request(server)
        .post('/auth/login')
        .set('X-Forwarded-For', from)
        .send({});
    }

    expect(await refused()).toBe(before + 1);
  });
});

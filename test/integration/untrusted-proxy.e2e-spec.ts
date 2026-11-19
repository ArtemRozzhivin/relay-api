import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { startApp } from '../support/http.js';

// Before the imports above run: AppModule validates its configuration as it
// loads. TRUST_PROXY is left unset, as it is with no proxy in front.
vi.hoisted(() => {
  vi.stubEnv('RATE_LIMITS', 'true');
});

describe('with no proxy to trust', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    ({ app, server } = await startApp());
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  // Otherwise a client would choose its own address, and with it a fresh
  // limit on every request.
  it('limits by the connection, whatever X-Forwarded-For says', async () => {
    const login = (i: number) =>
      request(server)
        .post('/auth/login')
        .set('X-Forwarded-For', `198.51.100.${i}`)
        .send({});

    for (let i = 1; i <= 10; i++) {
      expect((await login(i)).status).toBe(400);
    }

    expect((await login(11)).status).toBe(429);
  });
});

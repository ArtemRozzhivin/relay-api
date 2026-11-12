import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { startApp } from '../support/http.js';

const ALLOWED = 'https://dashboard.example';
const OTHER = 'https://elsewhere.example';

// Before the imports above run: AppModule validates its configuration as it
// loads.
vi.hoisted(() => {
  vi.stubEnv('CORS_ORIGINS', 'https://dashboard.example');
});

describe('the HTTP edge', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    ({ app, server } = await startApp());
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('sends security headers and does not name its framework', async () => {
    const res = await request(server).get('/health').expect(200);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  describe('CORS', () => {
    const preflight = (origin: string) =>
      request(server)
        .options('/jobs')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set(
          'Access-Control-Request-Headers',
          'authorization,content-type,idempotency-key',
        );

    it('lets a configured origin call the API', async () => {
      const res = await preflight(ALLOWED).expect(204);

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    });

    it('gives any other origin nothing a browser would accept', async () => {
      const res = await preflight(OTHER);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('lets a browser read the request id it would report', async () => {
      const res = await request(server)
        .get('/health')
        .set('Origin', ALLOWED)
        .expect(200);

      expect(res.headers['access-control-expose-headers']).toContain(
        'X-Request-Id',
      );
    });

    // socket.io's handshake, before any namespace: the engine answers it on
    // the same server, so it is where its own CORS applies.
    const handshake = (origin: string) =>
      request(server)
        .get('/socket.io/')
        .query({ EIO: 4, transport: 'polling' })
        .set('Origin', origin)
        .expect(200);

    it('applies the same origins to the socket', async () => {
      const allowed = await handshake(ALLOWED);
      const other = await handshake(OTHER);

      expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('bodies', () => {
    const login = (body: string) =>
      request(server)
        .post('/auth/login')
        .set('Origin', ALLOWED)
        .set('Content-Type', 'application/json')
        .send(body);

    // Rejected by the parser, before the logger middleware or any route: the
    // request still has an id, and the browser can still read the answer.
    it('refuses a body over the limit with a 413 a browser can read', async () => {
      const res = await login(
        JSON.stringify({
          email: 'a@example.com',
          password: 'x'.repeat(70_000),
        }),
      ).expect(413);

      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    });

    it('names the request that sent malformed JSON', async () => {
      const res = await login('{"email":').expect(400);

      expect(res.body.requestId).toBe(res.headers['x-request-id']);
      expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("keeps the caller's own request id", async () => {
      const res = await login('{"email":').set('X-Request-Id', 'trace-42');

      expect(res.body.requestId).toBe('trace-42');
      expect(res.headers['x-request-id']).toBe('trace-42');
    });

    it('does not parse a form', async () => {
      const res = await request(server)
        .post('/auth/login')
        .type('form')
        .send({ email: 'a@example.com', password: 'password123' });

      expect(res.status).toBe(400);
    });
  });
});

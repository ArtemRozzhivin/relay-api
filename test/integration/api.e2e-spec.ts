import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';

// The in-process tier: the real app, the real database, no worker. It covers the
// request contract — validation, authentication, tenant scoping — which the
// process-level assertions in test/assertions deliberately do not re-test.
describe('the job API contract', () => {
  let app: INestApplication;
  let server: Server;

  const register = async (label: string) => {
    const email = `int-${label}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;

    await request(server)
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);

    const { body } = await request(server)
      .post('/auth/login')
      .send({ email, password: 'password123' });

    return body.data.accessToken as string;
  };

  const submit = (token: string, key = `int-${Math.random()}`) =>
    request(server)
      .post('/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ type: 'MOCK', payload: { durationMs: 10, failureRate: 0 } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    // listen(), not init(): against a server that is not already listening,
    // supertest binds and closes a port per request, and two concurrent
    // requests then race on the same server object and surface as ECONNRESET.
    await app.listen(0);
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves liveness without a token', async () => {
    await request(server).get('/health').expect(200);
  });

  it('refuses an unauthenticated submit', async () => {
    await request(server)
      .post('/jobs')
      .set('Idempotency-Key', 'no-auth')
      .send({ type: 'MOCK', payload: { durationMs: 10, failureRate: 0 } })
      .expect(401);
  });

  it('requires an idempotency key', async () => {
    const token = await register('nokey');

    const { status, body } = await request(server)
      .post('/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'MOCK', payload: { durationMs: 10, failureRate: 0 } });

    expect(status).toBe(400);
    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('rejects a payload that does not match its type', async () => {
    const token = await register('badpayload');

    const { status, body } = await request(server)
      .post('/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'bad-payload')
      .send({ type: 'CHARGE', payload: { durationMs: 10 } });

    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const token = await register('strict');

    const { status } = await request(server)
      .post('/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'strict')
      .send({
        type: 'MOCK',
        payload: { durationMs: 10, failureRate: 0, sneaky: true },
      });

    expect(status).toBe(400);
  });

  it("hides another tenant's job behind a 404", async () => {
    const [owner, stranger] = await Promise.all([
      register('owner'),
      register('stranger'),
    ]);

    const { body: created } = await submit(owner);
    const jobId = created.data.id;

    await request(server)
      .get(`/jobs/${jobId}`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);

    // 404 and not 403: a 403 would confirm the id exists, which is itself a
    // cross-tenant leak.
    const { status, body } = await request(server)
      .get(`/jobs/${jobId}`)
      .set('Authorization', `Bearer ${stranger}`);

    expect(status).toBe(404);
    expect(body.error.code).toBe('JOB_NOT_FOUND');
  });

  it('refuses a re-drive of a job the caller does not own', async () => {
    const [owner, stranger] = await Promise.all([
      register('rd-owner'),
      register('rd-stranger'),
    ]);

    const { body: created } = await submit(owner);

    await request(server)
      .post(`/jobs/${created.data.id}/retry`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(404);
  });

  it('rejects a malformed job id', async () => {
    const token = await register('badid');

    await request(server)
      .get('/jobs/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('lists only the caller’s own jobs', async () => {
    const [mine, theirs] = await Promise.all([
      register('list-mine'),
      register('list-theirs'),
    ]);

    const [first, second] = [await submit(mine), await submit(mine)];
    const other = await submit(theirs);

    const { body } = await request(server)
      .get('/jobs')
      .set('Authorization', `Bearer ${mine}`)
      .expect(200);

    expect(body.data.total).toBe(2);
    expect(body.data.items.map((job: { id: string }) => job.id).sort()).toEqual(
      [first.body.data.id, second.body.data.id].sort(),
    );
    expect(body.data.items).not.toContainEqual(
      expect.objectContaining({ id: other.body.data.id }),
    );
  });
});

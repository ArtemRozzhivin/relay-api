import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { pipelineKey } from '../../src/jobs/engine/pipeline-keys.js';
import { postUploadForm } from '../support/upload-form.js';
import { registerAndLogin, startApp } from '../support/http.js';
import { deleteUsers, seedJob } from '../support/db.js';

// POST /pipelines and GET /pipelines/:id (§6.3e): a pipeline and its import
// are written together, once per key, and a client follows the run by the
// count of its jobs in each status.
describe('pipelines over HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  const users: string[] = [];

  const register = async (label: string) => {
    const account = await registerAndLogin(server, `pipelines-${label}`);

    users.push(account.userId);

    return account;
  };

  // The file is checked when the pipeline starts, so it needs a real one.
  const uploaded = async (token: string) => {
    const { body } = await request(server)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`);

    expect(
      (await postUploadForm(body.data, 'sku,name,price,currency\n')).status,
    ).toBe(204);

    return body.data.key as string;
  };

  const start = (token: string, body: unknown, idempotencyKey = randomUUID()) =>
    request(server)
      .post('/pipelines')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body as object);

  const fetch = (token: string, id: string) =>
    request(server)
      .get(`/pipelines/${id}`)
      .set('Authorization', `Bearer ${token}`);

  const pipelinesOf = (userId: string) =>
    prisma.pipeline.count({ where: { userId } });

  beforeAll(async () => {
    ({ app, server } = await startApp());
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await app.close();
  });

  it('starts a pipeline and its import together, and answers with what it committed', async () => {
    const { token, userId } = await register('start');
    const key = await uploaded(token);
    const idempotencyKey = randomUUID();

    const { body } = await start(token, { key }, idempotencyKey).expect(202);
    const pipeline = body.data;

    expect(pipeline).toEqual({
      id: expect.any(String),
      userId,
      idempotencyKey,
      correlationId: expect.any(String),
      status: 'RUNNING',
      summary: null,
      createdAt: expect.any(String),
      finishedAt: null,
      importJobId: expect.any(String),
      jobs: { 'import.csv': { QUEUED: 1 } },
      replayed: false,
    });

    const importJob = await prisma.job.findUniqueOrThrow({
      where: { id: pipeline.importJobId },
      include: { outbox: true },
    });

    expect(importJob).toMatchObject({
      userId,
      type: 'import.csv',
      payload: { key },
      idempotencyKey: pipelineKey(pipeline.id, 'import'),
      correlationId: pipeline.correlationId,
      pipelineId: pipeline.id,
      pendingInPipeline: true,
    });
    expect(importJob.outbox).toHaveLength(1);

    const { body: viewed } = await request(server)
      .get(`/jobs/${importJob.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(viewed.data.pipelineId).toBe(pipeline.id);
    expect(viewed.data).not.toHaveProperty('pendingInPipeline');
  });

  it('answers a replay with the same pipeline, and starts nothing more', async () => {
    const { token, userId } = await register('replay');
    const key = await uploaded(token);
    const idempotencyKey = randomUUID();

    const first = await start(token, { key }, idempotencyKey).expect(202);
    const replay = await start(token, { key }, idempotencyKey).expect(202);

    expect(replay.body.data).toMatchObject({
      id: first.body.data.id,
      importJobId: first.body.data.importJobId,
      replayed: true,
    });
    expect(await pipelinesOf(userId)).toBe(1);
    expect(await prisma.job.count({ where: { userId } })).toBe(1);
  });

  it('refuses a key first used with a different body', async () => {
    const { token } = await register('reused');
    const idempotencyKey = randomUUID();

    await start(token, { key: await uploaded(token) }, idempotencyKey).expect(
      202,
    );

    const { body } = await start(
      token,
      { key: await uploaded(token) },
      idempotencyKey,
    ).expect(422);

    expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it("refuses another account's upload, writing nothing", async () => {
    const owner = await register('owner');
    const other = await register('other');
    const key = await uploaded(owner.token);

    const { body } = await start(other.token, { key }).expect(422);

    expect(body.error.code).toBe('UPLOAD_NOT_FOUND');
    expect(await pipelinesOf(other.userId)).toBe(0);
  });

  it('counts its import against the import cap, writing nothing past it', async () => {
    const { token, userId } = await register('capped');
    const key = await uploaded(token);

    for (let index = 0; index < 3; index += 1) {
      await seedJob(prisma, { userId, type: 'import.csv' });
    }

    const { body } = await start(token, { key }).expect(429);

    expect(body.error.code).toBe('TOO_MANY_UNFINISHED_JOBS');
    expect(await pipelinesOf(userId)).toBe(0);
  });

  it('refuses a body with more than the key', async () => {
    const { token } = await register('strict');
    const key = await uploaded(token);

    await start(token, { key, maxAttempts: 3 }).expect(400);
  });

  it.each(['/pipelines', '/jobs'])(
    'refuses on %s an Idempotency-Key in the form of a pipeline job’s own',
    async (path) => {
      const { token } = await register('reserved');

      const { body } = await request(server)
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'pipeline:x:enrich:0')
        .send({ type: 'MOCK', payload: {} })
        .expect(400);

      expect(body.error.code).toBe('IDEMPOTENCY_KEY_RESERVED');
    },
  );

  it("counts the pipeline's jobs by type and status", async () => {
    const { token, userId } = await register('counts');
    const { body } = await start(token, { key: await uploaded(token) }).expect(
      202,
    );
    const pipelineId = body.data.id as string;

    await seedJob(prisma, { userId, type: 'ai.enrich', pipelineId });
    await seedJob(prisma, { userId, type: 'ai.enrich', pipelineId });
    await seedJob(prisma, {
      userId,
      type: 'ai.enrich',
      pipelineId,
      status: 'DEAD_LETTERED',
    });
    await seedJob(prisma, { userId, type: 'image.process', pipelineId });
    // Not the pipeline's, so not counted.
    await seedJob(prisma, { userId, type: 'ai.enrich' });

    const { body: fetched } = await fetch(token, pipelineId).expect(200);

    expect(fetched.data.jobs).toEqual({
      'import.csv': { QUEUED: 1 },
      'ai.enrich': { QUEUED: 2, DEAD_LETTERED: 1 },
      'image.process': { QUEUED: 1 },
    });
    expect(fetched.data).not.toHaveProperty('pendingChildren');
    expect(fetched.data).not.toHaveProperty('requestHash');
  });

  it("answers 404 for another account's pipeline", async () => {
    const owner = await register('mine');
    const other = await register('theirs');
    const { body } = await start(owner.token, {
      key: await uploaded(owner.token),
    }).expect(202);

    const { body: refused } = await fetch(other.token, body.data.id).expect(
      404,
    );

    expect(refused.error.code).toBe('PIPELINE_NOT_FOUND');
  });
});

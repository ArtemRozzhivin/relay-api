import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { Readable } from 'node:stream';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { errorReportKey } from '../../src/storage/object-keys.js';
import { registerAndLogin, startApp } from '../support/http.js';
import { deleteUsers } from '../support/db.js';

// The in-process tier: the real app, the real database, no worker. It covers the
// request contract — validation, authentication, tenant scoping — which the
// process-level assertions in test/assertions deliberately do not re-test.
describe('the job API contract', () => {
  let app: INestApplication;
  let server: Server;
  const users: string[] = [];

  // Most cases need only the token.
  const register = async (label: string) => {
    const { token, userId } = await registerAndLogin(server, `int-${label}`);

    users.push(userId);

    return token;
  };

  const submit = (token: string, key = `int-${Math.random()}`) =>
    request(server)
      .post('/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ type: 'MOCK', payload: { durationMs: 10, failureRate: 0 } });

  beforeAll(async () => {
    ({ app, server } = await startApp());
  });

  afterAll(async () => {
    await deleteUsers(app.get(PrismaService), users);
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

  describe('a reused Idempotency-Key', () => {
    const original = {
      type: 'MOCK',
      payload: { durationMs: 10, failureRate: 0 },
    };
    const different = {
      ...original,
      payload: { durationMs: 20, failureRate: 0 },
    };

    const submitAs = (token: string, key: string, body: object) =>
      request(server)
        .post('/jobs')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(body);

    const listAs = async (token: string) =>
      (
        await request(server)
          .get('/jobs')
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body.data;

    it('replays a retry of the same body, whatever its key order or defaults', async () => {
      const token = await register('reuse-same');
      const key = `reuse-same-${Math.random()}`;

      const first = await submitAs(token, key, original);
      const retry = await submitAs(token, key, {
        maxAttempts: 5,
        payload: { failureRate: 0, durationMs: 10 },
        type: 'MOCK',
      });

      expect(first.status).toBe(202);
      expect(retry.status).toBe(202);
      expect(retry.body.data).toMatchObject({
        id: first.body.data.id,
        replayed: true,
      });
      expect(retry.body.data).not.toHaveProperty('requestHash');
    });

    it('refuses the key with a different body and leaves the first job untouched', async () => {
      const token = await register('reuse-diff');
      const key = `reuse-diff-${Math.random()}`;

      const first = await submitAs(token, key, original);
      const reused = await submitAs(token, key, different);

      expect(reused.status).toBe(422);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

      const { items } = await listAs(token);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: first.body.data.id,
        payload: original.payload,
      });
      expect(items[0]).not.toHaveProperty('requestHash');
    });

    // The race A1 is about, with two bodies instead of one: the unique index
    // picks the winner, and every copy of the other body must be refused
    // whichever won.
    it('lets one of two racing bodies win and refuses every copy of the other', async () => {
      const token = await register('reuse-race');
      const key = `reuse-race-${Math.random()}`;
      const bodies = [
        original,
        different,
        original,
        different,
        original,
        different,
      ];

      const responses = await Promise.all(
        bodies.map((body) => submitAs(token, key, body)),
      );

      const { items } = await listAs(token);
      expect(items).toHaveLength(1);

      const winner = items[0].payload.durationMs;

      bodies.forEach((body, index) => {
        expect(responses[index].status).toBe(
          body.payload.durationMs === winner ? 202 : 422,
        );
      });
    });
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

  describe('a re-drive of a job with a checkpoint', () => {
    // Dead-lettered with a checkpoint, as an import that died halfway is.
    const halfDone = async () => {
      const token = await register('rd-checkpoint');
      const { body: created } = await submit(token);
      const jobId = created.data.id as string;

      await app.get(PrismaService).job.update({
        where: { id: jobId },
        data: { status: 'DEAD_LETTERED', checkpoint: { records: 1000 } },
      });

      return { token, jobId };
    };

    const retry = (token: string, jobId: string, query = '') =>
      request(server)
        .post(`/jobs/${jobId}/retry${query}`)
        .set('Authorization', `Bearer ${token}`);

    const checkpointOf = async (jobId: string) =>
      (
        await app
          .get(PrismaService)
          .job.findUniqueOrThrow({ where: { id: jobId } })
      ).checkpoint;

    it('resumes by default, and never shows the checkpoint', async () => {
      const { token, jobId } = await halfDone();

      const { status, body } = await retry(token, jobId);

      expect(status).toBe(202);
      expect(body.data.status).toBe('QUEUED');
      expect(body.data).not.toHaveProperty('checkpoint');
      expect(await checkpointOf(jobId)).toEqual({ records: 1000 });
    });

    it('starts over with ?from=start', async () => {
      const { token, jobId } = await halfDone();

      await retry(token, jobId, '?from=start').expect(202);

      expect(await checkpointOf(jobId)).toBeNull();
    });

    it('rejects any other ?from', async () => {
      const { token, jobId } = await halfDone();

      await retry(token, jobId, '?from=middle').expect(400);

      expect(await checkpointOf(jobId)).toEqual({ records: 1000 });
    });
  });

  describe("an import's error report", () => {
    // A finished import of the caller's, and the report the worker would have
    // left for it — no worker runs in this tier.
    const importWithReport = async (
      status: 'SUCCEEDED' | 'RUNNING' = 'SUCCEEDED',
      { withReport = true } = {},
    ) => {
      const token = await register('report');
      const { body: created } = await submit(token);
      const jobId = created.data.id as string;
      const job = await app.get(PrismaService).job.update({
        where: { id: jobId },
        data: { type: 'import.csv', status },
      });

      if (withReport) {
        await app
          .get(StorageService)
          .upload(
            errorReportKey(job.userId, jobId),
            Readable.from(['line,reason\n3,name: Too small\n']),
            {
              contentType: 'text/csv; charset=utf-8',
              downloadAs: 'import-errors.csv',
            },
          );
      }

      return { token, jobId };
    };

    const reportLink = (token: string, jobId: string) =>
      request(server)
        .get(`/jobs/${jobId}/error-report`)
        .set('Authorization', `Bearer ${token}`);

    it('answers with a short-lived link that downloads the report', async () => {
      const { token, jobId } = await importWithReport();

      const { status, body } = await reportLink(token, jobId);

      expect(status).toBe(200);
      expect(new Date(body.data.expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );

      const download = await fetch(body.data.url);

      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toBe(
        'attachment; filename="import-errors.csv"',
      );
      expect(await download.text()).toBe('line,reason\n3,name: Too small\n');
    });

    it("hides another tenant's report behind the job's 404", async () => {
      const { jobId } = await importWithReport();
      const stranger = await register('report-stranger');

      const { status, body } = await reportLink(stranger, jobId);

      expect(status).toBe(404);
      expect(body.error.code).toBe('JOB_NOT_FOUND');
    });

    it.each([
      ['every row was valid', 'SUCCEEDED', false],
      ['the job is running again', 'RUNNING', true],
    ] as const)('is not found when %s', async (_label, status, withReport) => {
      const { token, jobId } = await importWithReport(status, {
        withReport,
      });

      const { status: code, body } = await reportLink(token, jobId);

      expect(code).toBe(404);
      expect(body.error.code).toBe('ERROR_REPORT_NOT_FOUND');
    });
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

    expect(body.data.items).toHaveLength(2);
    expect(body.data.nextCursor).toBeNull();
    expect(body.data.items.map((job: { id: string }) => job.id).sort()).toEqual(
      [first.body.data.id, second.body.data.id].sort(),
    );
    expect(body.data.items).not.toContainEqual(
      expect.objectContaining({ id: other.body.data.id }),
    );
  });
  // No worker runs in this tier, so a submitted job stays QUEUED — which is the
  // case the API is allowed to finish by itself.
  it('cancels a job nobody has started', async () => {
    const token = await register('cancel-queued');
    const { body: created } = await submit(token);

    const { status, body } = await request(server)
      .post(`/jobs/${created.data.id}/cancel`)
      .set('Authorization', `Bearer ${token}`);

    expect(status).toBe(202);
    expect(body.data).toMatchObject({
      status: 'CANCELLED',
      cancelRequested: true,
      attempts: 0,
    });
  });

  // The one finish that answers 202: the caller's request was honoured, so a
  // client retrying a cancel whose response it lost must not see an error.
  it('answers a repeated cancel with the job, not an error', async () => {
    const token = await register('cancel-twice');
    const { body: created } = await submit(token);
    const cancel = () =>
      request(server)
        .post(`/jobs/${created.data.id}/cancel`)
        .set('Authorization', `Bearer ${token}`);

    await cancel().expect(202);

    const { status, body } = await cancel();

    expect(status).toBe(202);
    expect(body.data.status).toBe('CANCELLED');
  });

  // A finish that happened in spite of the request is not an "accepted": the
  // cancel changed nothing, and the code should say so without the caller
  // having to read the body.
  it.each(['SUCCEEDED', 'DEAD_LETTERED'] as const)(
    'refuses to cancel a job that already %s',
    async (status) => {
      const token = await register(`cancel-${status.toLowerCase()}`);
      const { body: created } = await submit(token);

      // No worker runs in this tier, so the finish is written directly — what
      // is under test is the endpoint's answer, not how the job got there.
      await app.get(PrismaService).job.update({
        where: { id: created.data.id },
        data: { status, finishedAt: new Date() },
      });

      const { status: code, body } = await request(server)
        .post(`/jobs/${created.data.id}/cancel`)
        .set('Authorization', `Bearer ${token}`);

      expect(code).toBe(409);
      expect(body.error.code).toBe('JOB_ALREADY_FINISHED');

      const { body: after } = await request(server)
        .get(`/jobs/${created.data.id}`)
        .set('Authorization', `Bearer ${token}`);

      // A refusal, and a no-op: not even the flag was set.
      expect(after.data).toMatchObject({ status, cancelRequested: false });
    },
  );

  it('refuses a cancel of a job the caller does not own', async () => {
    const [owner, stranger] = await Promise.all([
      register('cancel-owner'),
      register('cancel-stranger'),
    ]);
    const { body: created } = await submit(owner);

    await request(server)
      .post(`/jobs/${created.data.id}/cancel`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(404);

    const { body } = await request(server)
      .get(`/jobs/${created.data.id}`)
      .set('Authorization', `Bearer ${owner}`);

    // Not just hidden: the stranger's request changed nothing.
    expect(body.data).toMatchObject({
      status: 'QUEUED',
      cancelRequested: false,
    });
  });

  it('can list cancelled jobs by status', async () => {
    const token = await register('cancel-list');
    const { body: created } = await submit(token);

    await request(server)
      .post(`/jobs/${created.data.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);

    const { body } = await request(server)
      .get('/jobs?status=CANCELLED')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(body.data.items.map((job: { id: string }) => job.id)).toEqual([
      created.data.id,
    ]);
  });
});

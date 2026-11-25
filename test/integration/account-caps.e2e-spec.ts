import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { lockAccount } from '../../src/prisma/account-lock.js';
import { StorageService } from '../../src/storage/storage.service.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { JobStatus } from '../../src/generated/prisma/enums.js';
import { postUploadForm } from '../support/upload-form.js';
import { registerAndLogin, startApp } from '../support/http.js';
import { deleteUsers, seedPipeline } from '../support/db.js';

// The documented numbers (§15.2), not the constants that hold them: a client
// is told these, so changing one is changing the contract.
const IMPORTS = 3;
const IMAGE_BATCHES = 50;
const AI_BATCHES = 10;
const UPLOAD_SLIPS_PER_DAY = 20;

// Caps are filled with seeded rows wherever the test needs them to stay full:
// a seeded row has no queue entry, so no worker — one another suite left
// running, say — can finish it mid-test.
describe('per-account caps', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  const users: string[] = [];

  const register = async (label: string) => {
    const account = await registerAndLogin(server, `caps-${label}`);

    users.push(account.userId);

    return account;
  };

  beforeAll(async () => {
    ({ app, server } = await startApp());
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await app.close();
  });

  // Rows written directly: what is under test is how many the account holds,
  // not how each came to be in its state.
  const seed = (
    userId: string,
    type: string,
    count: number,
    {
      status = 'QUEUED',
      finishedAt,
      pipelineId,
      holding = pipelineId !== undefined,
    }: {
      status?: JobStatus;
      finishedAt?: Date;
      /** Batches of this pipeline, holding their place in it unless told not. */
      pipelineId?: string;
      holding?: boolean;
    } = {},
  ) =>
    prisma.job.createManyAndReturn({
      data: Array.from({ length: count }, () => ({
        userId,
        type,
        payload: {},
        status,
        pipelineId,
        pendingInPipeline: holding,
        // A job has a finishedAt exactly when it is finished (a CHECK).
        finishedAt:
          finishedAt ??
          (status === 'QUEUED' || status === 'RUNNING' ? null : new Date()),
        error:
          status === 'DEAD_LETTERED'
            ? { code: 'ATTEMPTS_EXHAUSTED', message: 'it died', attempt: 5 }
            : undefined,
        idempotencyKey: `seed-${randomUUID()}`,
        correlationId: 'test',
      })),
      select: { id: true },
    });

  const unfinished = (userId: string, type: string) =>
    prisma.job.count({
      where: { userId, type, status: { in: ['QUEUED', 'RUNNING'] } },
    });

  const statusOf = async (jobId: string) =>
    (await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status;

  const slip = (token: string) =>
    request(server).post('/uploads').set('Authorization', `Bearer ${token}`);

  // The file is checked at submit, so an import needs a real one. One is
  // enough for any number of jobs — which is the abuse the cap answers.
  const uploaded = async (token: string) => {
    const { body } = await slip(token);

    expect(
      (await postUploadForm(body.data, 'sku,name,price,currency\n')).status,
    ).toBe(204);

    return body.data.key as string;
  };

  const submit = (
    token: string,
    job: { type: string; payload: unknown },
    idempotencyKey = randomUUID(),
  ) =>
    request(server)
      .post('/jobs')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(job);

  const importOf = (key: string) => ({
    type: 'import.csv',
    payload: { key },
  });

  const expectCapped = (res: request.Response) => {
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_UNFINISHED_JOBS');
    // Nothing here knows when one of the account's jobs will finish.
    expect(res.headers['retry-after']).toBeUndefined();
  };

  // Whether some connection is waiting on a lock the backend `pid` holds,
  // asked until one is or the time runs out.
  const blockedBehind = async (pid: number) => {
    const deadline = Date.now() + 3_000;

    while (Date.now() < deadline) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE ${pid}::int = ANY (pg_blocking_pids(pid))`;

      if (waiting > 0) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    return false;
  };

  // A cap is a count and then a write, and two requests that overlap between
  // them could both take one free place. Fired together over HTTP they never
  // overlap — each transaction lasts a couple of milliseconds — so the test
  // plays the other request itself: it takes the account's lock, fills the
  // last place, and holds its transaction open while `send` makes the request
  // under test. That request must be seen waiting behind it — the only thing
  // the two share is the lock — and, let through, must find the place taken.
  const whileLastPlaceIsTaken = async <T>(
    userId: string,
    fill: (tx: Prisma.TransactionClient) => Promise<unknown>,
    send: () => Promise<T>,
  ) => {
    let filled!: (pid: number) => void;
    let release!: () => void;
    const placeFilled = new Promise<number>((resolve) => (filled = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));

    const other = prisma.$transaction(
      async (tx) => {
        await lockAccount(tx, userId);
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid`;
        await fill(tx);
        filled(pid);
        await released;
      },
      { timeout: 10_000 },
    );

    const holder = await placeFilled;
    const answer = send();
    const waited = await blockedBehind(holder);
    release();
    await other;

    expect(waited, 'the request never waited for the account lock').toBe(true);

    return answer;
  };

  const unfinishedRow = (userId: string, type: string) => ({
    userId,
    type,
    payload: {},
    idempotencyKey: `held-${randomUUID()}`,
    correlationId: 'test',
  });

  describe('unfinished jobs', () => {
    it(`refuses an import past ${IMPORTS} unfinished, creating no job`, async () => {
      const { token, userId } = await register('imports');
      const key = await uploaded(token);

      for (let n = 0; n < IMPORTS; n++) {
        await submit(token, importOf(key)).expect(202);
      }

      expectCapped(await submit(token, importOf(key)));
      expect(await unfinished(userId, 'import.csv')).toBe(IMPORTS);
    });

    it('still answers a replay with the account at its cap', async () => {
      const { token, userId } = await register('replay');
      const key = await uploaded(token);
      const idempotencyKey = randomUUID();

      const first = await submit(token, importOf(key), idempotencyKey);
      await seed(userId, 'import.csv', IMPORTS);

      const replay = await submit(token, importOf(key), idempotencyKey);

      expect(replay.status).toBe(202);
      expect(replay.body.data).toMatchObject({
        id: first.body.data.id,
        replayed: true,
      });
    });

    it('makes room when one of them is cancelled', async () => {
      const { token, userId } = await register('cancel');
      const key = await uploaded(token);
      const [first] = await seed(userId, 'import.csv', IMPORTS);

      expectCapped(await submit(token, importOf(key)));

      await request(server)
        .post(`/jobs/${first!.id}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      await submit(token, importOf(key)).expect(202);
    });

    it('counts finished jobs out', async () => {
      const { token, userId } = await register('finished');
      const key = await uploaded(token);

      for (const status of [
        'SUCCEEDED',
        'DEAD_LETTERED',
        'CANCELLED',
      ] as JobStatus[]) {
        await seed(userId, 'import.csv', IMPORTS, { status });
      }

      await seed(userId, 'import.csv', IMPORTS - 1);

      await submit(token, importOf(key)).expect(202);
    });

    it('keeps each type and each account to its own count', async () => {
      const full = await register('full');
      const other = await register('other');
      await seed(full.userId, 'import.csv', IMPORTS);

      await submit(full.token, {
        type: 'MOCK',
        payload: { durationMs: 10 },
      }).expect(202);
      await submit(full.token, {
        type: 'image.process',
        payload: { skus: ['A-1'] },
      }).expect(202);
      await submit(other.token, importOf(await uploaded(other.token))).expect(
        202,
      );
    });

    it(`refuses an image batch past ${IMAGE_BATCHES} unfinished`, async () => {
      const { token, userId } = await register('images');
      // Running counts as much as waiting.
      await seed(userId, 'image.process', IMAGE_BATCHES / 2);
      await seed(userId, 'image.process', IMAGE_BATCHES / 2, {
        status: 'RUNNING',
      });

      expectCapped(
        await submit(token, {
          type: 'image.process',
          payload: { skus: ['A-1'] },
        }),
      );
    });

    it(`refuses an enrichment past ${AI_BATCHES} unfinished`, async () => {
      const { token, userId } = await register('enrich');
      await seed(userId, 'ai.enrich', AI_BATCHES);

      expectCapped(
        await submit(token, { type: 'ai.enrich', payload: { skus: ['A-1'] } }),
      );
    });

    // A pipeline is limited as a whole (§6.3e). Counting its batches would
    // refuse the owner's own work until a large catalog drained.
    it("counts no pipeline's batch still holding its place", async () => {
      const { token, userId } = await register('pipeline-held');
      const { id: pipelineId } = await seedPipeline(prisma, { userId });
      await seed(userId, 'image.process', IMAGE_BATCHES + 10, { pipelineId });
      await seed(userId, 'ai.enrich', AI_BATCHES + 10, { pipelineId });

      await submit(token, {
        type: 'image.process',
        payload: { skus: ['A-1'] },
      }).expect(202);
      await submit(token, {
        type: 'ai.enrich',
        payload: { skus: ['A-1'] },
      }).expect(202);
    });

    // Its first finish gave its place up: from then on it is the owner's to
    // re-drive, and counts like any job.
    it("counts a pipeline's batch re-driven after its first finish", async () => {
      const { token, userId } = await register('pipeline-redriven');
      const { id: pipelineId } = await seedPipeline(prisma, { userId });
      await seed(userId, 'image.process', IMAGE_BATCHES, {
        pipelineId,
        holding: false,
      });

      expectCapped(
        await submit(token, {
          type: 'image.process',
          payload: { skus: ['A-1'] },
        }),
      );
    });

    it('waits for a request taking the last place, then refuses', async () => {
      const { token, userId } = await register('race');
      await seed(userId, 'image.process', IMAGE_BATCHES - 1);

      const answer = await whileLastPlaceIsTaken(
        userId,
        (tx) => tx.job.create({ data: unfinishedRow(userId, 'image.process') }),
        async () =>
          submit(token, {
            type: 'image.process',
            payload: { skus: ['A-1'] },
          }),
      );

      expectCapped(answer);
      expect(await unfinished(userId, 'image.process')).toBe(IMAGE_BATCHES);
    });
  });

  describe('re-drives', () => {
    const died = (minutesAgo: number) =>
      new Date(Date.now() - minutesAgo * 60_000);

    it('refuses a re-drive past the cap, and leaves the job dead', async () => {
      const { token, userId } = await register('redrive');
      await seed(userId, 'import.csv', IMPORTS - 1);
      const [first, second] = await seed(userId, 'import.csv', 2, {
        status: 'DEAD_LETTERED',
        finishedAt: died(5),
      });
      const redrive = (jobId: string) =>
        request(server)
          .post(`/jobs/${jobId}/retry`)
          .set('Authorization', `Bearer ${token}`);

      await redrive(first!.id).expect(202);
      expectCapped(await redrive(second!.id));
      expect(await statusOf(second!.id)).toBe('DEAD_LETTERED');
    });

    // A22's re-drive, with the rest of its pipeline still queued: the review
    // found it refused while 50 of the pipeline's image batches waited.
    it("re-drives a pipeline's failed batch while its siblings hold their places", async () => {
      const { token, userId } = await register('redrive-pipeline');
      const { id: pipelineId } = await seedPipeline(prisma, { userId });
      await seed(userId, 'image.process', IMAGE_BATCHES + 10, { pipelineId });
      const [one, other] = await seed(userId, 'image.process', 2, {
        status: 'DEAD_LETTERED',
        finishedAt: died(5),
        pipelineId,
        holding: false,
      });

      await request(server)
        .post(`/jobs/${one!.id}/retry`)
        .set('Authorization', `Bearer ${token}`)
        .expect(202);

      const { body } = await request(server)
        .post('/jobs/retry')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'image.process', errorCode: 'ATTEMPTS_EXHAUSTED' })
        .expect(202);

      expect(body.data).toEqual({ redriven: 1, remaining: 0 });
      expect(await statusOf(other!.id)).toBe('QUEUED');
    });

    it('brings back in bulk only as many as there is room for', async () => {
      const { token, userId } = await register('bulk');
      await seed(userId, 'import.csv', IMPORTS - 1);
      const imports = await seed(userId, 'import.csv', 3, {
        status: 'DEAD_LETTERED',
        finishedAt: died(10),
      });
      const mocks = await seed(userId, 'MOCK', 2, {
        status: 'DEAD_LETTERED',
        finishedAt: died(5),
      });

      const { status, body } = await request(server)
        .post('/jobs/retry')
        .set('Authorization', `Bearer ${token}`)
        .send({ errorCode: 'ATTEMPTS_EXHAUSTED' });

      expect(status).toBe(202);
      expect(body.data).toEqual({ redriven: 3, remaining: 2 });
      expect(await unfinished(userId, 'import.csv')).toBe(IMPORTS);
      for (const { id } of mocks) {
        expect(await statusOf(id)).toBe('QUEUED');
      }
      expect(
        (await Promise.all(imports.map(({ id }) => statusOf(id)))).filter(
          (jobStatus) => jobStatus === 'DEAD_LETTERED',
        ),
      ).toHaveLength(2);
    });

    // Older dead imports than anything else, and the account at its import
    // cap: a batch that took them first would re-drive nothing, call after
    // call.
    it('reaches the dead letters behind a type at its cap', async () => {
      const { token, userId } = await register('behind');
      await seed(userId, 'import.csv', IMPORTS);
      await seed(userId, 'import.csv', 3, {
        status: 'DEAD_LETTERED',
        finishedAt: died(10),
      });
      const [mock] = await seed(userId, 'MOCK', 1, {
        status: 'DEAD_LETTERED',
        finishedAt: died(5),
      });

      const { body } = await request(server)
        .post('/jobs/retry')
        .set('Authorization', `Bearer ${token}`)
        .send({ errorCode: 'ATTEMPTS_EXHAUSTED', limit: 1 });

      expect(body.data).toEqual({ redriven: 1, remaining: 3 });
      expect(await statusOf(mock!.id)).toBe('QUEUED');
    });

    it('waits for a request taking the last place before re-driving', async () => {
      const { token, userId } = await register('redrive-race');
      await seed(userId, 'import.csv', IMPORTS - 1);
      const [dead] = await seed(userId, 'import.csv', 2, {
        status: 'DEAD_LETTERED',
        finishedAt: died(10),
      });
      const fill = (tx: Prisma.TransactionClient) =>
        tx.job.create({ data: unfinishedRow(userId, 'import.csv') });

      expectCapped(
        await whileLastPlaceIsTaken(userId, fill, async () =>
          request(server)
            .post(`/jobs/${dead!.id}/retry`)
            .set('Authorization', `Bearer ${token}`),
        ),
      );

      await prisma.job.updateMany({
        where: { userId, idempotencyKey: { startsWith: 'held-' } },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });

      const bulk = await whileLastPlaceIsTaken(userId, fill, async () =>
        request(server)
          .post('/jobs/retry')
          .set('Authorization', `Bearer ${token}`)
          .send({ type: 'import.csv' }),
      );

      expect(bulk.body.data).toEqual({ redriven: 0, remaining: 2 });
      expect(await unfinished(userId, 'import.csv')).toBe(IMPORTS);
    });
  });

  describe('upload slips', () => {
    const slipsOf = (userId: string) =>
      prisma.uploadSlip.count({ where: { userId } });

    it(`refuses a slip past ${UPLOAD_SLIPS_PER_DAY} in a day, and not another account's`, async () => {
      const { token, userId } = await register('slips');
      const other = await register('slips-other');

      for (let n = 0; n < UPLOAD_SLIPS_PER_DAY; n++) {
        await slip(token).expect(200);
      }

      const refused = await slip(token);

      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('TOO_MANY_UPLOADS');
      expect(await slipsOf(userId)).toBe(UPLOAD_SLIPS_PER_DAY);
      await slip(other.token).expect(200);
    });

    it('stops counting a slip after a day, and deletes it', async () => {
      const { token, userId } = await register('slips-old');
      await prisma.uploadSlip.createMany({
        data: Array.from({ length: UPLOAD_SLIPS_PER_DAY }, () => ({
          userId,
          key: `uploads/${userId}/${randomUUID()}.csv`,
          createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        })),
      });

      await slip(token).expect(200);

      expect(await slipsOf(userId)).toBe(1);
    });

    it('does not count a slip that failed to sign', async () => {
      const { token, userId } = await register('slips-unsigned');
      vi.spyOn(app.get(StorageService), 'signUpload').mockRejectedValueOnce(
        new Error('no credentials'),
      );

      await slip(token).expect(500);

      expect(await slipsOf(userId)).toBe(0);
    });

    it('waits for a request taking the last slip, then refuses', async () => {
      const { token, userId } = await register('slips-race');
      const slipRow = () => ({
        userId,
        key: `uploads/${userId}/${randomUUID()}.csv`,
      });
      await prisma.uploadSlip.createMany({
        data: Array.from({ length: UPLOAD_SLIPS_PER_DAY - 1 }, slipRow),
      });

      const answer = await whileLastPlaceIsTaken(
        userId,
        (tx) => tx.uploadSlip.create({ data: slipRow() }),
        async () => slip(token),
      );

      expect(answer.status).toBe(429);
      expect(await slipsOf(userId)).toBe(UPLOAD_SLIPS_PER_DAY);
    });
  });
});

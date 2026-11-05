import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { StorageService } from '../../src/storage/storage.service.js';
import { mintUploadKey } from '../../src/storage/upload-key.js';
import { UPLOAD_MAX_BYTES } from '../../src/uploads/uploads.service.js';
import { postUploadForm as send } from '../support/upload-form.js';

// Against the real dev bucket (D29): what is under test is S3 enforcing the
// policy the API signed, which no stand-in for S3 can prove. Keys this file
// mints itself live under test/<run>/, and the bucket's lifecycle rule
// deletes everything within days.
describe('uploads', () => {
  const run = randomUUID();

  let app: INestApplication;
  let server: Server;
  let storage: StorageService;

  const register = async (label: string) => {
    const email = `upload-${label}-${randomUUID()}@example.com`;

    await request(server)
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);

    const { body } = await request(server)
      .post('/auth/login')
      .send({ email, password: 'password123' });

    return {
      token: body.data.accessToken as string,
      userId: body.data.user.id as string,
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
    server = app.getHttpServer();
    storage = app.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a caller without a token', async () => {
    await request(server).post('/uploads').expect(401);
  });

  it("signs an upload to a key under the caller's own prefix", async () => {
    const { token, userId } = await register('prefix');

    const { status, body } = await request(server)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`);

    expect(status).toBe(200);
    expect(body.data.key).toMatch(
      new RegExp(`^uploads/${userId}/[0-9a-f-]{36}\\.csv$`),
    );
    expect(body.data.fields.key).toBe(body.data.key);
    expect(body.data.maxBytes).toBe(UPLOAD_MAX_BYTES);
    expect(new Date(body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('stores the file at that key and serves it back through a signed link', async () => {
    const { token } = await register('roundtrip');
    const { body } = await request(server)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`);
    const csv = 'sku,name\nA-1,Mug\n';

    const uploaded = await send(body.data, csv);
    expect(uploaded.status).toBe(204);

    const downloaded = await fetch(
      await storage.signDownload(body.data.key, 60),
    );
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(csv);
  });

  // The client holds the form, so it can edit any field — the signature is
  // what stops a slip for one key being spent on another tenant's.
  it('refuses the same slip sent to a different key', async () => {
    const { token } = await register('tamper');
    const { body } = await request(server)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`);

    const tampered = await send(body.data, 'sku\n', {
      key: `uploads/${randomUUID()}/stolen.csv`,
    });

    expect(tampered.status).toBe(403);
  });

  describe('submitting an import', () => {
    const importJob = (
      token: string,
      key: string,
      idempotencyKey = randomUUID(),
    ) =>
      request(server)
        .post('/jobs')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ type: 'import.csv', payload: { key } });

    const uploaded = async (token: string) => {
      const { body } = await request(server)
        .post('/uploads')
        .set('Authorization', `Bearer ${token}`);

      expect((await send(body.data, 'sku,name,price,currency\n')).status).toBe(
        204,
      );

      return body.data.key as string;
    };

    const jobsOf = async (token: string) =>
      (
        await request(server)
          .get('/jobs')
          .set('Authorization', `Bearer ${token}`)
      ).body.data.total as number;

    // Uploaded, so it exists: only the ownership check can refuse it.
    it("refuses another account's uploaded file, creating no job", async () => {
      const [mine, theirs] = [
        await register('import-mine'),
        await register('import-theirs'),
      ];
      const theirKey = await uploaded(theirs.token);

      const { status, body } = await importJob(mine.token, theirKey);

      expect(status).toBe(422);
      expect(body.error.code).toBe('UPLOAD_NOT_FOUND');
      expect(await jobsOf(mine.token)).toBe(0);
    });

    // The same answer as above, so a probe cannot tell another tenant's key
    // that exists from one that does not.
    it('refuses a key of its own that was never uploaded', async () => {
      const { token, userId } = await register('import-missing');

      const { status, body } = await importJob(token, mintUploadKey(userId));

      expect(status).toBe(422);
      expect(body.error.code).toBe('UPLOAD_NOT_FOUND');
      expect(await jobsOf(token)).toBe(0);
    });

    it('accepts an uploaded file of its own', async () => {
      const { token } = await register('import-accepted');

      const { status, body } = await importJob(token, await uploaded(token));

      expect(status).toBe(202);
      expect(body.data).toMatchObject({ type: 'import.csv', status: 'QUEUED' });
    });

    // The file can expire from the bucket after the job was accepted; a
    // client retrying that submit must still get its job back (D1).
    it('still answers a replay once the file is gone', async () => {
      const { token } = await register('import-replay');
      const key = await uploaded(token);
      const idempotencyKey = randomUUID();

      const first = await importJob(token, key, idempotencyKey);

      await new S3Client({ region: process.env.AWS_REGION }).send(
        new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
      );

      const replay = await importJob(token, key, idempotencyKey);

      expect(replay.status).toBe(202);
      expect(replay.body.data).toMatchObject({
        id: first.body.data.id,
        replayed: true,
      });
    });
  });

  it.each([
    ['larger than the policy allows', 'x'.repeat(11), 'EntityTooLarge'],
    ['empty', '', 'EntityTooSmall'],
  ])('lets S3 refuse a file %s', async (_label, content, code) => {
    const slip = await storage.signUpload(`test/${run}/limits.csv`, 10, 60);

    const refused = await send(slip, content);

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(`<Code>${code}</Code>`);
  });
});

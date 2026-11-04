import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import {
  StorageService,
  type UploadSlip,
} from '../../src/storage/storage.service.js';
import { UPLOAD_MAX_BYTES } from '../../src/uploads/uploads.service.js';

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

  // How a browser sends it: every signed field, then the file, last.
  const send = (
    slip: Pick<UploadSlip, 'url' | 'fields'>,
    body: string,
    override: Record<string, string> = {},
  ) => {
    const form = new FormData();

    for (const [name, value] of Object.entries({
      ...slip.fields,
      ...override,
    })) {
      form.append(name, value);
    }

    form.append('file', new Blob([body], { type: 'text/csv' }));

    return fetch(slip.url, { method: 'POST', body: form });
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

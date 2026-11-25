import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import type { ZodType } from 'zod';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { failed, succeeded } from '../../src/docs/openapi-schemas.js';
import {
  signedInView,
  tokensView,
  userView,
} from '../../src/auth/auth.responses.js';
import {
  apiKeyView,
  createdApiKeyView,
} from '../../src/api-keys/api-keys.responses.js';
import { uploadSlipView } from '../../src/uploads/uploads.responses.js';
import { productPage } from '../../src/products/products.responses.js';
import {
  jobPage,
  jobView,
  pipelineView,
  redrivenView,
  startedPipelineView,
  submittedJobView,
} from '../../src/jobs/jobs.responses.js';
import { z } from 'zod';
import { postUploadForm } from '../support/upload-form.js';
import { startApp } from '../support/http.js';
import { deleteUsers, seedJob, seedPipeline } from '../support/db.js';
import { pipelineKey } from '../../src/jobs/engine/pipeline-keys.js';
import { hashEnrichmentInput } from '../../src/enrichment/enrichment-input.js';

interface Operation {
  security?: Record<string, string[]>[];
  parameters?: { name: string; in: string; required?: boolean }[];
  responses: Record<string, unknown>;
}

type Document = {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, unknown> };
};

// The API's reference at /docs (§6.5): what it lists, how it says each route
// is signed in to, and — by calling every public route — that each answer is
// the one it describes.
describe('the API reference', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  let document: Document;
  const users: string[] = [];

  // Parses an answer as the reference describes it: a field the document
  // does not name fails the strict schema, as a missing one does.
  const answers = (schema: ZodType, body: unknown) =>
    expect(() => succeeded(schema).parse(body)).not.toThrow();

  beforeAll(async () => {
    ({ app, server } = await startApp());
    prisma = app.get(PrismaService);
    document = (await request(server).get('/docs/openapi.json').expect(200))
      .body as Document;
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await app.close();
  });

  it('serves the reference as a page, and as an OpenAPI document', async () => {
    const page = await request(server).get('/docs').expect(200);

    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(document.openapi).toMatch(/^3\./);
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
      'apiKey',
      'session',
    ]);
  });

  it("lists a client's routes, and not the operator's or the platform's", () => {
    const paths = Object.keys(document.paths);

    expect(paths).toEqual(
      expect.arrayContaining([
        '/auth/login',
        '/api-keys',
        '/api-keys/{id}/revoke',
        '/uploads',
        '/jobs',
        '/jobs/{id}',
        '/jobs/dead-letters',
        '/pipelines',
        '/pipelines/{id}',
        '/products',
      ]),
    );

    for (const hidden of ['/admin/api-keys', '/health', '/ready', '/']) {
      expect(paths).not.toContain(hidden);
    }
  });

  it('says a key or a session works where the guard takes either, and only a session elsewhere', () => {
    const either = [{ session: [] }, { apiKey: [] }];

    expect(document.paths['/jobs']!.post!.security).toEqual(either);
    expect(document.paths['/products']!.get!.security).toEqual(either);
    expect(document.paths['/api-keys']!.post!.security).toEqual([
      { session: [] },
    ]);
    expect(document.paths['/auth/logout']!.post!.security).toEqual([
      { session: [] },
    ]);
    expect(document.paths['/auth/login']!.post!.security).toBeUndefined();
  });

  it('requires an Idempotency-Key where a request starts work', () => {
    for (const path of ['/jobs', '/pipelines']) {
      expect(document.paths[path]!.post!.parameters).toContainEqual(
        expect.objectContaining({
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
        }),
      );
    }
  });

  it('gives every operation an answer for success and one for failure', () => {
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, { responses }] of Object.entries(operations)) {
        const statuses = Object.keys(responses);

        expect(
          statuses.some((status) => /^2\d\d$/.test(status)),
          `${method} ${path}`,
        ).toBe(true);
        expect(responses.default, `${method} ${path}`).toEqual(
          expect.objectContaining({ description: expect.any(String) }),
        );
      }
    }
  });

  it('answers every public route as it describes', async () => {
    const email = `docs-${randomUUID()}@example.com`;
    const password = 'password123';

    const registered = await request(server)
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    answers(userView, registered.body);
    users.push(registered.body.data.id);

    const signedIn = await request(server)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    answers(signedInView, signedIn.body);

    const renewed = await request(server)
      .post('/auth/refresh')
      .send({ refreshToken: signedIn.body.data.refreshToken })
      .expect(200);

    answers(tokensView, renewed.body);

    const auth = { Authorization: `Bearer ${renewed.body.data.accessToken}` };
    const userId = registered.body.data.id as string;

    const made = await request(server)
      .post('/api-keys')
      .set(auth)
      .send({ name: 'Docs', scopes: ['read'] })
      .expect(201);

    answers(createdApiKeyView, made.body);
    answers(
      z.array(apiKeyView),
      (await request(server).get('/api-keys').set(auth).expect(200)).body,
    );
    answers(
      apiKeyView,
      (
        await request(server)
          .post(`/api-keys/${made.body.data.id}/revoke`)
          .set(auth)
          .expect(200)
      ).body,
    );

    const slip = await request(server).post('/uploads').set(auth).expect(200);

    answers(uploadSlipView, slip.body);
    expect(
      (await postUploadForm(slip.body.data, 'sku,name,price,currency\n'))
        .status,
    ).toBe(204);

    const started = await request(server)
      .post('/pipelines')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ key: slip.body.data.key })
      .expect(202);

    answers(startedPipelineView, started.body);
    answers(
      pipelineView,
      (
        await request(server)
          .get(`/pipelines/${started.body.data.id}`)
          .set(auth)
          .expect(200)
      ).body,
    );

    const submitted = await request(server)
      .post('/jobs')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({ type: 'MOCK', payload: {} })
      .expect(202);

    answers(submittedJobView, submitted.body);
    answers(
      jobView,
      (
        await request(server)
          .get(`/jobs/${submitted.body.data.id}`)
          .set(auth)
          .expect(200)
      ).body,
    );
    answers(
      jobPage,
      (await request(server).get('/jobs').set(auth).expect(200)).body,
    );
    answers(
      jobView,
      (
        await request(server)
          .post(`/jobs/${submitted.body.data.id}/cancel`)
          .set(auth)
          .expect(202)
      ).body,
    );

    const dead = await seedJob(prisma, {
      userId,
      status: 'DEAD_LETTERED',
      error: { code: 'TERMINAL_FAILURE', message: 'it died', attempt: 1 },
    });

    answers(
      jobPage,
      (await request(server).get('/jobs/dead-letters').set(auth).expect(200))
        .body,
    );
    answers(
      redrivenView,
      (
        await request(server)
          .post('/jobs/retry')
          .set(auth)
          .send({ type: 'MOCK', dryRun: true })
          .expect(202)
      ).body,
    );
    answers(
      jobView,
      (
        await request(server)
          .post(`/jobs/${dead.id}/retry`)
          .set(auth)
          .expect(202)
      ).body,
    );

    // A job with a result and progress, and a pipeline with its summary:
    // the shapes a fresh one leaves empty.
    await seedJob(prisma, {
      userId,
      status: 'SUCCEEDED',
      attempts: 1,
      result: { slept: 10 },
      progress: { processed: 3, total: 3, message: 'done' },
    });

    const finished = await seedPipeline(prisma, {
      userId,
      status: 'COMPLETED_WITH_ERRORS',
      pendingChildren: 0,
      failedChildren: 1,
      summary: {
        import: { rows: 2, imported: 2, invalid: 0 },
        enrich: { batches: 1, failedBatches: 1, enriched: 0, failed: 0 },
        images: { batches: 0, failedBatches: 0, processed: 0, failed: 0 },
      },
    });

    await seedJob(prisma, {
      userId,
      type: 'import.csv',
      idempotencyKey: pipelineKey(finished.id, 'import'),
      pipelineId: finished.id,
      status: 'SUCCEEDED',
    });
    answers(
      jobPage,
      (await request(server).get('/jobs').set(auth).expect(200)).body,
    );
    answers(
      pipelineView,
      (
        await request(server)
          .get(`/pipelines/${finished.id}`)
          .set(auth)
          .expect(200)
      ).body,
    );

    // Every shape a product's image and enrichment can take.
    const url = 'https://shop.example/desk.jpg';

    await prisma.product.createMany({
      data: [
        { userId, sku: 'BARE', name: 'Bare', priceCents: 100, currency: 'EUR' },
        {
          userId,
          sku: 'DONE',
          name: 'Desk',
          priceCents: 100,
          currency: 'EUR',
          imageUrl: url,
          imageSourceUrl: url,
          imageStatus: 'READY',
          enrichmentStatus: 'READY',
          enrichmentInputHash: hashEnrichmentInput({
            name: 'Desk',
            description: null,
          }),
          category: 'home',
          tags: ['desk'],
        },
        {
          userId,
          sku: 'FAILED',
          name: 'Lamp',
          priceCents: 100,
          currency: 'EUR',
          imageUrl: url,
          imageSourceUrl: url,
          imageStatus: 'FAILED',
          imageError: 'Not an image',
          enrichmentStatus: 'FAILED',
          enrichmentInputHash: hashEnrichmentInput({
            name: 'Lamp',
            description: null,
          }),
          enrichmentError: 'No answer',
        },
        {
          userId,
          sku: 'WAITING',
          name: 'Chair',
          priceCents: 100,
          currency: 'EUR',
          imageUrl: url,
        },
      ],
    });

    const products = await request(server)
      .get('/products')
      .set(auth)
      .expect(200);

    answers(productPage, products.body);
    expect(
      products.body.data.items.map(
        ({
          image,
          enrichment,
        }: {
          image: { status: string } | null;
          enrichment: { status: string };
        }) => [image?.status ?? null, enrichment.status],
      ),
    ).toEqual([
      [null, 'PENDING'],
      ['READY', 'READY'],
      ['FAILED', 'FAILED'],
      ['PENDING', 'PENDING'],
    ]);

    const missing = await request(server)
      .get(`/jobs/${randomUUID()}`)
      .set(auth)
      .expect(404);

    expect(() => failed.parse(missing.body)).not.toThrow();
  });
});

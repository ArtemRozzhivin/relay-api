import 'dotenv/config';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { ProductsModule } from '../../src/products/products.module.js';
import { ProductsService } from '../../src/products/products.service.js';
import { EnrichmentModule } from '../../src/enrichment/enrichment.module.js';
import {
  LLM_PROVIDER,
  type LlmProvider,
} from '../../src/enrichment/llm-provider.js';
import { CATEGORIES } from '../../src/enrichment/taxonomy.js';
import { AiEnrichJobHandler } from '../../src/jobs/handlers/ai-enrich.handler.js';
import { JobRateLimitedError } from '../../src/jobs/job-handler.js';
import { recordingContext } from '../../src/jobs/job-context.fixture.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
} from '../support/db.js';

// The handler against Postgres, with the fake model the worker is given: what
// it asks, what it records, and what the database refuses whatever it is told.
describe('the ai.enrich handler', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let products: ProductsService;
  let llm: LlmProvider;
  let handler: AiEnrichJobHandler;
  const users: string[] = [];

  const store = async (...names: [sku: string, name: string][]) => {
    const userId = await createThrowawayUser(prisma, 'enrich');

    users.push(userId);
    await prisma.product.createMany({
      data: names.map(([sku, name]) => ({
        userId,
        sku,
        name,
        priceCents: 100,
        currency: 'EUR',
      })),
    });

    return userId;
  };

  const run = (userId: string, skus: string[]) =>
    handler.run(recordingContext({ userId }).context, { skus });

  const stored = async (userId: string) =>
    Object.fromEntries(
      (
        await prisma.product.findMany({
          where: { userId },
          orderBy: { sku: 'asc' },
        })
      ).map((product) => [
        product.sku,
        {
          status: product.enrichmentStatus,
          category: product.category,
          tags: product.tags,
          error: product.enrichmentError,
        },
      ]),
    );

  const view = async (userId: string) =>
    Object.fromEntries(
      (await products.findMany(userId, { limit: 20 })).items.map((product) => [
        product.sku,
        product.enrichment,
      ]),
    );

  beforeAll(async () => {
    moduleRef = await createTestModule({
      imports: [PrismaModule, ProductsModule, EnrichmentModule],
      providers: [AiEnrichJobHandler],
    });
    prisma = moduleRef.get(PrismaService);
    products = moduleRef.get(ProductsService);
    llm = moduleRef.get(LLM_PROVIDER);
    handler = moduleRef.get(AiEnrichJobHandler);
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await moduleRef?.close();
  });

  it('records a listed category and tags for each product, in one request', async () => {
    const userId = await store(
      ['MUG', 'Stoneware Mug'],
      ['SHIRT', 'Blue Cotton Shirt'],
    );
    const enrich = vi.spyOn(llm, 'enrich');

    expect(await run(userId, ['MUG', 'SHIRT', 'GONE'])).toEqual({
      requested: 3,
      enriched: 2,
      failed: 0,
      superseded: 0,
      notFound: ['GONE'],
    });
    expect(enrich).toHaveBeenCalledOnce();
    expect(await view(userId)).toEqual({
      MUG: {
        status: 'READY',
        category: expect.toBeOneOf(CATEGORIES),
        tags: ['stoneware', 'mug'],
      },
      SHIRT: {
        status: 'READY',
        category: expect.toBeOneOf(CATEGORIES),
        tags: ['blue', 'cotton', 'shirt'],
      },
    });
  });

  // A19's core: the bad answer costs its own product, and is never written.
  it('fails only the product given a category outside the list, with the reason', async () => {
    const userId = await store(
      ['LAMP', 'Odd Lamp [llm:off-taxonomy]'],
      ['MUG', 'Stoneware Mug'],
    );
    const enrich = vi.spyOn(llm, 'enrich');

    expect(await run(userId, ['LAMP', 'MUG'])).toMatchObject({
      enriched: 1,
      failed: 1,
    });

    // One corrective request, about the refused product alone.
    expect(enrich).toHaveBeenCalledTimes(2);
    expect(enrich.mock.calls[1][0]).toEqual({
      products: [
        { sku: 'LAMP', name: 'Odd Lamp [llm:off-taxonomy]', description: null },
      ],
      correction: 'LAMP: category: "gadgets" is not one of the categories',
    });
    expect(await stored(userId)).toEqual({
      LAMP: {
        status: 'FAILED',
        category: null,
        tags: [],
        error: 'category: "gadgets" is not one of the categories',
      },
      MUG: {
        status: 'READY',
        category: expect.toBeOneOf(CATEGORIES),
        tags: ['stoneware', 'mug'],
        error: null,
      },
    });
  });

  it('fails every product of a reply that is still not JSON after the corrective request', async () => {
    const userId = await store(
      ['LAMP', 'Lamp [llm:malformed]'],
      ['MUG', 'Stoneware Mug'],
    );
    const enrich = vi.spyOn(llm, 'enrich');

    expect(await run(userId, ['LAMP', 'MUG'])).toMatchObject({
      enriched: 0,
      failed: 2,
    });
    expect(enrich).toHaveBeenCalledTimes(2);
    expect(await view(userId)).toEqual({
      LAMP: { status: 'FAILED', error: 'The reply was not JSON' },
      MUG: { status: 'FAILED', error: 'The reply was not JSON' },
    });
  });

  it('records what the corrective request answered', async () => {
    const userId = await store(['LAMP', 'Lamp [llm:malformed-once]']);

    expect(await run(userId, ['LAMP'])).toMatchObject({
      enriched: 1,
      failed: 0,
    });
    expect((await view(userId)).LAMP).toMatchObject({ status: 'READY' });
  });

  it('leaves a product whose name changed while the model answered to the next run', async () => {
    const userId = await store(['MUG', 'Stoneware Mug']);
    const answer = llm.enrich.bind(llm);

    vi.spyOn(llm, 'enrich').mockImplementation(async (request) => {
      await prisma.product.updateMany({
        where: { userId, sku: 'MUG' },
        data: { name: 'Porcelain Mug' },
      });

      return answer(request);
    });

    expect(await run(userId, ['MUG'])).toMatchObject({
      enriched: 0,
      superseded: 1,
    });
    expect(await stored(userId)).toEqual({
      MUG: { status: null, category: null, tags: [], error: null },
    });
  });

  it('shows an enrichment made from text the product has since replaced as pending', async () => {
    const userId = await store(['MUG', 'Stoneware Mug']);

    expect((await view(userId)).MUG).toEqual({ status: 'PENDING' });

    await run(userId, ['MUG']);
    await prisma.product.updateMany({
      where: { userId },
      data: { description: 'Now dishwasher safe' },
    });

    expect((await view(userId)).MUG).toEqual({ status: 'PENDING' });
  });

  // A20's handler half: the queue's pause comes from this error, and the run
  // after it has to find nothing half written.
  it("turns a busy model into the queue's pause, and writes nothing", async () => {
    const userId = await store(['DESK', 'Desk [llm:busy]'], ['CHAIR', 'Chair']);

    const refused = await run(userId, ['DESK', 'CHAIR']).catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(JobRateLimitedError);
    expect(refused).toMatchObject({ retryAfterMs: 1000 });
    expect(await stored(userId)).toEqual({
      CHAIR: { status: null, category: null, tags: [], error: null },
      DESK: { status: null, category: null, tags: [], error: null },
    });

    // The fake refuses a product once, as a provider's busy spell passes.
    await expect(run(userId, ['DESK', 'CHAIR'])).resolves.toMatchObject({
      enriched: 2,
    });
  });

  it('clears an earlier category when a later run fails', async () => {
    const userId = await store(['LAMP', 'Lamp']);

    await run(userId, ['LAMP']);
    await prisma.product.updateMany({
      where: { userId },
      data: { name: 'Lamp [llm:malformed]' },
    });
    await run(userId, ['LAMP']);

    expect((await stored(userId)).LAMP).toMatchObject({
      status: 'FAILED',
      category: null,
      tags: [],
    });
  });

  // The floor under the handler's own checks: whatever code writes, Postgres
  // holds no category outside the list and no answer without a READY status.
  it.each([
    ['a category outside the list', `"category" = 'gadgets'`],
    ['a category without a status', `"category" = 'kitchen'`],
    ['tags without a status', `"tags" = ARRAY['mug']`],
    [
      'six tags',
      `"enrichmentStatus" = 'READY', "enrichmentInputHash" = 'h', "category" = 'kitchen', "tags" = ARRAY['a','b','c','d','e','f']`,
    ],
    ['an error without a status', `"enrichmentError" = 'why'`],
    ['a status without an input', `"enrichmentStatus" = 'FAILED'`],
  ])('is refused by the database: %s', async (_label, assignments) => {
    const userId = await store(['MUG', 'Stoneware Mug']);

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Product" SET ${assignments} WHERE "userId" = $1::uuid`,
        userId,
      ),
    ).rejects.toThrow();
  });
});

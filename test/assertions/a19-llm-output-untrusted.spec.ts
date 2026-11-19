import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';
import { CATEGORIES } from '../../src/enrichment/taxonomy.js';

// A19 — what a model answers is input, and is checked like any other: an
// answer that does not parse, or names a category outside the list, is never
// written, and costs its own product its enrichment rather than the job its
// attempts. The worker runs with the fake model, which a product's name tells
// how to go wrong (§6.3d).
describe('A19 · LLM output is untrusted input', () => {
  let harness: RelayHarness;
  let account: Account;

  const enrich = async (skus: string[]) => {
    const { body } = await harness.submit(account, {
      type: 'ai.enrich',
      payload: { skus },
    });

    return harness.waitForJobStatus(body.data.id, [
      'SUCCEEDED',
      'DEAD_LETTERED',
    ]);
  };

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    account = await harness.signUp('a19');

    await harness.prisma.product.createMany({
      data: [
        ['MUG', 'Stoneware Mug'],
        ['ODD', 'Odd Lamp [llm:off-taxonomy]'],
        ['LAMP', 'Desk Lamp [llm:malformed]'],
      ].map(([sku, name]) => ({
        userId: account.id,
        sku,
        name,
        priceCents: 100,
        currency: 'EUR',
      })),
    });
  });

  afterAll(() => harness.stop());

  it('fails only the products whose answer did not pass, on the first attempt', async () => {
    // Apart: a reply that is not JSON answers nothing, for every product in
    // its request.
    expect(await enrich(['MUG', 'ODD'])).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
      result: { enriched: 1, failed: 1, superseded: 0 },
    });
    expect(await enrich(['LAMP'])).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
      result: { enriched: 0, failed: 1 },
    });

    const products = await harness.products(account.id);

    expect(
      Object.fromEntries(
        products.map(
          ({ sku, enrichmentStatus, enrichmentError, category, tags }) => [
            sku,
            { enrichmentStatus, enrichmentError, category, tags },
          ],
        ),
      ),
    ).toEqual({
      MUG: {
        enrichmentStatus: 'READY',
        enrichmentError: null,
        category: expect.toBeOneOf(CATEGORIES),
        tags: ['stoneware', 'mug'],
      },
      ODD: {
        enrichmentStatus: 'FAILED',
        enrichmentError: 'category: "gadgets" is not one of the categories',
        category: null,
        tags: [],
      },
      LAMP: {
        enrichmentStatus: 'FAILED',
        enrichmentError: 'The reply was not JSON',
        category: null,
        tags: [],
      },
    });
  });

  it('shows the owner why, in the catalog', async () => {
    const { body } = await harness.request('/products', {
      headers: { Authorization: `Bearer ${account.token}` },
    });

    expect(
      Object.fromEntries(
        (body.data.items as { sku: string; enrichment: unknown }[]).map(
          ({ sku, enrichment }) => [sku, enrichment],
        ),
      ),
    ).toEqual({
      LAMP: { status: 'FAILED', error: 'The reply was not JSON' },
      MUG: {
        status: 'READY',
        category: expect.toBeOneOf(CATEGORIES),
        tags: ['stoneware', 'mug'],
      },
      ODD: {
        status: 'FAILED',
        error: 'category: "gadgets" is not one of the categories',
      },
    });
  });

  it('holds no category outside the list, in the whole table', async () => {
    const outside = await harness.prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS "count" FROM "Product"
      WHERE "category" IS NOT NULL
        AND NOT ("category"::text = ANY(${CATEGORIES}::text[]))
    `;

    expect(outside).toEqual([{ count: 0 }]);
  });
});

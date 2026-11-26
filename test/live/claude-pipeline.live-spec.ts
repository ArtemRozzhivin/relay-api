import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type ProcessHandle,
} from '../harness/relay-harness.js';

// Products whose category no reader would argue about, two to a category and
// two the list has no place for: a wrong answer here is the model's, not the
// catalog's. Twenty-four make two batches, one full and one not.
const CATALOG: Record<
  string,
  [name: string, description: string, category: string]
> = {
  'TEE-1': [
    'Organic cotton crew-neck T-shirt',
    'Unisex; sizes S to XXL',
    'apparel',
  ],
  'JEANS-1': ['Slim-fit stretch denim jeans', 'Dark indigo wash', 'apparel'],
  'BOOT-1': [
    'Waterproof leather hiking boots',
    'Vibram sole and ankle support',
    'footwear',
  ],
  'SNEAK-1': ['White canvas low-top sneakers', 'Rubber sole', 'footwear'],
  'WALLET-1': ['Slim leather bifold wallet', 'Six card slots', 'accessories'],
  'SUN-1': [
    'Polarized aviator sunglasses',
    'Metal frame and UV400 lenses',
    'accessories',
  ],
  'CREAM-1': [
    'Lavender hand cream 75 ml',
    'Shea butter for dry skin',
    'beauty',
  ],
  'LIP-1': ['Matte liquid lipstick', 'Long-wear; shade Ruby', 'beauty'],
  'CANDLE-1': [
    'Scented soy candle in a glass jar',
    'Cedar and vanilla; 40 hours',
    'home',
  ],
  'THROW-1': ['Knitted wool throw blanket', 'For the sofa or the bed', 'home'],
  'PRESS-1': [
    'Stainless steel French press 1 litre',
    'Double-walled',
    'kitchen',
  ],
  'KNIFE-1': [
    "Chef's knife 20 cm",
    'Forged steel with a wooden handle',
    'kitchen',
  ],
  'BUDS-1': [
    'Wireless noise-cancelling earbuds',
    'Bluetooth 5.3; 30 hours with the case',
    'electronics',
  ],
  'CHARGER-1': [
    '65 W USB-C wall charger',
    'Two ports; fast charging for laptops and phones',
    'electronics',
  ],
  'BLOCKS-1': [
    'Wooden building blocks 100 pieces',
    'For children aged 3 and up',
    'toys',
  ],
  'PLUSH-1': ['Plush teddy bear 30 cm', 'Soft toy; machine washable', 'toys'],
  'YOGA-1': ['Non-slip yoga mat 6 mm', 'With a carrying strap', 'sports'],
  'DUMB-1': [
    'Adjustable dumbbell set 2 to 24 kg',
    'For strength training at home',
    'sports',
  ],
  'NOVEL-1': ['Paperback mystery novel', '320 pages; English edition', 'books'],
  'COOK-1': [
    'Hardcover Italian cookbook',
    '150 recipes with photographs',
    'books',
  ],
  'COFFEE-1': ['Whole bean coffee 1 kg', 'Medium roast from Colombia', 'food'],
  'HONEY-1': ['Raw wildflower honey 500 g', 'In a glass jar', 'food'],
  'OIL-1': [
    'Synthetic motor oil 5W-30 5 litres',
    'For petrol and diesel car engines',
    'other',
  ],
  'WIPER-1': [
    'Car windscreen wiper blades',
    'A pair; 60 cm and 45 cm',
    'other',
  ],
};

const SKUS = Object.keys(CATALOG);

// The whole pipeline, against the real model: the API and a worker as their
// own processes, as the assertions run them, the worker told to ask Claude.
// The key and LLM_MODEL come from .env, which the harness loads and the
// worker inherits. Costs about as much as two batches of twenty (D33).
describe('a pipeline, enriched by Claude', () => {
  let harness: RelayHarness;
  let account: Account;
  let worker: ProcessHandle;

  beforeAll(async () => {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) {
      throw new Error('Set ANTHROPIC_API_KEY in .env to run the live tests');
    }

    harness = await RelayHarness.create();
    await harness.startApi();
    worker = harness.startWorker('worker', { LLM_PROVIDER: 'claude' });
    account = await harness.signUp('live');
  });

  afterAll(() => harness?.stop());

  it('categorizes an imported catalog and records the cost on each batch', async () => {
    const key = await harness.upload(
      account,
      [
        'sku,name,description,price,currency',
        ...SKUS.map((sku) => {
          const [name, description] = CATALOG[sku]!;

          return `${sku},${name},${description},9.99,EUR`;
        }),
      ].join('\n'),
    );

    const { status, body } = await harness.startPipeline(account, key);

    expect(status).toBe(202);

    const pipeline = await harness.waitForPipeline(
      body.data.id as string,
      180_000,
    );

    // A job's error names only a correlation id; the cause is in the
    // worker's log, and a run that failed should not have to be paid for
    // again to read it.
    if (pipeline.status !== 'COMPLETED') {
      console.error(
        worker.log
          .split('\n')
          .filter((line) => /\b(WARN|ERROR)\b/.test(line))
          .slice(-5)
          .join('\n'),
      );
    }

    expect(pipeline).toMatchObject({
      status: 'COMPLETED',
      summary: {
        import: { rows: SKUS.length, imported: SKUS.length, invalid: 0 },
        enrich: {
          batches: 2,
          failedBatches: 0,
          enriched: SKUS.length,
          failed: 0,
        },
      },
    });

    const products = await harness.prisma.product.findMany({
      where: { userId: account.id },
      orderBy: { sku: 'asc' },
    });

    for (const { sku, category, tags } of products) {
      console.info(
        `${sku.padEnd(10)} ${String(category).padEnd(12)} ${tags.join(', ')}`,
      );
    }

    expect(
      Object.fromEntries(products.map(({ sku, category }) => [sku, category])),
    ).toEqual(Object.fromEntries(SKUS.map((sku) => [sku, CATALOG[sku]![2]])));

    const batches = await harness.prisma.job.findMany({
      where: { pipelineId: pipeline.id, type: 'ai.enrich' },
    });

    expect(batches).toHaveLength(2);

    for (const batch of batches) {
      expect(batch.tokensIn).toBeGreaterThan(0);
      expect(batch.tokensOut).toBeGreaterThan(0);
      expect(batch.estimatedCostUsd.toNumber()).toBeGreaterThan(0);
    }

    // The number D33 and the README quote, measured rather than estimated.
    const total = batches.reduce(
      (sum, { tokensIn, tokensOut, estimatedCostUsd }) => ({
        tokensIn: sum.tokensIn + tokensIn,
        tokensOut: sum.tokensOut + tokensOut,
        usd: sum.usd + estimatedCostUsd.toNumber(),
      }),
      { tokensIn: 0, tokensOut: 0, usd: 0 },
    );

    console.info(
      `${SKUS.length} products in ${batches.length} batches: ${total.tokensIn} tokens in, ${total.tokensOut} out, $${total.usd.toFixed(4)}; ` +
        `$${((total.usd / SKUS.length) * 5000).toFixed(2)} for a full store of 5,000`,
    );
  });
});

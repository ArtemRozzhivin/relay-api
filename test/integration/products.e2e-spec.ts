import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { ProductsModule } from '../../src/products/products.module.js';
import {
  PRODUCTS_PER_ACCOUNT,
  ProductsService,
  type ProductRow,
} from '../../src/products/products.service.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
} from '../support/db.js';
import { whileLastPlaceIsTaken } from '../support/account-lock.js';

// The upsert is the import's only write, and everything A14 relies on is in
// what it does on a conflict — so each case is asserted against a real
// Postgres, by the rows it leaves behind.
describe('the product upsert', () => {
  let prisma: PrismaService;
  let products: ProductsService;
  const users: string[] = [];

  const store = async () => {
    const userId = await createThrowawayUser(prisma, 'products');

    users.push(userId);

    return userId;
  };

  const row = (
    sku: string,
    overrides: Partial<ProductRow> = {},
  ): ProductRow => ({
    sku,
    name: `Product ${sku}`,
    description: null,
    priceCents: 1000,
    currency: 'EUR',
    imageUrl: null,
    ...overrides,
  });

  const catalog = (userId: string) =>
    prisma.product.findMany({ where: { userId }, orderBy: { sku: 'asc' } });

  beforeAll(async () => {
    const moduleRef = await createTestModule({
      imports: [PrismaModule, ProductsModule],
    });

    prisma = moduleRef.get(PrismaService);
    products = moduleRef.get(ProductsService);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await prisma.$disconnect();
  });

  it('inserts a new batch, keeping every column', async () => {
    const userId = await store();

    expect(
      await products.upsertBatch(userId, [
        row('A-1', {
          description: 'A mug',
          priceCents: 899,
          imageUrl: 'https://example.com/a-1.jpg',
        }),
        row('B-2'),
      ]),
    ).toBe(2);

    expect(await catalog(userId)).toMatchObject([
      {
        sku: 'A-1',
        description: 'A mug',
        priceCents: 899,
        currency: 'EUR',
        imageUrl: 'https://example.com/a-1.jpg',
      },
      { sku: 'B-2', description: null, imageUrl: null },
    ]);
  });

  // What A14's replay depends on: the second write changes nothing, and the
  // rows keep their ids — an update in place, not a delete and a re-insert.
  it('leaves the table as one write did when the same batch is written again', async () => {
    const userId = await store();
    const batch = [row('A-1'), row('B-2'), row('C-3')];

    await products.upsertBatch(userId, batch);
    const first = await catalog(userId);

    await products.upsertBatch(userId, batch);
    const second = await catalog(userId);

    expect(second).toHaveLength(3);
    expect(second.map((product) => product.id)).toEqual(
      first.map((product) => product.id),
    );
  });

  it('lets the newer values win for a sku the store already has', async () => {
    const userId = await store();

    await products.upsertBatch(userId, [row('A-1', { priceCents: 899 })]);
    await products.upsertBatch(userId, [
      row('A-1', { name: 'Mug, large', priceCents: 949 }),
    ]);

    expect(await catalog(userId)).toMatchObject([
      { sku: 'A-1', name: 'Mug, large', priceCents: 949 },
    ]);
  });

  it('never deletes a product a newer file leaves out', async () => {
    const userId = await store();

    await products.upsertBatch(userId, [row('A-1'), row('B-2')]);
    await products.upsertBatch(userId, [row('A-1')]);

    expect((await catalog(userId)).map((product) => product.sku)).toEqual([
      'A-1',
      'B-2',
    ]);
  });

  it("keeps two stores' products apart however alike their skus", async () => {
    const [mine, theirs] = [await store(), await store()];

    await products.upsertBatch(mine, [row('A-1', { name: 'My mug' })]);
    await products.upsertBatch(theirs, [row('A-1', { name: 'Their mug' })]);

    expect(await catalog(mine)).toMatchObject([{ name: 'My mug' }]);
    expect(await catalog(theirs)).toMatchObject([{ name: 'Their mug' }]);
  });

  it('writes a sku that appears twice in one batch once, with its last values', async () => {
    const userId = await store();

    expect(
      await products.upsertBatch(userId, [
        row('A-1', { priceCents: 100 }),
        row('B-2'),
        row('A-1', { priceCents: 200 }),
      ]),
    ).toBe(2);

    expect(await catalog(userId)).toMatchObject([
      { sku: 'A-1', priceCents: 200 },
      { sku: 'B-2' },
    ]);
  });

  it('writes nothing for an empty batch', async () => {
    expect(await products.upsertBatch(await store(), [])).toBe(0);
  });

  // Two imports into one store, holding the same skus in opposite orders. The
  // store already has them, so each write locks rows the other is writing.
  it('writes two overlapping batches at once without deadlocking', async () => {
    const userId = await store();
    const skus = Array.from(
      { length: 2000 },
      (_, n) => `SKU-${String(n).padStart(4, '0')}`,
    );

    await products.upsertBatch(
      userId,
      skus.map((sku) => row(sku)),
    );

    // Several rounds: a single one can finish before the other starts.
    for (let round = 1; round <= 5; round += 1) {
      await Promise.all([
        products.upsertBatch(
          userId,
          skus.map((sku) => row(sku, { priceCents: round })),
        ),
        products.upsertBatch(
          userId,
          [...skus].reverse().map((sku) => row(sku, { priceCents: round })),
        ),
      ]);
    }

    expect(
      await prisma.product.count({ where: { userId, priceCents: 5 } }),
    ).toBe(skus.length);
  });

  // The floor under the import's own validation: a row that slipped past it is
  // refused by Postgres, and the batch with it.
  it.each([
    ['a negative price', { priceCents: -1 }, 'Product_priceCents_not_negative'],
    [
      'a currency that is not ISO 4217',
      { currency: 'eur' },
      'Product_currency_iso4217',
    ],
    ['a blank name', { name: '  ' }, 'Product_name_not_blank'],
    ['a blank sku', { sku: ' ' }, 'Product_sku_not_blank'],
  ])('refuses %s', async (_label, overrides, constraint) => {
    const userId = await store();

    await expect(
      products.upsertBatch(userId, [row('A-1'), row('B-2', overrides)]),
    ).rejects.toThrow(constraint);
    expect(await catalog(userId)).toEqual([]);
  });

  describe("the store's limit", () => {
    // A store `missing` places short of its limit, one of them a known sku.
    const nearlyFull = async (missing: number) => {
      const userId = await store();

      await prisma.product.createMany({
        data: Array.from(
          { length: PRODUCTS_PER_ACCOUNT - missing },
          (_, n) => ({ userId, ...row(n === 0 ? 'KNOWN' : `HELD-${n}`) }),
        ),
      });

      return userId;
    };

    const withinLimit = (userId: string, rows: ProductRow[]) =>
      prisma.$transaction((tx) => products.upsertWithinLimit(userId, rows, tx));

    it('always writes a sku the store has, and new ones while there is room, in order', async () => {
      const userId = await nearlyFull(2);

      expect(
        await withinLimit(userId, [
          row('N-1'),
          row('KNOWN', { name: 'Renamed' }),
          row('N-2'),
          row('N-3'),
        ]),
      ).toEqual({ written: 3, refused: ['N-3'] });
      expect(await prisma.product.count({ where: { userId } })).toBe(
        PRODUCTS_PER_ACCOUNT,
      );
      expect(
        await prisma.product.findFirst({ where: { userId, sku: 'KNOWN' } }),
      ).toMatchObject({ name: 'Renamed' });
    });

    it('takes one place for a sku twice in the batch', async () => {
      const userId = await nearlyFull(1);

      expect(
        await withinLimit(userId, [row('N-1'), row('N-1', { priceCents: 5 })]),
      ).toEqual({ written: 1, refused: [] });
    });

    // Three imports into one store can run at once (D32): each would count
    // one free place, and without the lock both would take it.
    it('waits for an import taking the last place, then refuses', async () => {
      const userId = await nearlyFull(1);

      const answer = await whileLastPlaceIsTaken(
        prisma,
        userId,
        (tx) => products.upsertBatch(userId, [row('N-1')], tx),
        () => withinLimit(userId, [row('N-2')]),
      );

      expect(answer).toEqual({ written: 0, refused: ['N-2'] });
      expect(await prisma.product.count({ where: { userId } })).toBe(
        PRODUCTS_PER_ACCOUNT,
      );
    });
  });

  // Two jobs racing on one product: the one that concluded READY wins, and a
  // late failure about the same input changes nothing.
  describe('a failure recorded after a success', () => {
    const URL = 'https://shop.example/a.png';

    it('leaves an image READY for the same URL', async () => {
      const userId = await store();
      await products.upsertBatch(userId, [row('A-1', { imageUrl: URL })]);
      const { id } = (await catalog(userId))[0]!;

      expect(await products.recordImageReady(userId, id, URL)).toBe(true);
      expect(await products.recordImageFailed(userId, id, URL, 'gave up')).toBe(
        false,
      );
      expect(await catalog(userId)).toMatchObject([
        { imageStatus: 'READY', imageSourceUrl: URL, imageError: null },
      ]);
    });

    it('records a failure about a product with no conclusion yet', async () => {
      const userId = await store();
      await products.upsertBatch(userId, [row('A-1', { imageUrl: URL })]);
      const { id } = (await catalog(userId))[0]!;

      expect(await products.recordImageFailed(userId, id, URL, 'gave up')).toBe(
        true,
      );
      expect(await catalog(userId)).toMatchObject([
        { imageStatus: 'FAILED', imageError: 'gave up' },
      ]);
    });

    it('leaves an enrichment READY for the same text', async () => {
      const userId = await store();
      await products.upsertBatch(userId, [row('A-1')]);
      const { id, name, description } = (await catalog(userId))[0]!;
      const from = { id, name, description };

      expect(
        await products.recordEnrichmentReady(userId, from, {
          category: 'home',
          tags: ['lamp'],
        }),
      ).toBe(true);
      expect(
        await products.recordEnrichmentFailed(userId, from, 'malformed'),
      ).toBe(false);
      expect(await catalog(userId)).toMatchObject([
        { enrichmentStatus: 'READY', category: 'home', tags: ['lamp'] },
      ]);
    });

    it('records a failure about an enrichment with no conclusion yet', async () => {
      const userId = await store();
      await products.upsertBatch(userId, [row('A-1')]);
      const { id, name, description } = (await catalog(userId))[0]!;

      expect(
        await products.recordEnrichmentFailed(
          userId,
          { id, name, description },
          'malformed',
        ),
      ).toBe(true);
    });
  });

  // A CHECK that evaluates to NULL passes: the first form let a reason sit on
  // a product with no conclusion at all.
  it('refuses an image error on a product with no conclusion', async () => {
    const userId = await store();
    await products.upsertBatch(userId, [row('A-1')]);

    await expect(
      prisma.product.updateMany({
        where: { userId },
        data: { imageError: 'a reason about nothing' },
      }),
    ).rejects.toThrow('Product_imageError_only_on_failure');
  });
});

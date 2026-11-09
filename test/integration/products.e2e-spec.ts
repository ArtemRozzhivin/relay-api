import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { ProductsModule } from '../../src/products/products.module.js';
import {
  ProductsService,
  type ProductRow,
} from '../../src/products/products.service.js';

// The upsert is the import's only write, and everything A14 relies on is in
// what it does on a conflict — so each case is asserted against a real
// Postgres, by the rows it leaves behind.
describe('the product upsert', () => {
  let prisma: PrismaService;
  let products: ProductsService;
  const users: string[] = [];

  const store = async () => {
    const user = await prisma.user.create({
      data: {
        email: `products-${randomUUID()}@example.com`,
        passwordHash: 'not-a-real-hash',
      },
    });

    users.push(user.id);

    return user.id;
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
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          envFilePath: ['.env'],
        }),
        PrismaModule,
        ProductsModule,
      ],
    }).compile();

    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    products = moduleRef.get(ProductsService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: users } } });
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
});

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { StorageModule } from '../../src/storage/storage.module.js';
import { StorageService } from '../../src/storage/storage.service.js';
import {
  productImageKey,
  productImagesPrefix,
} from '../../src/storage/object-keys.js';
import {
  IMAGE_FOLDER_IDLE_MS,
  ImageFolderSweeper,
} from '../../src/worker/image-folder.sweeper.js';
import { deleteProductImages } from '../support/product-images.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
} from '../support/db.js';

const SIZES = ['large', 'thumb'];

// Against the dev bucket and Postgres, and under this test's account only:
// the bucket is shared, and a sweep of all of `products/` from here would
// judge other runs' images by this database's rows.
describe('the image folder sweep', () => {
  const s3 = new S3Client({ region: process.env.AWS_REGION });
  const bucket = process.env.S3_BUCKET!;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let storage: StorageService;
  let sweeper: ImageFolderSweeper;
  let userId: string;

  const keysOf = (productId: string, url: string) =>
    SIZES.map((size) => productImageKey(userId, productId, url, size));

  const write = (productId: string, url: string) =>
    Promise.all(
      keysOf(productId, url).map((key) =>
        storage.upload(key, Readable.from([Buffer.from(key)]), {
          contentType: 'image/webp',
        }),
      ),
    );

  const stored = async () => {
    const keys: string[] = [];

    for await (const page of storage.listPages(productImagesPrefix(userId))) {
      keys.push(...page.map(({ key }) => key));
    }

    return keys.sort();
  };

  const sweep = (now?: number) =>
    sweeper.sweep({ prefix: productImagesPrefix(userId), now });

  beforeAll(async () => {
    moduleRef = await createTestModule({
      imports: [PrismaModule, StorageModule],
      providers: [ImageFolderSweeper],
    });
    prisma = moduleRef.get(PrismaService);
    storage = moduleRef.get(StorageService);
    sweeper = moduleRef.get(ImageFolderSweeper);
    userId = await createThrowawayUser(prisma, 'image-sweep');
  });

  afterAll(async () => {
    await deleteProductImages(s3, bucket, userId);
    await deleteUsers(prisma, [userId]);
    await moduleRef?.close();
  });

  it('deletes the folders no product uses once they are idle, and keeps the rest', async () => {
    const shown = 'https://images.test/shown.png';
    const next = 'https://images.test/next.png';
    const replaced = 'https://images.test/replaced.png';
    // Its image was made from `shown`; `next` has been imported since and
    // not made yet.
    const product = await prisma.product.create({
      data: {
        userId,
        sku: 'SHIRT',
        name: 'Shirt',
        priceCents: 100,
        currency: 'EUR',
        imageUrl: next,
        imageStatus: 'READY',
        imageSourceUrl: shown,
      },
    });
    const deletedProduct = randomUUID();

    await write(product.id, shown);
    await write(product.id, next);
    await write(product.id, replaced);
    await write(deletedProduct, shown);

    // S3 sets a file's time when it is written, so a day is passed as `now`.
    expect(await sweep()).toBe(0);
    expect(await sweep(Date.now() + IMAGE_FOLDER_IDLE_MS + 60_000)).toBe(2);
    expect(await stored()).toEqual(
      [...keysOf(product.id, shown), ...keysOf(product.id, next)].sort(),
    );
  });
});

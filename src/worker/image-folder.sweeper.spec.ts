import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  ListedObject,
  StorageService,
} from '../storage/storage.service.js';
import { productImageKey } from '../storage/object-keys.js';
import {
  IMAGE_FOLDER_IDLE_MS,
  ImageFolderSweeper,
} from './image-folder.sweeper.js';

const user = '11111111-1111-4111-8111-111111111111';
const shirt = '22222222-2222-4222-8222-222222222222';
const mug = '33333333-3333-4333-8333-333333333333';
const gone = '44444444-4444-4444-8444-444444444444';

const now = Date.UTC(2026, 10, 18, 12);
const idle = new Date(now - IMAGE_FOLDER_IDLE_MS);
const recent = new Date(now - IMAGE_FOLDER_IDLE_MS + 60_000);

interface Product {
  id: string;
  userId: string;
  imageUrl: string | null;
  imageSourceUrl: string | null;
}

// The sizes of one URL's image, as keys a listing returns.
const sizes = (productId: string, url: string, written: Date) =>
  ['large', 'medium', 'thumb'].map((size) => ({
    key: productImageKey(user, productId, url, size),
    lastModified: written,
  }));

// A sweeper over a bucket listed as `pages`, each given in key order as S3
// lists it, and a database holding `products`. What it deletes lands in
// `deleted`.
const sweeperOver = (pages: ListedObject[][], products: Product[]) => {
  const deleted: string[] = [];

  const storage = {
    async *listPages() {
      yield* pages;
    },
    deleteObjects: async (keys: string[]) => {
      deleted.push(...keys);
    },
  } as unknown as StorageService;

  const prisma = {
    product: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        products.filter((product) => where.id.in.includes(product.id)),
    },
  } as unknown as PrismaService;

  return { sweeper: new ImageFolderSweeper(prisma, storage), deleted };
};

describe('ImageFolderSweeper', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  it('deletes the folder of a replaced URL once it has been idle a day', async () => {
    const { sweeper, deleted } = sweeperOver(
      [[...sizes(shirt, 'https://x.test/old.png', idle)]],
      [
        {
          id: shirt,
          userId: user,
          imageUrl: 'https://x.test/new.png',
          imageSourceUrl: 'https://x.test/new.png',
        },
      ],
    );

    expect(await sweeper.sweep({ now })).toBe(1);
    expect(deleted).toEqual(
      sizes(shirt, 'https://x.test/old.png', idle).map(({ key }) => key),
    );
  });

  // The row points at it: its image, shown to the seller.
  it("keeps the folder the product's image was made from", async () => {
    const { sweeper, deleted } = sweeperOver(
      [[...sizes(shirt, 'https://x.test/a.png', idle)]],
      [
        {
          id: shirt,
          userId: user,
          imageUrl: 'https://x.test/b.png',
          imageSourceUrl: 'https://x.test/a.png',
        },
      ],
    );

    expect(await sweeper.sweep({ now })).toBe(0);
    expect(deleted).toEqual([]);
  });

  // A URL switched back to: a job may be writing its folder again now.
  it("keeps the folder of the product's current URL, made or not", async () => {
    const { sweeper, deleted } = sweeperOver(
      [[...sizes(shirt, 'https://x.test/a.png', idle)]],
      [
        {
          id: shirt,
          userId: user,
          imageUrl: 'https://x.test/a.png',
          imageSourceUrl: 'https://x.test/b.png',
        },
      ],
    );

    expect(await sweeper.sweep({ now })).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('keeps a replaced URL’s folder written to within the day', async () => {
    const { sweeper, deleted } = sweeperOver(
      [
        [
          ...sizes(shirt, 'https://x.test/old.png', idle).slice(0, 2),
          ...sizes(shirt, 'https://x.test/old.png', recent).slice(2),
        ],
      ],
      [
        {
          id: shirt,
          userId: user,
          imageUrl: null,
          imageSourceUrl: null,
        },
      ],
    );

    expect(await sweeper.sweep({ now })).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('deletes the folders of a product that no longer exists', async () => {
    const { sweeper, deleted } = sweeperOver(
      [[...sizes(gone, 'https://x.test/a.png', idle)]],
      [],
    );

    expect(await sweeper.sweep({ now })).toBe(1);
    expect(deleted).toHaveLength(3);
  });

  // A key of the right shape under another account's prefix than the row's.
  it('deletes a folder filed under an account the product is not', async () => {
    const { sweeper, deleted } = sweeperOver(
      [[...sizes(shirt, 'https://x.test/a.png', idle)]],
      [
        {
          id: shirt,
          userId: '55555555-5555-4555-8555-555555555555',
          imageUrl: 'https://x.test/a.png',
          imageSourceUrl: 'https://x.test/a.png',
        },
      ],
    );

    expect(await sweeper.sweep({ now })).toBe(1);
    expect(deleted).toHaveLength(3);
  });

  it('leaves alone keys the image handler does not write', async () => {
    const { sweeper, deleted } = sweeperOver(
      [
        [
          { key: `products/${user}/notes.txt`, lastModified: idle },
          { key: `products/${user}/${shirt}/readme.txt`, lastModified: idle },
        ],
      ],
      [],
    );

    expect(await sweeper.sweep({ now })).toBe(0);
    expect(deleted).toEqual([]);
  });

  // The listing's first page ends partway through the folder; its newest file
  // is on the second.
  it('judges a folder split across pages as a whole', async () => {
    const { sweeper, deleted } = sweeperOver(
      [
        sizes(shirt, 'https://x.test/old.png', idle).slice(0, 2),
        [
          ...sizes(shirt, 'https://x.test/old.png', recent).slice(2),
          ...sizes(mug, 'https://x.test/old.png', idle),
        ],
      ],
      [
        {
          id: shirt,
          userId: user,
          imageUrl: null,
          imageSourceUrl: null,
        },
        {
          id: mug,
          userId: user,
          imageUrl: null,
          imageSourceUrl: null,
        },
      ],
    );

    expect(await sweeper.sweep({ now })).toBe(1);
    expect(deleted).toEqual(
      sizes(mug, 'https://x.test/old.png', idle).map(({ key }) => key),
    );
  });
});

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32 } from 'node:zlib';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { StorageModule } from '../../src/storage/storage.module.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { productImageKey } from '../../src/storage/object-keys.js';
import { ProductsModule } from '../../src/products/products.module.js';
import { ProductsService } from '../../src/products/products.service.js';
import { OutboundModule } from '../../src/outbound/outbound.module.js';
import { GuardedDownloader } from '../../src/outbound/guarded-download.js';
import { ImageProcessJobHandler } from '../../src/jobs/handlers/image-process.handler.js';
import { JobCancelledError } from '../../src/jobs/job-handler.js';
import { RetryableJobError } from '../../src/common/errors/app-error.js';
import { recordingContext } from '../../src/jobs/job-context.fixture.js';
import { workerEnvSchema } from '../../src/config/env.schema.js';

const png = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: '#c33' },
  })
    .png()
    .toBuffer();

// The handler against what it really reads and writes — Postgres and the dev
// bucket — with images served from this test's own server, which only the
// test's downloader may reach.
describe('the image.process handler', () => {
  let prisma: PrismaService;
  let storage: StorageService;
  let products: ProductsService;
  let handler: ImageProcessJobHandler;
  let server: Server;
  let base: string;
  const users: string[] = [];
  const hits = new Map<string, number>();
  const images = new Map<string, Buffer>();
  // A path answered with something other than an image, before `images`.
  const answers = new Map<
    string,
    { status: number; type?: string; body?: string }
  >();

  // Runs before the response is sent, so a test can change the world while
  // the handler is mid-download.
  const onRequest = new Map<string, () => Promise<void>>();

  const store = async () => {
    const user = await prisma.user.create({
      data: {
        email: `images-${randomUUID()}@example.com`,
        passwordHash: 'not-a-real-hash',
      },
    });

    users.push(user.id);

    return user.id;
  };

  const product = (userId: string, sku: string, imageUrl: string | null) =>
    prisma.product.create({
      data: {
        userId,
        sku,
        name: sku,
        priceCents: 100,
        currency: 'EUR',
        imageUrl,
      },
    });

  const run = (
    userId: string,
    skus: string[],
    options: { stopAfterChecks?: number } = {},
  ) => {
    const recorded = recordingContext({ userId, ...options });

    return { ...recorded, result: handler.run(recorded.context, { skus }) };
  };

  const widthOf = async (key: string) => {
    const opened = await storage.openStream(key);

    if (typeof opened === 'string') {
      return opened;
    }

    const metadata = await sharp(
      Buffer.concat(await opened.body.toArray()),
    ).metadata();

    return `${metadata.format} ${metadata.width}`;
  };

  const sizesOf = (userId: string, productId: string, sourceUrl: string) =>
    Promise.all(
      ['thumb', 'medium', 'large'].map((size) =>
        widthOf(productImageKey(userId, productId, sourceUrl, size)),
      ),
    );

  beforeAll(async () => {
    images.set('/large.png', await png(2000, 1500));
    images.set('/small.png', await png(100, 80));
    images.set('/other.png', await png(800, 800));

    // 91 bytes declaring 8000 × 8000: what sharp must refuse from the header
    // rather than decode. IHDR's checksum is redone so the file stays valid.
    const bomb = await png(10, 10);

    bomb.writeUInt32BE(8000, 16);
    bomb.writeUInt32BE(8000, 20);
    bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
    images.set('/bomb.png', bomb);
    answers.set('/page.png', {
      status: 200,
      type: 'text/html',
      body: '<html>Sign in</html>',
    });
    answers.set('/garbage.png', {
      status: 200,
      type: 'image/png',
      body: 'not an image',
    });
    // Stored landscape, 1000 × 400, with EXIF saying "turn me a quarter":
    // upright it is 400 wide. It also carries a GPS position.
    images.set(
      '/sideways.jpg',
      await sharp({
        create: { width: 1000, height: 400, channels: 3, background: '#3c3' },
      })
        .jpeg()
        .withMetadata({
          orientation: 6,
          exif: { IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 27/1 0/1' } },
        })
        .toBuffer(),
    );

    server = createServer((request, response: ServerResponse) => {
      const path = request.url ?? '';
      const image = images.get(path);

      hits.set(path, (hits.get(path) ?? 0) + 1);

      void (onRequest.get(path)?.() ?? Promise.resolve()).then(() => {
        const answer = answers.get(path);

        if (answer) {
          response.writeHead(
            answer.status,
            answer.type ? { 'content-type': answer.type } : {},
          );
          response.end(answer.body);
        } else if (image) {
          response.writeHead(200, { 'content-type': 'image/png' });
          response.end(image);
        } else {
          response.writeHead(404);
          response.end();
        }
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const port = (server.address() as AddressInfo).port;

    base = `http://127.0.0.1:${port}`;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          envFilePath: ['.env'],
          validationSchema: workerEnvSchema,
        }),
        PrismaModule,
        StorageModule,
        ProductsModule,
        OutboundModule,
      ],
      providers: [ImageProcessJobHandler],
    })
      .overrideProvider(GuardedDownloader)
      .useValue(
        new GuardedDownloader({
          isAllowed: (address) => address === '127.0.0.1',
          ports: ['', String(port)],
        }),
      )
      .compile();

    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    storage = moduleRef.get(StorageService);
    products = moduleRef.get(ProductsService);
    handler = moduleRef.get(ImageProcessJobHandler);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('makes three WebP sizes under the URL it came from and records them', async () => {
    const userId = await store();
    const url = `${base}/large.png`;
    const mug = await product(userId, 'MUG', url);

    expect(await run(userId, ['MUG']).result).toEqual({
      requested: 1,
      processed: 1,
      failed: 0,
      superseded: 0,
      alreadyReady: 0,
      withoutImage: 0,
      notFound: [],
    });
    expect(await sizesOf(userId, mug.id, url)).toEqual([
      'webp 200',
      'webp 600',
      'webp 1200',
    ]);
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: mug.id } }),
    ).toMatchObject({
      imageStatus: 'READY',
      imageSourceUrl: url,
      imageError: null,
    });
  });

  it('turns a photo upright and drops its metadata', async () => {
    const userId = await store();
    const url = `${base}/sideways.jpg`;
    const photo = await product(userId, 'PHOTO', url);

    await run(userId, ['PHOTO']).result;

    // Upright it is 400 wide, so medium and large stop there.
    expect(await sizesOf(userId, photo.id, url)).toEqual([
      'webp 200',
      'webp 400',
      'webp 400',
    ]);

    const opened = await storage.openStream(
      productImageKey(userId, photo.id, url, 'large'),
    );
    const metadata = await sharp(
      Buffer.concat(
        await (opened as Exclude<typeof opened, string>).body.toArray(),
      ),
    ).metadata();

    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it('never enlarges a small image', async () => {
    const userId = await store();
    const url = `${base}/small.png`;
    const cup = await product(userId, 'CUP', url);

    await run(userId, ['CUP']).result;

    expect(await sizesOf(userId, cup.id, url)).toEqual([
      'webp 100',
      'webp 100',
      'webp 100',
    ]);
  });

  it('skips a product whose current URL is already done', async () => {
    const userId = await store();
    const url = `${base}/other.png?skip=${userId}`;

    images.set(`/other.png?skip=${userId}`, await png(300, 300));
    await product(userId, 'BOWL', url);

    await run(userId, ['BOWL']).result;
    const again = await run(userId, ['BOWL']).result;

    expect(again).toMatchObject({ processed: 0, alreadyReady: 1 });
    expect(hits.get(`/other.png?skip=${userId}`)).toBe(1);
  });

  // A worker that dies between the upload and the row: the files are there,
  // the product is not marked, and the retry redoes it onto the same keys.
  it('finishes a product on retry whose files were written before a crash', async () => {
    const userId = await store();
    const path = `/small.png?crash=${userId}`;

    images.set(path, images.get('/small.png')!);
    const cup = await product(userId, 'CUP', `${base}${path}`);
    const filesOf = async () =>
      (
        await new S3Client({ region: process.env.AWS_REGION }).send(
          new ListObjectsV2Command({
            Bucket: process.env.S3_BUCKET,
            Prefix: `products/${userId}/${cup.id}/`,
          }),
        )
      ).KeyCount;

    vi.spyOn(products, 'recordImageReady').mockRejectedValueOnce(
      new Error('worker died'),
    );

    await expect(run(userId, ['CUP']).result).rejects.toThrow('worker died');
    expect(await filesOf()).toBe(3);
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: cup.id } }),
    ).toMatchObject({ imageStatus: null });

    expect(await run(userId, ['CUP']).result).toMatchObject({ processed: 1 });
    expect(await filesOf()).toBe(3);
    expect(hits.get(path)).toBe(2);
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: cup.id } }),
    ).toMatchObject({ imageStatus: 'READY' });
  });

  it('makes a replaced URL its own set of files, leaving the old one', async () => {
    const userId = await store();
    const first = `${base}/large.png`;
    const second = `${base}/other.png`;
    const plate = await product(userId, 'PLATE', first);

    await run(userId, ['PLATE']).result;
    await prisma.product.update({
      where: { id: plate.id },
      data: { imageUrl: second },
    });
    await run(userId, ['PLATE']).result;

    expect(await sizesOf(userId, plate.id, second)).toEqual([
      'webp 200',
      'webp 600',
      'webp 800',
    ]);
    expect(await sizesOf(userId, plate.id, first)).toEqual([
      'webp 200',
      'webp 600',
      'webp 1200',
    ]);
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: plate.id } }),
    ).toMatchObject({ imageStatus: 'READY', imageSourceUrl: second });
  });

  it('does not record an image whose URL was replaced while it was being made', async () => {
    const userId = await store();
    const path = `/large.png?slow=${userId}`;
    const url = `${base}${path}`;
    const jug = await product(userId, 'JUG', url);

    images.set(path, images.get('/large.png')!);
    // An import replaces the URL while the old one is still downloading.
    onRequest.set(path, async () => {
      await prisma.product.update({
        where: { id: jug.id },
        data: { imageUrl: `${base}/other.png` },
      });
    });

    expect(await run(userId, ['JUG']).result).toMatchObject({
      processed: 0,
      superseded: 1,
    });
    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: jug.id } }),
    ).toMatchObject({ imageStatus: null, imageSourceUrl: null });
  });

  it("reports skus it has no product for — another account's among them", async () => {
    const [userId, otherId] = [await store(), await store()];

    await product(userId, 'NO-IMAGE', null);
    await product(otherId, 'THEIRS', `${base}/small.png?theirs=${otherId}`);

    expect(
      await run(userId, ['NO-IMAGE', 'THEIRS', 'MISSING', 'MISSING']).result,
    ).toEqual({
      requested: 3,
      processed: 0,
      failed: 0,
      superseded: 0,
      alreadyReady: 0,
      withoutImage: 1,
      notFound: ['THEIRS', 'MISSING'],
    });
    // Not downloaded, let alone recorded against the other account's product.
    expect(hits.get(`/small.png?theirs=${otherId}`)).toBeUndefined();
  });

  it('stops between products when asked, keeping the ones it finished', async () => {
    const userId = await store();

    for (const sku of ['A', 'B', 'C']) {
      await product(userId, sku, `${base}/small.png?stop=${sku}`);
      images.set(`/small.png?stop=${sku}`, images.get('/small.png')!);
    }

    const stopped = run(userId, ['A', 'B', 'C'], { stopAfterChecks: 1 });

    await expect(stopped.result).rejects.toBeInstanceOf(JobCancelledError);
    expect(
      await prisma.product.count({ where: { userId, imageStatus: 'READY' } }),
    ).toBe(2);
    expect(stopped.reports.at(-1)).toEqual({ processed: 2, total: 3 });
  });

  describe('when an image cannot be made', () => {
    const statuses = async (userId: string) =>
      (
        await prisma.product.findMany({
          where: { userId },
          orderBy: { sku: 'asc' },
        })
      ).map(({ sku, imageStatus }) => [sku, imageStatus]);

    it('marks the product FAILED, says why, and makes the rest', async () => {
      const userId = await store();
      const here = `/small.png?here=${userId}`;

      images.set(here, images.get('/small.png')!);
      await product(userId, 'A-GONE', `${base}/gone.png`);
      await product(userId, 'B-HERE', `${base}${here}`);

      expect(await run(userId, ['A-GONE', 'B-HERE']).result).toMatchObject({
        processed: 1,
        failed: 1,
      });
      expect(
        (await products.findMany(userId, { limit: 20 })).items,
      ).toMatchObject([
        {
          sku: 'A-GONE',
          image: { status: 'FAILED', error: 'The server answered 404' },
        },
        { sku: 'B-HERE', image: { status: 'READY' } },
      ]);
    });

    it.each([
      ['a page', () => `${base}/page.png`, 'text/html is not an accepted type'],
      [
        'bytes that are not an image',
        () => `${base}/garbage.png`,
        'Not a readable image: Input buffer contains unsupported image format',
      ],
      [
        'an image declaring more pixels than allowed',
        () => `${base}/bomb.png`,
        'Not a readable image: Input image exceeds pixel limit',
      ],
      [
        'a private address',
        () => 'http://10.0.0.1/a.png',
        '10.0.0.1 is not a public address',
      ],
    ])('marks %s FAILED', async (_label, url, error) => {
      const userId = await store();
      const bad = await product(userId, 'BAD', url());

      expect(await run(userId, ['BAD']).result).toMatchObject({ failed: 1 });
      expect(
        await prisma.product.findUniqueOrThrow({ where: { id: bad.id } }),
      ).toMatchObject({ imageStatus: 'FAILED', imageError: error });
    });

    // The plan's first reading — a failed image dead-letters the job — would
    // have cost the batch's other products their image for one bad URL.
    it('passes over a host that is down, makes the rest, then fails the attempt', async () => {
      const userId = await store();
      const down = `/small.png?down=${userId}`;
      const up = `/small.png?up=${userId}`;

      images.set(down, images.get('/small.png')!);
      images.set(up, images.get('/small.png')!);
      answers.set(down, { status: 503 });
      await product(userId, 'A-DOWN', `${base}${down}`);
      await product(userId, 'B-UP', `${base}${up}`);

      const first = run(userId, ['A-DOWN', 'B-UP']);

      await expect(first.result).rejects.toThrow(
        '1 of 2 images could not be downloaded this time (The server answered 503)',
      );
      // Not a plain Error: the owner is shown this message, not "Internal error".
      await expect(first.result).rejects.toBeInstanceOf(RetryableJobError);
      expect(first.reports.at(-1)).toEqual({ processed: 2, total: 2 });
      expect(await statuses(userId)).toEqual([
        ['A-DOWN', null],
        ['B-UP', 'READY'],
      ]);

      answers.delete(down);

      expect(await run(userId, ['A-DOWN', 'B-UP']).result).toMatchObject({
        processed: 1,
        alreadyReady: 1,
      });
      expect(hits.get(up)).toBe(1);
    });

    it('tries a FAILED product again, for a file fixed behind the same URL', async () => {
      const userId = await store();
      const path = `/small.png?fixed=${userId}`;
      const shelf = await product(userId, 'SHELF', `${base}${path}`);

      expect(await run(userId, ['SHELF']).result).toMatchObject({ failed: 1 });

      images.set(path, images.get('/small.png')!);

      expect(await run(userId, ['SHELF']).result).toMatchObject({
        processed: 1,
        failed: 0,
      });
      expect(
        await prisma.product.findUniqueOrThrow({ where: { id: shelf.id } }),
      ).toMatchObject({ imageStatus: 'READY', imageError: null });
    });
  });

  describe("a product's image as the list shows it", () => {
    it('is pending until made, then three links that download WebP', async () => {
      const userId = await store();
      const url = `${base}/small.png?view=${userId}`;

      images.set(`/small.png?view=${userId}`, images.get('/small.png')!);
      await product(userId, 'VASE', url);
      await product(userId, 'BARE', null);

      const before = await products.findMany(userId, { limit: 20 });

      expect(before.items.map(({ sku, image }) => [sku, image])).toEqual([
        ['BARE', null],
        ['VASE', { status: 'PENDING' }],
      ]);

      await run(userId, ['VASE']).result;

      const [, vase] = (await products.findMany(userId, { limit: 20 })).items;

      expect(vase!.image).toMatchObject({ status: 'READY' });
      expect(vase).not.toHaveProperty('imageStatus');
      expect(vase).not.toHaveProperty('imageSourceUrl');

      const thumb = await fetch((vase!.image as { thumb: string }).thumb);

      expect(thumb.status).toBe(200);
      expect(thumb.headers.get('content-type')).toBe('image/webp');
      expect(thumb.headers.get('content-disposition')).toBeNull();
    });
  });
});

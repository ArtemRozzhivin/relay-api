import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

const FIXTURES = ['photo.png', 'page.html', 'broken.png'];

// A17 — a URL that can never give an image costs its product the image, not
// the job its attempts. Nothing is replaced: the worker's own guard either
// lets a URL through or refuses it, and the files sit in the bucket behind
// signed links, so a public host answers for real.
describe('A17 · a permanent image failure costs one attempt, not the budget', () => {
  const s3 = new S3Client({ region: process.env.AWS_REGION });
  const bucket = process.env.S3_BUCKET!;
  const folder = `fixtures/a17/${randomUUID()}`;
  let harness: RelayHarness;
  let account: Account;

  const put = (name: string, body: Buffer | string, contentType: string) =>
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${folder}/${name}`,
        Body: body,
        ContentType: contentType,
      }),
    );

  const signed = (name: string) =>
    getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: `${folder}/${name}` }),
      { expiresIn: 600 },
    );

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a17');

    await Promise.all([
      put(
        'photo.png',
        await sharp({
          create: { width: 300, height: 200, channels: 3, background: '#36c' },
        })
          .png()
          .toBuffer(),
        'image/png',
      ),
      put('page.html', '<html>Sign in</html>', 'text/html'),
      put('broken.png', 'not an image', 'image/png'),
    ]);
  });

  afterAll(async () => {
    await Promise.all(
      FIXTURES.map((name) =>
        s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: `${folder}/${name}` }),
        ),
      ),
    );
    await harness.stop();
  });

  it('marks each unusable image FAILED and succeeds on the first attempt', async () => {
    const urls: Record<string, string> = {
      'A-PHOTO': await signed('photo.png'),
      'B-MISSING': await signed('missing.png'),
      'C-PAGE': await signed('page.html'),
      'D-BROKEN': await signed('broken.png'),
      'E-METADATA': 'http://169.254.169.254/latest/meta-data/',
    };

    await harness.prisma.product.createMany({
      data: Object.entries(urls).map(([sku, imageUrl]) => ({
        userId: account.id,
        sku,
        name: sku,
        priceCents: 100,
        currency: 'EUR',
        imageUrl,
      })),
    });

    harness.startWorker();

    const { body } = await harness.submit(account, {
      type: 'image.process',
      payload: { skus: Object.keys(urls) },
    });
    const job = await harness.waitForJobStatus(body.data.id, [
      'SUCCEEDED',
      'DEAD_LETTERED',
    ]);

    expect(job).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
      result: { processed: 1, failed: 4 },
    });

    const products = await harness.products(account.id);

    expect(
      products
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .map(({ sku, imageStatus, imageError }) => [
          sku,
          imageStatus,
          imageError,
        ]),
    ).toEqual([
      ['A-PHOTO', 'READY', null],
      ['B-MISSING', 'FAILED', 'The server answered 404'],
      ['C-PAGE', 'FAILED', 'text/html is not an accepted type'],
      [
        'D-BROKEN',
        'FAILED',
        'Not a readable image: Input buffer contains unsupported image format',
      ],
      ['E-METADATA', 'FAILED', '169.254.169.254 is not a public address'],
    ]);
  });
});

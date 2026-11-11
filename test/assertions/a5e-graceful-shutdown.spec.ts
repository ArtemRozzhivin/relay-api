import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';
import { heaviestImage } from '../support/heaviest-image.js';
import { deleteProductImages } from '../support/product-images.js';

const PRODUCTS = 40;

// A5e — a deploy hands running work back instead of breaking it. SIGTERM lands
// mid-batch: the product being made must still reach S3 and its row — the
// clients it uses are closed only after the worker has drained — and the job
// must go back to the queue at its next safe point without spending an
// attempt, for the next worker to finish.
describe('A5e · SIGTERM hands a running job back without spending an attempt', () => {
  const s3 = new S3Client({ region: process.env.AWS_REGION });
  const bucket = process.env.S3_BUCKET!;
  const key = `fixtures/a5e/${randomUUID()}/image.png`;
  let harness: RelayHarness;
  let account: Account;

  const ready = () =>
    harness.prisma.product.count({
      where: { userId: account.id, imageStatus: 'READY' },
    });

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a5e');

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: await heaviestImage(),
        ContentType: 'image/png',
      }),
    );
  });

  afterAll(async () => {
    // After the processes stop, so no worker writes an image behind it.
    await harness.stop();
    await Promise.all([
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
      deleteProductImages(s3, bucket, account.id),
    ]);
  });

  it('finishes the product in hand, re-queues the job, and the next worker completes it', async () => {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 900 },
    );
    const skus = Array.from({ length: PRODUCTS }, (_, i) => `P-${i}`);

    await harness.prisma.product.createMany({
      data: skus.map((sku) => ({
        userId: account.id,
        sku,
        name: sku,
        priceCents: 100,
        currency: 'EUR',
        imageUrl: url,
      })),
    });

    const { body } = await harness.submit(account, {
      type: 'image.process',
      payload: { skus },
    });
    const jobId = body.data.id as string;
    const first = harness.startWorker('worker-1');

    await harness.waitUntil(
      async () => ((await ready()) >= 3 ? true : undefined),
      {
        timeoutMs: 120_000,
        label: 'three images made',
      },
    );

    const readyAtSigterm = await ready();
    const signalled = Date.now();

    first.signal('SIGTERM');

    await harness.waitUntil(async () => (first.exited ? true : undefined), {
      timeoutMs: 30_000,
      label: 'the worker to exit after SIGTERM',
    });

    const drainSeconds = (Date.now() - signalled) / 1000;
    const handedBack = await harness.job(jobId);
    const readyAtExit = await ready();

    process.stdout.write(
      `A5e ${JSON.stringify({ drainSeconds, readyAtSigterm, readyAtExit })}\n`,
    );

    expect(handedBack).toMatchObject({ status: 'QUEUED', attempts: 0 });
    // The product in hand when the signal came was finished, not dropped.
    expect(readyAtExit).toBeGreaterThan(readyAtSigterm);
    expect(readyAtExit).toBeLessThan(PRODUCTS);
    expect(first.log).toMatch(/handed back at a safe point/);
    expect(first.log).not.toMatch(/will retry|Connection is closed/);

    harness.startWorker('worker-2');

    const done = await harness.waitForJobStatus(
      jobId,
      ['SUCCEEDED', 'DEAD_LETTERED'],
      120_000,
    );

    expect(done).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(done.result).toMatchObject({
      processed: PRODUCTS - readyAtExit,
      alreadyReady: readyAtExit,
    });
    expect(await ready()).toBe(PRODUCTS);
  });
});

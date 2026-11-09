import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
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

// One batch per job the worker runs at once: its default concurrency.
const BATCHES = 5;
const PER_BATCH = 20;

// Named before the first run. BullMQ's lock lasts 30 s and is renewed every
// 15 s, so a renewal can be 15 s late before the lock lapses and the job is
// redelivered; a second is a fifteenfold margin.
const LOOP_MAX_MS = 1000;
const REDIS_MAX_MS = 1000;

interface Probe {
  samples: number;
  loopMaxMs: number;
  loopP99Ms: number;
  redisMaxMs: number;
  redisP99Ms: number;
  poolMaxMs: number;
  poolP99Ms: number;
}

// A18 — image batches do not stall the worker that runs them (D10). Measured
// from inside the real worker, by a probe loaded beside it, while it makes
// the heaviest image the limits allow as fast as its concurrency lets it.
describe('A18 · image batches at the chosen concurrency do not self-stall', () => {
  const s3 = new S3Client({ region: process.env.AWS_REGION });
  const bucket = process.env.S3_BUCKET!;
  const key = `fixtures/a18/${randomUUID()}/heavy.png`;
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a18');

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
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    await harness.stop();
  });

  it('renews every lock in time and redelivers nothing', async () => {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 900 },
    );
    const batches = Array.from({ length: BATCHES }, (_, batch) =>
      Array.from({ length: PER_BATCH }, (_, item) => `B${batch}-${item}`),
    );

    await harness.prisma.product.createMany({
      data: batches.flat().map((sku) => ({
        userId: account.id,
        sku,
        name: sku,
        priceCents: 100,
        currency: 'EUR',
        imageUrl: url,
      })),
    });

    const jobIds: string[] = [];

    for (const skus of batches) {
      const { body } = await harness.submit(account, {
        type: 'image.process',
        payload: { skus },
      });

      jobIds.push(body.data.id);
    }

    // Started after the submits, so every batch begins at once.
    const started = Date.now();
    const worker = harness.startWorker('worker', {
      WORKER_CONCURRENCY: String(BATCHES),
      NODE_OPTIONS: `--import=${resolve('test/support/worker-probe.ts')}`,
    });

    const jobs = await Promise.all(
      jobIds.map((jobId) =>
        harness.waitForJobStatus(
          jobId,
          ['SUCCEEDED', 'DEAD_LETTERED'],
          200_000,
        ),
      ),
    );
    const seconds = (Date.now() - started) / 1000;

    await harness.waitForLog(worker, /relay-probe/);

    const probe = JSON.parse(
      worker.log
        .match(/relay-probe (.+)/g)!
        .at(-1)!
        .slice('relay-probe '.length),
    ) as Probe;

    // To stdout, not the console: the numbers are what A18 is for, and the
    // default reporter prints a passing test's console only when verbose.
    process.stdout.write(
      `A18 ${JSON.stringify({
        seconds,
        images: BATCHES * PER_BATCH,
        ...probe,
        retried: worker.log.match(/failed, will retry: [^"]*/g) ?? [],
      })}\n`,
    );

    // Succeeded, not "at attempt 1": the downloads cross the real internet,
    // and a transient failure there is retried by design (§6.3c). A lock that
    // lapsed is what this is about, and the worker logs each one.
    expect(jobs.map(({ status }) => status)).toEqual(
      jobIds.map(() => 'SUCCEEDED'),
    );
    expect(
      await harness.prisma.product.count({
        where: { userId: account.id, imageStatus: 'READY' },
      }),
    ).toBe(BATCHES * PER_BATCH);
    expect(worker.count(/stalled; the queue will/)).toBe(0);
    expect(probe.loopMaxMs).toBeLessThan(LOOP_MAX_MS);
    expect(probe.redisMaxMs).toBeLessThan(REDIS_MAX_MS);
  });
});

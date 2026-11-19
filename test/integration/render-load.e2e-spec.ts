import 'dotenv/config';
import { lookup } from 'node:dns/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderSizes } from '../../src/images/image-variants.js';
import { heaviestImage } from '../support/heaviest-image.js';

// As many renders at once as the worker runs image jobs: its concurrency.
const RENDERERS = 5;
const LOAD_MS = 8000;

const median = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;
const p99 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.99)] ?? 0;

// D10, without the network in the way: the worst image, rendered back to back
// by as many jobs as the worker runs, fills libuv's threadpool. What waits for
// it is a DNS lookup — the guard's, before every download. What does not is a
// command on an open socket, which is all a BullMQ lock renewal is, and the
// event loop the renewal timer runs on.
describe('a full threadpool (D10)', () => {
  let redis: Redis;
  let image: Buffer;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!);
    image = await heaviestImage();
  });

  afterAll(() => redis.disconnect());

  it('delays a DNS lookup, never a lock renewal', async () => {
    const loop = monitorEventLoopDelay({ resolution: 10 });
    const redisMs: number[] = [];
    const lookupMs: number[] = [];
    const until = Date.now() + LOAD_MS;

    const timed = async (into: number[], work: () => Promise<unknown>) => {
      const start = performance.now();

      await work();
      into.push(performance.now() - start);
    };

    loop.enable();

    const probe = setInterval(() => {
      void timed(redisMs, () => redis.ping());
      void timed(lookupMs, () => lookup('localhost'));
    }, 100);

    await Promise.all(
      Array.from({ length: RENDERERS }, async () => {
        while (Date.now() < until) {
          await renderSizes(image);
        }
      }),
    );

    clearInterval(probe);
    loop.disable();

    const measured = {
      loopMaxMs: loop.max / 1e6,
      redisMaxMs: Math.max(...redisMs),
      redisP99Ms: p99(redisMs),
      lookupMedianMs: median(lookupMs),
      lookupMaxMs: Math.max(...lookupMs),
    };

    process.stdout.write(`D10 ${JSON.stringify(measured)}\n`);

    // The load did fill the pool — an idle lookup takes about a millisecond —
    // or nothing below would mean anything.
    expect(measured.lookupMedianMs).toBeGreaterThan(20);
    // While a lookup waits for a thread, a Redis command does not.
    expect(measured.redisP99Ms).toBeLessThan(measured.lookupMedianMs);
    // A lock renewal can be 15 s late before the lock lapses.
    expect(measured.redisMaxMs).toBeLessThan(1000);
    expect(measured.loopMaxMs).toBeLessThan(1000);
  });
});

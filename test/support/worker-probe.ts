import { lookup } from 'node:dns/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';
import { Redis } from 'ioredis';

// Loaded into a real worker with `--import` by A18, so nothing in src/ carries
// measuring code. Every 250 ms it times, from inside the process, the three
// waits a busy image batch could cause; every second it prints the worst seen.

const timed = async (into: number[], work: () => Promise<unknown>) => {
  const start = performance.now();

  await work();
  into.push(performance.now() - start);
};

const p99 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.99)] ?? 0;

const start = () => {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const redis = new Redis(process.env.REDIS_URL!);
  const redisMs: number[] = [];
  const poolMs: number[] = [];

  loop.enable();

  setInterval(() => {
    // What a lock renewal is: one command on an open socket.
    void timed(redisMs, () => redis.ping());
    // A name the OS answers locally, so nearly all of this is the wait for a
    // free libuv thread — the wait the guard's own lookup has before a
    // download.
    void timed(poolMs, () => lookup('localhost'));
  }, 250);

  setInterval(() => {
    process.stdout.write(
      `relay-probe ${JSON.stringify({
        samples: redisMs.length,
        loopMaxMs: loop.max / 1e6,
        loopP99Ms: loop.percentile(99) / 1e6,
        redisMaxMs: Math.max(0, ...redisMs),
        redisP99Ms: p99(redisMs),
        poolMaxMs: Math.max(0, ...poolMs),
        poolP99Ms: p99(poolMs),
      })}\n`,
    );
  }, 1000);
};

// `--import` runs in every thread the process starts, the logger's included,
// and that thread's loop never sees a job: measuring it would report a calm
// thread while the one renewing the locks is frozen.
if (isMainThread) {
  start();
}

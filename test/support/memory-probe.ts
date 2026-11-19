import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { isMainThread } from 'node:worker_threads';

// Loaded into a real worker with `--import` by A13, so nothing in src/ carries
// measuring code. Every 100 ms it forces a full collection and prints what is
// still alive — the heap and the buffers it holds — so a reading is what the
// process retains, not how much garbage the collector has let pile up.

const start = () => {
  // The flag only gives a context created after it a `gc()`, hence the new
  // one: Node refuses --expose-gc in NODE_OPTIONS.
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;

  setInterval(() => {
    gc();

    const { heapUsed, arrayBuffers } = process.memoryUsage();

    process.stdout.write(
      `relay-memory ${JSON.stringify({ liveMb: (heapUsed + arrayBuffers) / 2 ** 20 })}\n`,
    );
  }, 100);
};

// `--import` runs in every thread the process starts, the logger's included;
// that thread never touches an import.
if (isMainThread) {
  start();
}

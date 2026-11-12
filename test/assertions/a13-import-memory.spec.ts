import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type ProcessHandle,
} from '../harness/relay-harness.js';

const SMALL = 2_000;
const LARGE = 20_000;

// About 2 KB a row: 20 000 short rows are a file of under a megabyte, which no
// reading could tell from noise. These make files of about 4 MB and 39 MB.
const DESCRIPTION = 'A product description long enough to weigh. '.repeat(42);

// Half the files' difference in size, named before this instrument's first
// run. A worker holding even half of the larger file fails; a streaming one
// holds a 500-row batch, about 1 MB, whatever the file's size.
const BAND_MB = 18;

const csvOf = (prefix: string, rows: number) =>
  [
    'sku,name,description,price,currency',
    ...Array.from(
      { length: rows },
      (_, index) =>
        `${prefix}-${index},Product ${index},${DESCRIPTION}${index},${index}.99,EUR`,
    ),
  ].join('\n');

const readingsIn = (log: string) =>
  [...log.matchAll(/^relay-memory (.+)$/gm)].map(
    ([, json]) => (JSON.parse(json) as { liveMb: number }).liveMb,
  );

// A13 — an import's memory does not grow with its file. Two imports of the
// same rows in different numbers, in one worker: the fixed cost of a running
// import is in both peaks and cancels out, and what is left is what the extra
// 18 000 rows cost. Measured as what is still alive after a full collection,
// not as RSS: RSS also counts garbage the collector has not got to yet, and
// two runs of the same streaming code read +45 MB and +82 MB that way.
describe('A13 · a large import does not grow with the file', () => {
  let harness: RelayHarness;
  let account: Account;
  let worker: ProcessHandle;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    worker = harness.startWorker('worker', {
      NODE_OPTIONS: `--import=${resolve('test/support/memory-probe.ts')}`,
    });
    account = await harness.signUp('a13');
  });

  afterAll(async () => {
    // 42 000 products of 2 KB each would otherwise stay in the database.
    await harness.prisma.user.deleteMany({ where: { id: account.id } });
    await harness.stop();
  });

  const importPeak = async (prefix: string, rows: number) => {
    const key = await harness.upload(account, csvOf(prefix, rows));
    const from = worker.log.length;

    const { body } = await harness.submit(account, {
      type: 'import.csv',
      payload: { key },
    });
    const done = await harness.waitForJobStatus(
      body.data.id,
      ['SUCCEEDED', 'DEAD_LETTERED'],
      180_000,
    );

    // A reading of a job that did not do the work proves nothing about it.
    expect(done.status).toBe('SUCCEEDED');
    expect(done.result).toMatchObject({ imported: rows, invalid: 0 });

    const readings = readingsIn(worker.log.slice(from));

    expect(readings.length).toBeGreaterThanOrEqual(5);

    return Math.max(...readings);
  };

  it(`holds less than ${BAND_MB} MB more for ${LARGE} rows than for ${SMALL}`, async () => {
    // Full size and first, because a worker's live memory climbs over its
    // first several thousand rows — compiled code, connection buffers — and
    // then levels off; measured before that, the small import would read low
    // and the difference would be warm-up, not the file.
    await importPeak('WARM', LARGE);

    const small = await importPeak('SMALL', SMALL);
    const large = await importPeak('LARGE', LARGE);

    console.info(
      `A13: live memory peaked at ${small.toFixed(1)} MB for ${SMALL} rows, ${large.toFixed(1)} MB for ${LARGE} (+${(large - small).toFixed(1)} MB; band ${BAND_MB} MB)`,
    );

    expect(large - small).toBeLessThan(BAND_MB);
  });
});

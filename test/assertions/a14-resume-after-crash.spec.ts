import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

const ROWS = 3000;

// Valid rows are numbered from 0 and the bad row comes first, so batch 3 —
// the one the worker dies in — holds SKU-1000 to SKU-1499, and the two batches
// before it reach record 1 001.
const HELD_SKU = 'SKU-1200';
const COMMITTED_RECORDS = 1001;

// A14 — a SIGKILL mid-import costs only the batch it interrupted. The kill is
// made deterministic by a row lock: the test holds one product of batch 3, so
// the worker provably has two batches committed and the third stuck when it
// dies — never before the first commit, never after the last.
describe('A14 · an import killed mid-file resumes from its checkpoint', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    account = await harness.signUp('a14');
  });

  afterAll(() => harness.stop());

  it('finishes with every valid row once and rewrites none it had committed', async () => {
    const csv = [
      'sku,name,price,currency',
      'BAD-1,Broken,abc,EUR',
      ...Array.from(
        { length: ROWS },
        (_, index) => `SKU-${index},Product ${index},${index}.99,EUR`,
      ),
    ].join('\n');

    const key = await harness.upload(account, csv);

    // The row the lock is taken on has to exist first; the import overwrites
    // it with the file's values, so the final catalog is unaffected.
    await harness.prisma.product.create({
      data: {
        userId: account.id,
        sku: HELD_SKU,
        name: 'held',
        priceCents: 1,
        currency: 'EUR',
      },
    });

    let release = () => {};
    let locked = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const holding = harness.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT 1 FROM "Product"
          WHERE "userId" = ${account.id}::uuid AND "sku" = ${HELD_SKU}
          FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 120_000 },
    );

    await isLocked;

    const { body } = await harness.submit(account, {
      type: 'import.csv',
      payload: { key },
    });
    const jobId = body.data.id as string;

    const first = harness.startWorker('worker-1');

    await harness.waitUntil(
      async () => {
        const job = await harness.job(jobId);
        const checkpoint = job?.checkpoint as { records?: number } | null;

        return checkpoint?.records === COMMITTED_RECORDS ? true : undefined;
      },
      { timeoutMs: 60_000, label: 'two committed batches' },
    );

    // Not just "the checkpoint got this far": the third batch is inside
    // Postgres, waiting on the lock, so the kill lands in the middle of it.
    await harness.waitUntil(
      async () => {
        const [{ waiting }] = await harness.prisma.$queryRaw<
          { waiting: number }[]
        >`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO "Product"%'`;

        return waiting > 0 ? true : undefined;
      },
      { timeoutMs: 30_000, label: 'the third batch blocked on the lock' },
    );

    first.sigkill();

    const atKill = await harness.job(jobId);
    const committed = (await harness.products(account.id)).filter(
      (product) => product.sku !== HELD_SKU,
    );

    // The evidence the kill was mid-file, on the first attempt — without it
    // the rest of the test could pass on a run that was never interrupted.
    expect(atKill).toMatchObject({ status: 'RUNNING', attempts: 1 });
    expect(committed).toHaveLength(1000);

    release();
    await holding;

    await harness.expireQueueLock(jobId);
    const second = harness.startWorker('worker-2');

    const done = await harness.waitForJobStatus(
      jobId,
      ['SUCCEEDED', 'DEAD_LETTERED', 'CANCELLED'],
      180_000,
    );

    expect(done).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
      result: { rows: ROWS + 1, imported: ROWS, invalid: 1 },
    });

    const catalog = await harness.products(account.id);

    expect(catalog).toHaveLength(ROWS);
    expect(new Set(catalog.map((product) => product.sku)).size).toBe(ROWS);

    // Resumed, not restarted: every product the first attempt committed is
    // exactly as it left it.
    const rewritten = committed.filter(
      (product) =>
        catalog.find(({ sku }) => sku === product.sku)?.updatedAt.getTime() !==
        product.updatedAt.getTime(),
    );

    expect(rewritten).toEqual([]);
    expect(
      second.count(new RegExp(`resuming after record ${COMMITTED_RECORDS}`)),
    ).toBe(1);
  });
});

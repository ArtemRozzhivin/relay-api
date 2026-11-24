import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type ProcessHandle,
} from '../harness/relay-harness.js';
import { pipelineKey } from '../../src/jobs/engine/pipeline-keys.js';

interface Line {
  msg: string;
  jobId?: string;
}

const PRODUCTS = 45;

// A23 — writing a pipeline's batches again writes none of them twice (§6.3e).
// The worker fails the import's first attempt right after its fan-out
// commits, as a worker that died there would leave it: the batches written,
// the import's success not. The retry fans out again, and the unique key
// refuses every batch it already wrote.
describe('A23 · a fan-out that runs again writes no batch twice', () => {
  let harness: RelayHarness;
  let account: Account;
  let worker: ProcessHandle;

  // What the job's context said about each of its fan-outs, attempt by attempt.
  const fanOutsOf = (jobId: string) =>
    worker.log
      .split('\n')
      .flatMap((text) => {
        try {
          return [JSON.parse(text) as Line];
        } catch {
          return [];
        }
      })
      .filter(
        (line) => line.jobId === jobId && /fanned out \d+ new/.test(line.msg),
      )
      .map((line) => line.msg.replace(/^Job \S+ /, ''));

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    // JSON lines, each under the id of the job that wrote it.
    worker = harness.startWorker('worker', {
      NODE_ENV: 'production',
      RELAY_FAULT_AFTER_FAN_OUT: 'true',
    });
    account = await harness.signUp('a23');
  });

  afterAll(() => harness.stop());

  it('writes one job per stage and batch, and the retry writes none', async () => {
    // Every product needs both stages. The images are on an address the
    // download guard refuses at once, so their batches end without a network.
    const key = await harness.upload(
      account,
      [
        'sku,name,price,currency,imageUrl',
        ...Array.from(
          { length: PRODUCTS },
          (_, n) => `SKU-${n},Product ${n},1.00,EUR,http://127.0.0.1/${n}.jpg`,
        ),
      ].join('\n'),
    );

    const { status, body } = await harness.startPipeline(account, key);

    expect(status).toBe(202);

    const pipelineId = body.data.id as string;
    const importJob = await harness.waitForJobStatus(
      body.data.importJobId as string,
      ['SUCCEEDED', 'DEAD_LETTERED'],
    );

    expect(importJob).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
      result: { imported: PRODUCTS },
    });
    // The line can reach the pipe after the row it describes has committed.
    await harness.waitUntil(
      async () => (fanOutsOf(importJob.id).length >= 2 ? true : undefined),
      { timeoutMs: 10_000, label: 'both fan-outs to be logged' },
    );

    // The retry plans from the products as they are by then, and the first
    // attempt's batches may have enriched some already: however many it
    // planned, it wrote none.
    expect(fanOutsOf(importJob.id)).toEqual([
      'attempt 1 fanned out 4 new of 4 batch(es)',
      expect.stringMatching(
        /^attempt 2 fanned out 0 new of [1-4] batch\(es\)$/,
      ),
    ]);

    const batches = await harness.prisma.job.findMany({
      where: { pipelineId, type: { in: ['ai.enrich', 'image.process'] } },
      include: { outbox: true },
    });

    expect(batches.map(({ idempotencyKey }) => idempotencyKey).sort()).toEqual(
      [
        pipelineKey(pipelineId, 'enrich', 0),
        pipelineKey(pipelineId, 'enrich', 1),
        pipelineKey(pipelineId, 'enrich', 2),
        pipelineKey(pipelineId, 'images', 0),
      ].sort(),
    );
    expect(batches.map(({ outbox }) => outbox.length)).toEqual([1, 1, 1, 1]);

    // Raised once for the batches, not twice: a second raise would hold the
    // counter above zero for ever, and the pipeline would never finish.
    expect(await harness.waitForPipeline(pipelineId)).toMatchObject({
      status: 'COMPLETED',
      pendingChildren: 0,
      failedChildren: 0,
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type ProcessHandle,
} from '../harness/relay-harness.js';

// A24 — a pipeline's parent cannot be lost (D24). Its finalize job and outbox
// row are written by the commit that finishes the pipeline's last job, so
// nothing after that commit is needed for the parent to run. The test leaves
// nothing there to help: the API, whose relay is the only thing that enqueues
// a row a worker wrote, is stopped while the last batch is still waiting on
// the model, and the worker is killed as soon as that batch has finished.
describe("A24 · a pipeline's parent survives a crash after its last job", () => {
  let harness: RelayHarness;
  let account: Account;
  let api: ProcessHandle;
  let worker: ProcessHandle;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    api = await harness.startApi();
    worker = harness.startWorker('worker-1');
    account = await harness.signUp('a24');
  });

  afterAll(() => harness.stop());

  it('is enqueued by the relay after both processes went down, and finishes the pipeline once', async () => {
    // One batch, whose model takes 3 s to answer.
    const key = await harness.upload(
      account,
      [
        'sku,name,price,currency',
        'SKU-0,Desk [llm:slow],1.00,EUR',
        'SKU-1,Chair,1.00,EUR',
      ].join('\n'),
    );

    const { status, body } = await harness.startPipeline(account, key);

    expect(status).toBe(202);

    const pipelineId = body.data.id as string;

    const batch = await harness.waitUntil(
      async () =>
        (await harness.prisma.job.findFirst({
          where: { pipelineId, type: 'ai.enrich', status: 'RUNNING' },
        })) ?? undefined,
      { label: 'the batch to start asking the model' },
    );

    await api.terminate();

    expect(
      await harness.waitForJobStatus(batch.id, ['SUCCEEDED', 'DEAD_LETTERED']),
    ).toMatchObject({ status: 'SUCCEEDED' });

    await worker.terminate();

    // Written by the batch's own commit; with no API, nothing has sent it.
    const [waiting, ...others] = await harness.prisma.job.findMany({
      where: { pipelineId, type: 'pipeline.finalize' },
      include: { outbox: true },
    });

    expect(others).toEqual([]);
    expect(waiting).toMatchObject({ status: 'QUEUED' });
    expect(waiting!.outbox).toMatchObject([{ publishedAt: null }]);

    await harness.startApi();
    harness.startWorker('worker-2');

    expect(await harness.waitForPipeline(pipelineId)).toMatchObject({
      status: 'COMPLETED',
      pendingChildren: 0,
      finishedAt: expect.any(Date),
    });

    const finalize = await harness.prisma.job.findMany({
      where: { pipelineId, type: 'pipeline.finalize' },
      include: { outbox: true },
    });

    expect(finalize).toHaveLength(1);
    expect(finalize[0]).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    // Sent by the relay: the direct path leaves a row's attempts at 0.
    expect(finalize[0]!.outbox).toMatchObject([
      { publishedAt: expect.any(Date), attempts: 1 },
    ]);
  });
});

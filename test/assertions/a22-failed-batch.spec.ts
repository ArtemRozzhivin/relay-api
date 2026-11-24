import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';
import { pipelineKey } from '../../src/jobs/engine/pipeline-keys.js';

const PRODUCTS = 45;

// In the second of three enrichment batches: SKU-20 to SKU-39.
const DOWN = 25;

// A22 — a batch that fails does not fail its pipeline (D22, §6.3e). The model
// is down for one batch through every attempt, so that batch is dead-lettered
// while the others succeed; the pipeline ends COMPLETED_WITH_ERRORS, a status
// only a pipeline has. The batch can be re-driven once the model is back, and
// that does not reopen the pipeline.
describe('A22 · a failed batch leaves its pipeline completed with errors', () => {
  let harness: RelayHarness;
  let account: Account;

  const enrichmentOf = async () =>
    Object.fromEntries(
      (
        await harness.prisma.product.findMany({
          where: { userId: account.id },
        })
      ).map(({ sku, enrichmentStatus }) => [sku, enrichmentStatus]),
    );

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    account = await harness.signUp('a22');
  });

  afterAll(() => harness.stop());

  it('completes the others, ends COMPLETED_WITH_ERRORS, and the batch is re-drivable', async () => {
    const key = await harness.upload(
      account,
      [
        'sku,name,price,currency',
        ...Array.from({ length: PRODUCTS }, (_, n) =>
          n === DOWN
            ? `SKU-${n},Product ${n} [llm:down],1.00,EUR`
            : `SKU-${n},Product ${n},1.00,EUR`,
        ),
      ].join('\n'),
    );

    const { status, body } = await harness.startPipeline(account, key);

    expect(status).toBe(202);

    const pipelineId = body.data.id as string;

    // Five attempts, retried a second, two, four and eight apart at most.
    const finished = await harness.waitForPipeline(pipelineId, 90_000);

    expect(finished).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      pendingChildren: 0,
      failedChildren: 1,
      summary: {
        import: { rows: PRODUCTS, imported: PRODUCTS, invalid: 0 },
        enrich: { batches: 3, failedBatches: 1, enriched: 25, failed: 0 },
      },
    });

    const failed = await harness.prisma.job.findUniqueOrThrow({
      where: {
        userId_idempotencyKey: {
          userId: account.id,
          idempotencyKey: pipelineKey(pipelineId, 'enrich', 1),
        },
      },
    });

    expect(failed).toMatchObject({
      status: 'DEAD_LETTERED',
      attempts: 5,
      error: { code: 'ATTEMPTS_EXHAUSTED' },
    });

    // Every job of the pipeline in a status a job can have; the run's errors
    // are the pipeline's status, not any job's.
    const { body: viewed } = await harness.fetchPipeline(account, pipelineId);

    expect(viewed.data).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      jobs: {
        'import.csv': { SUCCEEDED: 1 },
        'ai.enrich': { SUCCEEDED: 2, DEAD_LETTERED: 1 },
        'pipeline.finalize': { SUCCEEDED: 1 },
      },
    });

    const before = await enrichmentOf();

    for (let n = 0; n < PRODUCTS; n += 1) {
      expect(before[`SKU-${n}`]).toBe(n >= 20 && n < 40 ? null : 'READY');
    }

    // The model is back for it.
    await harness.prisma.product.updateMany({
      where: { userId: account.id, sku: `SKU-${DOWN}` },
      data: { name: `Product ${DOWN}` },
    });

    const redriven = await harness.redrive(account, failed.id);

    expect(redriven.status).toBe(202);
    expect(
      await harness.waitForJobStatus(failed.id, ['SUCCEEDED', 'DEAD_LETTERED']),
    ).toMatchObject({ status: 'SUCCEEDED' });
    expect(Object.values(await enrichmentOf())).toEqual(
      Array(PRODUCTS).fill('READY'),
    );

    // The run is over: the re-drive fixed its products, not its record.
    expect(
      await harness.prisma.pipeline.findUniqueOrThrow({
        where: { id: pipelineId },
      }),
    ).toEqual(finished);
    expect(
      await harness.prisma.job.count({
        where: { pipelineId, type: 'pipeline.finalize' },
      }),
    ).toBe(1);
  });
});

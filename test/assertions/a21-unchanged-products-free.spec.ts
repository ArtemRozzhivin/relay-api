import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type ProcessHandle,
} from '../harness/relay-harness.js';

interface Line {
  msg: string;
  jobId?: string;
}

const SKUS = ['SKU-0', 'SKU-1', 'SKU-2'];

// A21 — enriching products again costs nothing for those whose text has not
// changed since their answer (§6.3d). The worker's log has a line for every
// request to the model, written by the one method that makes them, so the
// requests a job made are the lines under its id.
describe('A21 · re-enriching unchanged products asks the model nothing', () => {
  let harness: RelayHarness;
  let account: Account;
  let worker: ProcessHandle;

  const enrich = async () => {
    const { status, body } = await harness.submit(account, {
      type: 'ai.enrich',
      payload: { skus: SKUS },
    });

    expect(status).toBe(202);

    return harness.waitForJobStatus(body.data.id as string, [
      'SUCCEEDED',
      'DEAD_LETTERED',
    ]);
  };

  // Each request the job made to the model, as the line that announced it.
  const requestsOf = (jobId: string) =>
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
        (line) => line.jobId === jobId && /asking the model/.test(line.msg),
      )
      // Past the prefix the context gives every line of a job.
      .map((line) => line.msg.replace(/^Job \S+ attempt \d+ /, ''));

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    // JSON lines, each under the id of the job that wrote it.
    worker = harness.startWorker('worker', { NODE_ENV: 'production' });
    account = await harness.signUp('a21');

    await harness.prisma.product.createMany({
      data: SKUS.map((sku, n) => ({
        userId: account.id,
        sku,
        name: `Product ${n}`,
        priceCents: 100,
        currency: 'EUR',
      })),
    });
  });

  afterAll(() => harness.stop());

  it('asks about every product once, then about none, then about the one that changed', async () => {
    const first = await enrich();

    expect(first).toMatchObject({
      status: 'SUCCEEDED',
      result: { enriched: 3, alreadyReady: 0 },
    });
    expect(requestsOf(first.id)).toEqual([
      'asking the model about 3 product(s)',
    ]);

    const again = await enrich();

    expect(again).toMatchObject({
      status: 'SUCCEEDED',
      result: { enriched: 0, alreadyReady: 3 },
    });
    expect(requestsOf(again.id)).toEqual([]);

    // What an import does to a product whose row in the file changed.
    await harness.prisma.product.updateMany({
      where: { userId: account.id, sku: 'SKU-1' },
      data: { description: 'Now in blue' },
    });

    const changed = await enrich();

    expect(changed).toMatchObject({
      status: 'SUCCEEDED',
      result: { enriched: 1, alreadyReady: 2 },
    });
    expect(requestsOf(changed.id)).toEqual([
      'asking the model about 1 product(s)',
    ]);
  });
});

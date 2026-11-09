import { parse } from 'csv-parse/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

const ROWS = 1200;

// A15 — and the first time an import runs end to end through real processes:
// a slip from the API, the file straight to S3, the job through the outbox to
// a worker that streams it back. Submitted twice under one key, it is one job,
// and the catalog holds the file's rows once.
describe('A15 · the same file submitted twice is one import', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi();
    harness.startWorker();
    account = await harness.signUp('a15');
  });

  afterAll(() => harness.stop());

  it('answers the second submit with the first job and imports the rows once', async () => {
    const csv = [
      'sku,name,price,currency',
      ...Array.from(
        { length: ROWS },
        (_, index) => `SKU-${index},Product ${index},${index}.99,EUR`,
      ),
      'BAD-1,,1,EUR',
    ].join('\n');

    const key = await harness.upload(account, csv);
    const body = { type: 'import.csv', payload: { key } };

    const first = await harness.submit(account, body, 'a15-import');
    const second = await harness.submit(account, body, 'a15-import');

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.data).toMatchObject({
      id: first.body.data.id,
      replayed: true,
    });
    expect(await harness.jobs(account.id)).toHaveLength(1);

    const done = await harness.waitForJobStatus(first.body.data.id, [
      'SUCCEEDED',
      'DEAD_LETTERED',
      'CANCELLED',
    ]);

    expect(done).toMatchObject({
      status: 'SUCCEEDED',
      result: { rows: ROWS + 1, imported: ROWS, invalid: 1 },
      progress: { processed: ROWS + 1 },
    });
    expect(await harness.products(account.id)).toHaveLength(ROWS);

    // The one bad row, downloadable, at the line it has in the file: the
    // header is line 1, so the row after 1 200 good ones is line 1 202.
    const link = await harness.request(
      `/jobs/${first.body.data.id}/error-report`,
      { headers: { Authorization: `Bearer ${account.token}` } },
    );

    expect(link.status).toBe(200);

    const report = await fetch(link.body.data.url);

    expect(parse(await report.text(), { bom: true, columns: true })).toEqual([
      expect.objectContaining({
        line: String(ROWS + 2),
        sku: 'BAD-1',
        reason: expect.stringMatching(/^name:/),
      }),
    ]);
  });
});

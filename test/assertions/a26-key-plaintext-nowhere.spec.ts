import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RelayHarness,
  type Account,
  type ProcessHandle,
} from '../harness/relay-harness.js';

interface Line {
  apiKeyId?: string;
  req?: { headers?: { authorization?: string } };
}

// The column types that can hold a string, a key pasted into JSON included.
const TEXTUAL = ['text', 'character varying', 'json', 'jsonb', 'ARRAY'];

// A26 — a key's secret exists nowhere but in its owner's hands (§6.3f). After
// the key is made and used, through both processes, every textual column of
// every table and every line either process logged is searched for it.
describe("A26 · an API key's plaintext is in no row and no log line", () => {
  let harness: RelayHarness;
  let account: Account;
  let api: ProcessHandle;
  let worker: ProcessHandle;

  const linesOf = (handle: ProcessHandle) =>
    handle.log.split('\n').flatMap((text) => {
      try {
        return [JSON.parse(text) as Line];
      } catch {
        return [];
      }
    });

  beforeAll(async () => {
    harness = await RelayHarness.create();
    // JSON lines, as production writes them.
    api = await harness.startApi({ NODE_ENV: 'production' });
    worker = harness.startWorker('worker', { NODE_ENV: 'production' });
    account = await harness.signUp('a26');
  });

  afterAll(() => harness.stop());

  it('stores only its hash, and logs it nowhere', async () => {
    const made = await harness.request('/api-keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.token}` },
      body: JSON.stringify({ name: 'Script', scopes: ['read', 'write'] }),
    });

    expect(made.status).toBe(201);

    const { key, id } = made.body.data as { key: string; id: string };
    // Past the 12 characters that are stored and shown on purpose.
    const secret = key.slice(12);

    const submitted = await harness.request('/jobs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Idempotency-Key': 'a26' },
      body: JSON.stringify({ type: 'MOCK', payload: {} }),
    });

    expect(submitted.status).toBe(202);
    await harness.waitForJobStatus(submitted.body.data.id, ['SUCCEEDED']);

    const read = await harness.request('/jobs', {
      headers: { Authorization: `Bearer ${key}` },
    });

    expect(read.status).toBe(200);

    // The key's requests were logged, under its id and with the header
    // redacted, so finding no secret below means it was kept out.
    const logged = await harness.waitUntil(
      async () => {
        const lines = linesOf(api).filter((line) => line.apiKeyId === id);

        return lines.length >= 2 ? lines : undefined;
      },
      { timeoutMs: 10_000, label: "the key's requests to be logged" },
    );

    for (const line of logged) {
      expect(line.req?.headers?.authorization).toBe('[redacted]');
    }

    expect(api.log).not.toContain(secret);
    expect(worker.log).not.toContain(secret);

    // Every column that could hold a string, in every table.
    const columns = await harness.prisma.$queryRaw<
      { table_name: string; column_name: string }[]
    >`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = ANY(${TEXTUAL})`;

    expect(columns.length).toBeGreaterThan(20);

    const holding = [];

    for (const { table_name: table, column_name: column } of columns) {
      const [{ found }] = await harness.prisma.$queryRawUnsafe<
        { found: number }[]
      >(
        `SELECT count(*)::int AS found FROM "${table}" WHERE strpos("${column}"::text, $1) > 0`,
        secret,
      );

      if (found > 0) {
        holding.push(`${table}.${column}`);
      }
    }

    expect(holding).toEqual([]);

    // What is stored instead.
    expect(
      await harness.prisma.apiKey.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      prefix: key.slice(0, 12),
      hash: createHash('sha256').update(key).digest('hex'),
    });
  });
});

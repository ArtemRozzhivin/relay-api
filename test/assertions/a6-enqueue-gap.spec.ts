import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayHarness, type Account } from '../harness/relay-harness.js';

// A6 — a crash between the commit and the enqueue. The fault is injected so the
// window is deterministic; without asserting that it fired, the ordinary inline
// enqueue would satisfy every other check and the outbox would prove nothing.
describe('A6 · the enqueue gap is closed by the relay', () => {
  let harness: RelayHarness;
  let account: Account;

  beforeAll(async () => {
    harness = await RelayHarness.create();
    await harness.startApi({ RELAY_FAULT_AFTER_COMMIT: '1' });
    harness.startWorker();
    account = await harness.signUp('a6');
  });

  afterAll(() => harness.stop());

  it('recovers a committed-but-never-enqueued job and runs it once', async () => {
    const submitted = await harness.submit(account, {
      type: 'CHARGE',
      payload: { amountCents: 100, reference: 'gap' },
    });

    expect(submitted.status).toBe(500);
    expect(submitted.body.error.code).toBe('INTERNAL_ERROR');

    const [stranded] = await harness.jobs(account.id);
    expect(stranded).toBeDefined();

    const recovered = await harness.waitForJobStatus(stranded.id, [
      'SUCCEEDED',
    ]);
    expect(recovered.status).toBe('SUCCEEDED');

    // Only the relay increments Outbox.attempts; markPublished() never does, so
    // this is what separates "the outbox worked" from "the outbox was bypassed".
    const rows = await harness.outbox(stranded.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
    expect(rows[0].publishedAt).not.toBeNull();

    expect(await harness.sideEffects(account.id)).toHaveLength(1);
  });
});

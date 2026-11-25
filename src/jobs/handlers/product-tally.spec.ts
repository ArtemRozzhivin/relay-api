import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { recordingContext } from '../engine/job-context.fixture.js';
import { ProductTally } from './product-tally.js';

const OUTCOMES = ['processed', 'failed'] as const;

// A transaction that writes nothing: the tally's own part is the checkpoint,
// which the context records.
const noDatabase = {
  $transaction: (work: (tx: Prisma.TransactionClient) => unknown) =>
    work({} as Prisma.TransactionClient),
} as unknown as PrismaService;

const attempt = (checkpoint: Prisma.JsonValue | null = null) => {
  const recorded = recordingContext({ checkpoint, client: noDatabase });

  return { ...recorded, tally: new ProductTally(checkpoint, OUTCOMES) };
};

describe('ProductTally', () => {
  it('starts with nothing concluded', () => {
    const { tally } = attempt();

    expect(tally.count('processed')).toBe(0);
    expect(tally.has('a')).toBe(false);
  });

  it('keeps every conclusion so far in each checkpoint', async () => {
    const { context, tally, checkpoints } = attempt();

    await tally.conclude(context, 'a', 'processed', async () => true);
    await tally.conclude(context, 'b', 'failed', async () => true);

    expect(checkpoints).toEqual([
      { concluded: { a: 'processed' } },
      { concluded: { a: 'processed', b: 'failed' } },
    ]);
  });

  // The fix this exists for: the second attempt skips what the first made, and
  // must still count it.
  it("counts an earlier attempt's conclusions with this one's", async () => {
    const first = attempt();

    await first.tally.conclude(
      first.context,
      'a',
      'processed',
      async () => true,
    );

    const second = attempt(first.checkpoints.at(-1) as Prisma.JsonValue);

    await second.tally.conclude(
      second.context,
      'b',
      'processed',
      async () => true,
    );

    expect(second.tally.count('processed')).toBe(2);
    expect(second.tally.has('a')).toBe(true);
  });

  it('counts a product concluded twice once, as it was last concluded', async () => {
    const { context, tally } = attempt({ concluded: { a: 'failed' } });

    await tally.conclude(context, 'a', 'processed', async () => true);

    expect([tally.count('processed'), tally.count('failed')]).toEqual([1, 0]);
  });

  it('counts a product whose input changed meanwhile as superseded', async () => {
    const { context, tally, checkpoints } = attempt();

    expect(
      await tally.conclude(context, 'a', 'processed', async () => false),
    ).toBe(false);
    expect(tally.count('superseded')).toBe(1);
    expect(tally.count('processed')).toBe(0);
    expect(checkpoints).toEqual([{ concluded: { a: 'superseded' } }]);
  });

  it('counts nothing for a product whose record did not commit', async () => {
    const { context, tally } = attempt();
    const lost = new Error('this attempt no longer owns the job');

    context.commit = async () => {
      throw lost;
    };

    await expect(
      tally.conclude(context, 'a', 'processed', async () => true),
    ).rejects.toBe(lost);
    expect(tally.has('a')).toBe(false);
  });

  it.each([
    ['another handler', { position: 500, imported: 400 }],
    ['nothing a tally wrote', 'junk'],
  ])("starts over from %s's checkpoint", (_label, checkpoint) => {
    expect(attempt(checkpoint).tally.has('a')).toBe(false);
  });

  it('drops an outcome this handler does not conclude', () => {
    const { tally } = attempt({
      concluded: { a: 'processed', b: 'enriched' },
    });

    expect([tally.has('a'), tally.has('b')]).toEqual([true, false]);
  });
});

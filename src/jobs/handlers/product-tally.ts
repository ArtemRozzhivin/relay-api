import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import type { JobContext } from '../engine/job-context.js';

const checkpointSchema = z.object({
  concluded: z.record(z.string(), z.string()),
});

/** Recorded about a product whose input changed while the job worked on it. */
export const SUPERSEDED = 'superseded';

/**
 * What a product batch has concluded, product by product, kept as the job's
 * checkpoint. A retry, a hand-back or a re-drive skips the products an earlier
 * attempt finished, since they read as done; without this, a batch that took
 * two attempts would count only the second one's work, and a pipeline's
 * summary would add up to less than it did (§6.3e).
 *
 * Keyed by product, not added up, so a product concluded again — a FAILED one
 * is tried on every attempt — is counted once, as it was last concluded.
 */
export class ProductTally<Outcome extends string> {
  private readonly concluded: Map<string, Outcome | typeof SUPERSEDED>;

  /**
   * @param checkpoint the job's, as an earlier attempt left it. One this
   * version cannot read starts the count over; the products it counted are
   * still recorded, and read as done.
   * @param outcomes every outcome but `superseded` this handler concludes.
   */
  constructor(
    checkpoint: Prisma.JsonValue | null,
    outcomes: readonly Outcome[],
  ) {
    const known = new Set<string>([...outcomes, SUPERSEDED]);
    const parsed = checkpointSchema.safeParse(checkpoint);

    this.concluded = new Map(
      parsed.success
        ? Object.entries(parsed.data.concluded).flatMap(([id, outcome]) =>
            known.has(outcome)
              ? [[id, outcome as Outcome | typeof SUPERSEDED] as const]
              : [],
          )
        : [],
    );
  }

  /** Whether this job, in any attempt, has concluded the product. */
  has(productId: string) {
    return this.concluded.has(productId);
  }

  count(outcome: Outcome | typeof SUPERSEDED) {
    let total = 0;

    for (const concluded of this.concluded.values()) {
      total += concluded === outcome ? 1 : 0;
    }

    return total;
  }

  /**
   * Records one product through `record`, and its outcome in the checkpoint,
   * in one transaction: the count never holds a product whose record rolled
   * back, nor misses one that committed.
   *
   * @param record writes through `tx` only, and answers whether the product
   * still had the input it was concluded about; one that did not is counted as
   * superseded.
   * @returns what `record` answered.
   * @throws JobCancelledError when this attempt no longer owns the job.
   */
  async conclude(
    context: JobContext,
    productId: string,
    outcome: Outcome,
    record: (tx: Prisma.TransactionClient) => Promise<boolean>,
  ) {
    const concludedAs = (recorded: boolean) =>
      recorded ? outcome : SUPERSEDED;

    const recorded = await context.commit(record, (recorded) => ({
      concluded: {
        ...Object.fromEntries(this.concluded),
        [productId]: concludedAs(recorded),
      },
    }));

    this.concluded.set(productId, concludedAs(recorded));

    return recorded;
  }
}

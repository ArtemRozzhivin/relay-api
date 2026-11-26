import { z } from 'zod';
import { ProductCategory } from '../generated/prisma/enums.js';
import { storableText } from '../common/validation/storable-text.js';

// A reason is shown to the product's owner, and the model chose the value.
const shown = (value: unknown) =>
  (JSON.stringify(value) ?? String(value)).slice(0, 40);

const replySchema = z.object({ items: z.array(z.unknown()) });

const itemSchema = z.object({
  sku: z.string(),
  category: z.enum(ProductCategory, {
    error: (issue) => `${shown(issue.input)} is not one of the categories`,
  }),
  tags: z.array(storableText().trim().min(1).max(30)).max(5),
});

export type Enrichment = Omit<z.infer<typeof itemSchema>, 'sku'>;

export interface CheckedReply {
  answers: Map<string, Enrichment>;
  /** Why each requested sku without an answer has none. */
  problems: Map<string, string>;
}

const describeIssues = (error: z.ZodError) =>
  error.issues
    .map(({ path, message }) =>
      path.length > 0 ? `${path.join('.')}: ${message}` : message,
    )
    .join('; ');

const skuOf = (item: unknown) =>
  typeof item === 'object' &&
  item !== null &&
  'sku' in item &&
  typeof item.sku === 'string'
    ? item.sku
    : undefined;

/**
 * Reads a model's reply to a request about `skus`, trusting nothing in it
 * (§6.3d). Each item is checked on its own, so one bad answer costs only its
 * product.
 *
 * @returns every requested sku, either in `answers` or in `problems`. An item
 * about a sku the request did not name is dropped: there is no product of this
 * request to record it on.
 */
export const checkReply = (
  text: string,
  skus: readonly string[],
): CheckedReply => {
  const everyOne = (problem: string) => ({
    answers: new Map<string, Enrichment>(),
    problems: new Map(skus.map((sku) => [sku, problem])),
  });

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return everyOne('The reply was not JSON');
  }

  const reply = replySchema.safeParse(parsed);

  if (!reply.success) {
    return everyOne('The reply had no list of items');
  }

  const requested = new Set(skus);
  const seen = new Set<string>();
  const answers = new Map<string, Enrichment>();
  const problems = new Map<string, string>();

  for (const item of reply.data.items) {
    const sku = skuOf(item);

    if (sku === undefined || !requested.has(sku)) {
      continue;
    }

    // Two answers for one product leave no way to tell which one was meant.
    if (seen.has(sku)) {
      answers.delete(sku);
      problems.set(sku, 'The reply answered this product more than once');
      continue;
    }

    seen.add(sku);

    const checked = itemSchema.safeParse(item);

    if (checked.success) {
      answers.set(sku, {
        category: checked.data.category,
        tags: checked.data.tags,
      });
    } else {
      problems.set(sku, describeIssues(checked.error));
    }
  }

  for (const sku of skus) {
    if (!seen.has(sku)) {
      problems.set(sku, 'The reply left this product out');
    }
  }

  return { answers, problems };
};

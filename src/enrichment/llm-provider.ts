export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** What a product is enriched from. */
export interface EnrichmentInput {
  sku: string;
  name: string;
  description: string | null;
}

export interface LlmRequest {
  products: EnrichmentInput[];
  /**
   * What was wrong with the previous reply. Set only on the one corrective
   * request a batch gets (§6.3d).
   */
  correction?: string;
}

export interface LlmReply {
  /** Meant to be JSON, and trusted for nothing until it has been checked. */
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/** What a model charges, in US dollars per million tokens each way. */
export interface ModelPrice {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** What a reply cost at `price`, in US dollars. */
export const estimateCostUsd = (
  price: ModelPrice,
  { tokensIn, tokensOut }: Pick<LlmReply, 'tokensIn' | 'tokensOut'>,
) =>
  (tokensIn * price.inputUsdPerMillionTokens +
    tokensOut * price.outputUsdPerMillionTokens) /
  TOKENS_PER_PRICE_UNIT;

/**
 * A language model asked for each product's category and tags (§6.3d). It
 * returns the model's text as it came: checking it is the caller's job, so
 * every provider is held to the same rules.
 *
 * @throws LlmRateLimitError when the provider is busy and says for how long.
 * Anything else it throws — the provider down, say — fails the attempt, and
 * the job is retried until its attempts are spent.
 */
export interface LlmProvider {
  /** What the model charges, which each job's estimated cost uses. */
  readonly price: ModelPrice;

  enrich(request: LlmRequest): Promise<LlmReply>;
}

/**
 * The provider refused a request for now: a 429. Not the job's failure; the
 * queue waits {@link retryAfterMs} and the job runs again (§6.3d).
 */
export class LlmRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`The language model is busy; retry after ${retryAfterMs} ms`);
    this.name = 'LlmRateLimitError';
  }
}

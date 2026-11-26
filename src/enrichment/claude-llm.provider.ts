import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODELS, type ClaudeModel } from './claude-models.js';
import {
  ENRICHMENT_INSTRUCTIONS,
  REPLY_SCHEMA,
  enrichmentMessage,
} from './enrichment-prompt.js';
import {
  LlmRateLimitError,
  type LlmProvider,
  type LlmReply,
  type LlmRequest,
  type ModelPrice,
} from './llm-provider.js';

// A reply about 20 products takes seconds. One not in after a minute is
// stuck, and the attempt is better failed and retried than left holding its
// worker.
const REQUEST_TIMEOUT_MS = 60_000;

// Room for the model's thinking and twenty answers. Only what is generated is
// paid for; a reply cut short fails its check and gets the corrective request.
const MAX_TOKENS = 16_000;

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// A 429 that says when to come back pauses the queue for that long (§6.3d).
// One that does not — a spent monthly limit — is no wait the queue can sit
// out, so it fails the attempt like any other error.
const retryAfterMs = (error: unknown) => {
  if (!(error instanceof Anthropic.RateLimitError)) {
    return undefined;
  }

  const header = error.headers.get('retry-after')?.trim();
  const seconds = header ? Number(header) : Number.NaN;

  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

export interface ClaudeLlmOptions {
  /**
   * Required by the worker's configuration. Unset only in the API, which
   * registers the handler but never runs it.
   */
  apiKey?: string;
  model: ClaudeModel;
  /** Replaces the network, for the tests. */
  fetch?: typeof fetch;
}

/**
 * Asks a Claude model for each product's category and tags (§6.3d). The
 * reply's shape is constrained by a JSON schema, and the text comes back as it
 * was sent: the caller checks it, as it checks every provider's.
 *
 * @throws LlmRateLimitError on a 429 with a `Retry-After`. Anything else the
 * API answers — a 429 without one, a 5xx, a timeout, a key it refuses — is
 * thrown as the SDK's error, which fails the attempt.
 */
export class ClaudeLlmProvider implements LlmProvider {
  readonly price: ModelPrice;

  private readonly client: Anthropic;

  private readonly model: ClaudeModel;

  constructor({ apiKey, model, fetch }: ClaudeLlmOptions) {
    this.model = model;
    this.price = CLAUDE_MODELS[model].price;
    // No retries of its own: a 429 must reach the queue, which pauses every
    // worker for it, and any other failure is the job's attempt to retry,
    // with the job's backoff.
    this.client = new Anthropic({
      apiKey,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
      ...(fetch === undefined ? {} : { fetch }),
    });
  }

  async enrich(request: LlmRequest): Promise<LlmReply> {
    let message: Anthropic.Beta.BetaMessage;

    try {
      message = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: ENRICHMENT_INSTRUCTIONS,
        messages: [{ role: 'user', content: enrichmentMessage(request) }],
        output_config: {
          // Picking one of twelve categories needs little thought.
          effort: 'low',
          format: { type: 'json_schema', schema: REPLY_SCHEMA },
        },
        // A model that declines is retried on another where the API offers
        // one, rather than failing the batch's products outright.
        ...(CLAUDE_MODELS[this.model].fallbacks
          ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const }
          : {}),
      });
    } catch (error) {
      const waitMs = retryAfterMs(error);

      throw waitMs === undefined ? error : new LlmRateLimitError(waitMs);
    }

    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');

    return {
      text,
      tokensIn: message.usage.input_tokens,
      tokensOut: message.usage.output_tokens,
      ...(message.stop_reason === 'refusal'
        ? { declined: message.stop_details?.category ?? 'no reason given' }
        : {}),
    };
  }
}

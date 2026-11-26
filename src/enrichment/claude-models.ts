import type { ModelPrice } from './llm-provider.js';

interface ClaudeModelTerms {
  /** The list price, which each job's estimated cost uses. */
  price: ModelPrice;
  /**
   * Whether the API may answer a request this model declines with another
   * model (server-side fallback). Claude Haiku offers none.
   */
  fallbacks: boolean;
}

/**
 * The Claude models `ai.enrich` can be configured with (§6.3d). A model not
 * listed is refused at boot: without its price, the cost each job records
 * would be wrong.
 */
export const CLAUDE_MODELS = {
  'claude-sonnet-5-5': {
    price: { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10 },
    fallbacks: true,
  },
  'claude-opus-5-5': {
    price: { inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 20 },
    fallbacks: true,
  },
  // Its price doubles past 100K tokens of prompt, which a batch of 20
  // products never comes near.
  'claude-haiku-5-5': {
    price: { inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.5 },
    fallbacks: false,
  },
} as const satisfies Record<string, ClaudeModelTerms>;

export type ClaudeModel = keyof typeof CLAUDE_MODELS;

export const CLAUDE_MODEL_IDS = Object.keys(CLAUDE_MODELS) as [
  ClaudeModel,
  ...ClaudeModel[],
];

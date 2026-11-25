import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CATEGORIES } from './taxonomy.js';
import {
  LlmRateLimitError,
  type EnrichmentInput,
  type LlmProvider,
  type LlmRequest,
} from './llm-provider.js';

const DIRECTIVE = /\[llm:([a-z-]+)\]/g;

// Roughly what a tokenizer makes of English text.
const CHARACTERS_PER_TOKEN = 4;

// Long enough for a test to act while the request is in flight: A24 stops the
// API before the reply arrives.
export const SLOW_REPLY_MS = 3000;

const categoryOf = (sku: string) =>
  CATEGORIES[
    createHash('sha256').update(sku).digest().readUInt32BE(0) %
      CATEGORIES.length
  ];

const tagsOf = (name: string) =>
  [
    ...new Set(
      name
        .replace(DIRECTIVE, '')
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((word) => word.length > 2),
    ),
  ].slice(0, 3);

const tokens = (text: string) => Math.ceil(text.length / CHARACTERS_PER_TOKEN);

export interface FakeLlmOptions {
  /**
   * Whether a directive in a product's name is obeyed. Off, a name is only a
   * name: any account can write one, and `[llm:busy]` pauses the AI queue
   * every account shares.
   */
  directives?: boolean;
}

/**
 * A model that answers the same request the same way every time, with no key
 * and no cost. With `directives` on, a directive in a product's name makes it
 * fail the way a real model does rarely: see the table in §6.3d.
 *
 * Holds one piece of state: the products it has already refused as busy, so
 * that a busy product is refused once per process and then answered.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly model = 'fake';

  // The fake charges nothing. A price in the range small hosted models charge
  // gives the cost a job records something to show.
  readonly price = {
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 5,
  };

  private readonly refusedAsBusy = new Set<string>();

  private readonly obeysDirectives: boolean;

  constructor({ directives = false }: FakeLlmOptions = {}) {
    this.obeysDirectives = directives;
  }

  async enrich(request: LlmRequest) {
    if (this.holding(request, 'down').length > 0) {
      throw new Error(
        'The language model is unavailable: 503 Service Unavailable',
      );
    }

    const busy = this.holding(request, 'busy')
      .map((product) => JSON.stringify([product.sku, product.name]))
      .filter((key) => !this.refusedAsBusy.has(key));

    if (busy.length > 0) {
      busy.forEach((key) => this.refusedAsBusy.add(key));
      throw new LlmRateLimitError(1000);
    }

    if (this.holding(request, 'slow').length > 0) {
      await sleep(SLOW_REPLY_MS);
    }

    const text = this.answer(request);

    return {
      text,
      tokensIn: tokens(JSON.stringify(request)),
      tokensOut: tokens(text),
    };
  }

  private directivesOf(product: EnrichmentInput) {
    return new Set(
      this.obeysDirectives
        ? [...product.name.matchAll(DIRECTIVE)].map(([, name]) => name)
        : [],
    );
  }

  private holding(request: LlmRequest, directive: string) {
    return request.products.filter((product) =>
      this.directivesOf(product).has(directive),
    );
  }

  private answer(request: LlmRequest) {
    const items = request.products.map((product) => ({
      sku: product.sku,
      category: this.directivesOf(product).has('off-taxonomy')
        ? 'gadgets'
        : categoryOf(product.sku),
      tags: tagsOf(product.name),
    }));
    const json = JSON.stringify({ items });

    const malformed =
      this.holding(request, 'malformed').length > 0 ||
      (request.correction === undefined &&
        this.holding(request, 'malformed-once').length > 0);

    // What a real model sends when it does go wrong: a sentence of its own,
    // then JSON that stops partway.
    return malformed
      ? `Sure! Here are the categories: ${json.slice(0, json.length / 2)}`
      : json;
  }
}

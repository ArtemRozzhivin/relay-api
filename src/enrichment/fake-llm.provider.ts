import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
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

const directivesOf = (product: EnrichmentInput) =>
  new Set([...product.name.matchAll(DIRECTIVE)].map(([, name]) => name));

const holding = (request: LlmRequest, directive: string) =>
  request.products.filter((product) => directivesOf(product).has(directive));

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

/**
 * A model that answers the same request the same way every time, with no key
 * and no cost. A directive in a product's name makes it fail the way a real
 * model does rarely: see the table in §6.3d.
 *
 * Holds one piece of state: the products it has already refused as busy, so
 * that a busy product is refused once per process and then answered.
 */
@Injectable()
export class FakeLlmProvider implements LlmProvider {
  readonly model = 'fake';

  // The fake charges nothing. A price in the range small hosted models charge
  // gives the cost a job records something to show.
  readonly price = {
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 5,
  };

  private readonly refusedAsBusy = new Set<string>();

  async enrich(request: LlmRequest) {
    const busy = holding(request, 'busy')
      .map((product) => JSON.stringify([product.sku, product.name]))
      .filter((key) => !this.refusedAsBusy.has(key));

    if (busy.length > 0) {
      busy.forEach((key) => this.refusedAsBusy.add(key));
      throw new LlmRateLimitError(1000);
    }

    const text = this.answer(request);

    return {
      text,
      tokensIn: tokens(JSON.stringify(request)),
      tokensOut: tokens(text),
    };
  }

  private answer(request: LlmRequest) {
    const items = request.products.map((product) => ({
      sku: product.sku,
      category: directivesOf(product).has('off-taxonomy')
        ? 'gadgets'
        : categoryOf(product.sku),
      tags: tagsOf(product.name),
    }));
    const json = JSON.stringify({ items });

    const malformed =
      holding(request, 'malformed').length > 0 ||
      (request.correction === undefined &&
        holding(request, 'malformed-once').length > 0);

    // What a real model sends when it does go wrong: a sentence of its own,
    // then JSON that stops partway.
    return malformed
      ? `Sure! Here are the categories: ${json.slice(0, json.length / 2)}`
      : json;
  }
}

import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { workerEnvSchema } from '../../src/config/env.schema.js';
import { ClaudeLlmProvider } from '../../src/enrichment/claude-llm.provider.js';
import { checkReply } from '../../src/enrichment/enrichment-reply.js';
import {
  estimateCostUsd,
  type EnrichmentInput,
  type LlmReply,
} from '../../src/enrichment/llm-provider.js';

const PRODUCTS: EnrichmentInput[] = [
  {
    sku: 'BOOT-1',
    name: "Men's waterproof leather hiking boots",
    description: 'Vibram sole, ankle support, sizes 40-46',
  },
  {
    sku: 'PRESS-1',
    name: 'Stainless steel French press, 1 litre',
    description: null,
  },
  {
    sku: 'CREAM-1',
    name: 'Organic lavender hand cream, 75 ml',
    description: 'Shea butter, for dry skin',
  },
];

const provider = () => {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    throw new Error('Set ANTHROPIC_API_KEY in .env to run the live tests');
  }

  return new ClaudeLlmProvider({
    apiKey,
    model: workerEnvSchema.shape.LLM_MODEL.parse(process.env.LLM_MODEL),
  });
};

// What a run cost is worth seeing: it is the number a plan's AI limit will
// count.
const report = (label: string, llm: ClaudeLlmProvider, reply: LlmReply) =>
  console.info(
    `${label}: ${reply.tokensIn} tokens in, ${reply.tokensOut} out, about $${estimateCostUsd(llm.price, reply).toFixed(4)}: ${reply.text}`,
  );

describe('Claude, asked for real', () => {
  it('gives each product a listed category and tags the checks accept', async () => {
    const llm = provider();
    const reply = await llm.enrich({ products: PRODUCTS });

    report('first request', llm, reply);

    const { answers, problems } = checkReply(
      reply,
      PRODUCTS.map(({ sku }) => sku),
    );

    expect(Object.fromEntries(problems)).toEqual({});
    expect(
      Object.fromEntries(
        [...answers].map(([sku, { category }]) => [sku, category]),
      ),
    ).toEqual({
      'BOOT-1': 'footwear',
      'PRESS-1': 'kitchen',
      'CREAM-1': 'beauty',
    });
  });

  it('answers the corrective request about the product it names', async () => {
    const llm = provider();
    const reply = await llm.enrich({
      products: PRODUCTS.slice(0, 1),
      correction: 'BOOT-1: "gadgets" is not one of the categories',
    });

    report('corrective request', llm, reply);

    const { answers, problems } = checkReply(reply, ['BOOT-1']);

    expect(Object.fromEntries(problems)).toEqual({});
    expect(answers.get('BOOT-1')?.category).toBe('footwear');
  });
});

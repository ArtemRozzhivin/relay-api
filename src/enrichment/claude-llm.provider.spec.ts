import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeLlmProvider } from './claude-llm.provider.js';
import type { ClaudeModel } from './claude-models.js';
import { ENRICHMENT_INSTRUCTIONS, REPLY_SCHEMA } from './enrichment-prompt.js';
import { LlmRateLimitError, type LlmRequest } from './llm-provider.js';
import { CATEGORIES } from './taxonomy.js';

const MUG = { sku: 'MUG-1', name: 'Blue mug', description: 'Stoneware' };

interface Sent {
  headers: Headers;
  body: Record<string, any>;
}

const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: '{"items":[]}' },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 420, output_tokens: 95 },
  ...overrides,
});

const json = (status: number, body: unknown, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const API_ERROR = { type: 'error', error: { type: 'x', message: 'x' } };

// The API as the provider sees it: every request it was sent, and one answer
// it gives each time.
const providerAnswering = (
  answer: () => Response,
  model: ClaudeModel = 'claude-sonnet-5-5',
) => {
  const sent: Sent[] = [];
  const provider = new ClaudeLlmProvider({
    apiKey: 'test-key',
    model,
    fetch: async (input, init) => {
      const request = new Request(input, init);

      sent.push({ headers: request.headers, body: await request.json() });

      return answer();
    },
  });

  return { provider, sent };
};

const ask = (provider: ClaudeLlmProvider, request: Partial<LlmRequest> = {}) =>
  provider.enrich({ products: [MUG], ...request });

describe('ClaudeLlmProvider', () => {
  it('asks the configured model, with the instructions, the reply schema and the products', async () => {
    const { provider, sent } = providerAnswering(() => json(200, message()));

    await ask(provider);

    const [{ headers, body }] = sent;

    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      system: ENRICHMENT_INSTRUCTIONS,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: REPLY_SCHEMA },
      },
    });
    expect(
      body.output_config.format.schema.properties.items.items.properties
        .category.enum,
    ).toEqual(CATEGORIES);
    expect(body.messages).toEqual([
      { role: 'user', content: `Products:\n${JSON.stringify([MUG])}` },
    ]);
  });

  it('says what was wrong in the corrective request', async () => {
    const { provider, sent } = providerAnswering(() => json(200, message()));

    await ask(provider, {
      correction: 'MUG-1: "gadgets" is not one of the categories',
    });

    expect(sent[0].body.messages[0].content).toContain(
      'could not be used:\nMUG-1: "gadgets" is not one of the categories',
    );
  });

  it('lets the API answer a declined request with another model, where it offers one', async () => {
    const sonnet = providerAnswering(() => json(200, message()));
    const haiku = providerAnswering(
      () => json(200, message()),
      'claude-haiku-5-5',
    );

    await ask(sonnet.provider);
    await ask(haiku.provider);

    expect(sonnet.sent[0].body.fallbacks).toBe('default');
    expect(sonnet.sent[0].headers.get('anthropic-beta')).toContain(
      'server-side-fallback-2026-07-01',
    );
    expect(haiku.sent[0].body).not.toHaveProperty('fallbacks');
    expect(haiku.sent[0].headers.get('anthropic-beta')).toBeNull();
  });

  it("returns the reply's text, without its thinking, and the tokens it cost", async () => {
    const { provider } = providerAnswering(() =>
      json(
        200,
        message({
          content: [
            {
              type: 'thinking',
              thinking: 'mugs are kitchenware',
              signature: 's',
            },
            { type: 'text', text: '{"items":' },
            { type: 'text', text: '[]}' },
          ],
        }),
      ),
    );

    expect(await ask(provider)).toEqual({
      text: '{"items":[]}',
      tokensIn: 420,
      tokensOut: 95,
    });
  });

  it.each([
    [
      'the category the API gave',
      { type: 'refusal', category: 'cyber' },
      'cyber',
    ],
    ['that none was given', null, 'no reason given'],
  ])('reports a refusal, naming %s', async (_label, stopDetails, declined) => {
    const { provider } = providerAnswering(() =>
      json(200, message({ stop_reason: 'refusal', stop_details: stopDetails })),
    );

    expect(await ask(provider)).toMatchObject({ declined, tokensOut: 95 });
  });

  it('turns a 429 with a Retry-After into a wait for the queue, asking once', async () => {
    const { provider, sent } = providerAnswering(() =>
      json(429, API_ERROR, { 'retry-after': '7' }),
    );

    const refused = await ask(provider).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(LlmRateLimitError);
    expect(refused).toMatchObject({ retryAfterMs: 7000 });
    expect(sent).toHaveLength(1);
  });

  // A spent monthly limit answers 429 with no time to come back.
  it('fails the attempt on a 429 that names no wait', async () => {
    const { provider } = providerAnswering(() => json(429, API_ERROR));

    const refused = await ask(provider).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(Anthropic.RateLimitError);
    expect(refused).not.toBeInstanceOf(LlmRateLimitError);
  });

  it('fails the attempt on a server error, without retrying it itself', async () => {
    const { provider, sent } = providerAnswering(() => json(529, API_ERROR));

    await expect(ask(provider)).rejects.toBeInstanceOf(Anthropic.APIError);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['claude-sonnet-5-5', 2, 10],
    ['claude-opus-5-5', 4, 20],
    ['claude-haiku-5-5', 0.1, 0.5],
  ] as const)('prices %s at its list price', (model, input, output) => {
    expect(new ClaudeLlmProvider({ apiKey: 'test-key', model }).price).toEqual({
      inputUsdPerMillionTokens: input,
      outputUsdPerMillionTokens: output,
    });
  });
});

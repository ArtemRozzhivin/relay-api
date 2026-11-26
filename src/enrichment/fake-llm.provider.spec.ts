import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATEGORIES } from './taxonomy.js';
import { FakeLlmProvider, SLOW_REPLY_MS } from './fake-llm.provider.js';
import { LlmRateLimitError, type EnrichmentInput } from './llm-provider.js';

const product = (sku: string, name: string): EnrichmentInput => ({
  sku,
  name,
  description: null,
});

// As the tests run it: obeying the directives in names.
const OBEYING = { directives: true };

const shirt = product('SHIRT-1', 'Blue Cotton Shirt');
const mug = product('MUG-1', 'Stoneware Mug');

const itemsOf = (text: string) =>
  (
    JSON.parse(text) as {
      items: { sku: string; category: string; tags: string[] }[];
    }
  ).items;

describe('FakeLlmProvider', () => {
  it('answers each product with a category from the list and tags from its name', async () => {
    const { text } = await new FakeLlmProvider(OBEYING).enrich({
      products: [shirt, mug],
    });
    const items = itemsOf(text);

    expect(items.map(({ sku, tags }) => ({ sku, tags }))).toEqual([
      { sku: 'SHIRT-1', tags: ['blue', 'cotton', 'shirt'] },
      { sku: 'MUG-1', tags: ['stoneware', 'mug'] },
    ]);
    expect(CATEGORIES).toEqual(
      expect.arrayContaining(items.map(({ category }) => category)),
    );
  });

  it('answers the same request the same way, from another instance too', async () => {
    const request = { products: [shirt, mug] };

    expect(await new FakeLlmProvider(OBEYING).enrich(request)).toEqual(
      await new FakeLlmProvider(OBEYING).enrich(request),
    );
  });

  it('counts the characters sent and received as tokens, four to one', async () => {
    const request = { products: [shirt] };
    const reply = await new FakeLlmProvider(OBEYING).enrich(request);

    expect(reply.tokensIn).toBe(Math.ceil(JSON.stringify(request).length / 4));
    expect(reply.tokensOut).toBe(Math.ceil(reply.text.length / 4));
  });

  it('gives a product named [llm:off-taxonomy] a category outside the list, and only that one', async () => {
    const { text } = await new FakeLlmProvider(OBEYING).enrich({
      products: [product('ODD-1', 'Odd Lamp [llm:off-taxonomy]'), mug],
    });
    const [odd, other] = itemsOf(text);

    expect(odd).toMatchObject({ category: 'gadgets', tags: ['odd', 'lamp'] });
    expect(CATEGORIES).toContain(other.category);
  });

  it('answers [llm:malformed] with text that is not JSON, corrective request included', async () => {
    const fake = new FakeLlmProvider(OBEYING);
    const products = [product('BAD-1', 'Bad Lamp [llm:malformed]'), mug];

    for (const correction of [undefined, 'The reply was not JSON']) {
      const { text } = await fake.enrich({ products, correction });

      expect(text).toMatch(/^Sure!/);
      expect(() => JSON.parse(text)).toThrow();
    }
  });

  it('answers [llm:malformed-once] correctly only on the corrective request', async () => {
    const fake = new FakeLlmProvider(OBEYING);
    const products = [product('ONCE-1', 'Lamp [llm:malformed-once]')];

    for (let request = 0; request < 2; request++) {
      const { text } = await fake.enrich({ products });

      expect(() => JSON.parse(text)).toThrow();
    }

    const { text } = await fake.enrich({
      products,
      correction: 'The reply was not JSON',
    });

    expect(itemsOf(text)).toHaveLength(1);
  });

  // The default, and production's only setting: a directive in a name any
  // account writes must not let that account fail the model for everyone.
  it.each(['busy', 'down', 'slow', 'malformed', 'off-taxonomy'])(
    'answers a name holding [llm:%s] like any other unless told to obey it',
    async (directive) => {
      const started = Date.now();
      const { text } = await new FakeLlmProvider().enrich({
        products: [product('X-1', `Lamp [llm:${directive}]`)],
      });

      expect(itemsOf(text)).toEqual([
        { sku: 'X-1', category: expect.any(String), tags: ['lamp'] },
      ]);
      expect(CATEGORIES).toContain(itemsOf(text)[0]!.category);
      expect(Date.now() - started).toBeLessThan(SLOW_REPLY_MS);
    },
  );

  it('refuses [llm:busy] as a 429 once, then answers it', async () => {
    const fake = new FakeLlmProvider(OBEYING);
    const request = { products: [product('BUSY-1', 'Lamp [llm:busy]'), mug] };

    const refusal = await fake.enrich(request).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(LlmRateLimitError);
    expect(refusal).toMatchObject({ retryAfterMs: 1000 });
    expect(itemsOf((await fake.enrich(request)).text)).toHaveLength(2);
  });

  // Each instance is a process's provider: a second worker refuses it too.
  it('refuses [llm:busy] once per instance', async () => {
    const request = { products: [product('BUSY-1', 'Lamp [llm:busy]')] };

    await expect(new FakeLlmProvider(OBEYING).enrich(request)).rejects.toThrow(
      LlmRateLimitError,
    );
    await expect(new FakeLlmProvider(OBEYING).enrich(request)).rejects.toThrow(
      LlmRateLimitError,
    );
  });

  it('fails every request holding [llm:down], as a provider that is down does', async () => {
    const fake = new FakeLlmProvider(OBEYING);
    const request = { products: [product('DOWN-1', 'Lamp [llm:down]'), mug] };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(fake.enrich(request)).rejects.toThrow(/unavailable: 503/);
    }

    await expect(fake.enrich({ products: [mug] })).resolves.toBeDefined();
  });

  describe('[llm:slow]', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('answers a request holding it only once its delay has passed', async () => {
      vi.useFakeTimers();

      let answered = false;
      const reply = new FakeLlmProvider(OBEYING)
        .enrich({ products: [product('SLOW-1', 'Desk [llm:slow]'), mug] })
        .then((answer) => {
          answered = true;

          return answer;
        });

      await vi.advanceTimersByTimeAsync(SLOW_REPLY_MS - 1);
      expect(answered).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(itemsOf((await reply).text)).toHaveLength(2);
    });

    it('answers a request without it at once', async () => {
      vi.useFakeTimers();

      let answered = false;

      void new FakeLlmProvider(OBEYING).enrich({ products: [mug] }).then(() => {
        answered = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(answered).toBe(true);
    });
  });
});

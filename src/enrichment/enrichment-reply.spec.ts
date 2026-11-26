import { describe, expect, it } from 'vitest';
import { checkReply } from './enrichment-reply.js';

const reply = (...items: unknown[]) => JSON.stringify({ items });

const good = (sku: string) => ({
  sku,
  category: 'kitchen',
  tags: ['mug', 'stoneware'],
});

// Every requested sku lands in exactly one of the two maps.
const verdicts = (text: string, skus: string[]) => {
  const { answers, problems } = checkReply({ text }, skus);

  return Object.fromEntries(
    skus.map((sku) => [
      sku,
      answers.get(sku) ?? { problem: problems.get(sku) },
    ]),
  );
};

describe('checkReply', () => {
  it('accepts an item with a listed category and short tags', () => {
    expect(verdicts(reply(good('A')), ['A'])).toEqual({
      A: { category: 'kitchen', tags: ['mug', 'stoneware'] },
    });
  });

  it('fails every product when the reply is not JSON', () => {
    expect(
      verdicts('Sure! Here are the categories: {"items": [', ['A', 'B']),
    ).toEqual({
      A: { problem: 'The reply was not JSON' },
      B: { problem: 'The reply was not JSON' },
    });
  });

  it('fails every product when the JSON holds no list of items', () => {
    expect(verdicts(JSON.stringify([good('A')]), ['A'])).toEqual({
      A: { problem: 'The reply had no list of items' },
    });
  });

  it('refuses a category outside the list, naming it, and only for its product', () => {
    expect(
      verdicts(reply({ ...good('A'), category: 'gadgets' }, good('B')), [
        'A',
        'B',
      ]),
    ).toEqual({
      A: { problem: 'category: "gadgets" is not one of the categories' },
      B: { category: 'kitchen', tags: ['mug', 'stoneware'] },
    });
  });

  it('refuses a category in another case: the list is exact', () => {
    expect(
      verdicts(reply({ ...good('A'), category: 'Kitchen' }), ['A']).A,
    ).toEqual({ problem: 'category: "Kitchen" is not one of the categories' });
  });

  it('refuses a missing category', () => {
    const { sku, tags } = good('A');

    expect(verdicts(reply({ sku, tags }), ['A']).A).toEqual({
      problem: 'category: undefined is not one of the categories',
    });
  });

  it('refuses more than five tags', () => {
    expect(
      verdicts(reply({ ...good('A'), tags: ['a', 'b', 'c', 'd', 'e', 'f'] }), [
        'A',
      ]).A,
    ).toEqual({ problem: expect.stringMatching(/^tags: /) });
  });

  it('refuses a tag over 30 characters, a blank one and one Postgres cannot store', () => {
    for (const tag of ['x'.repeat(31), '   ', 'mug\u0000']) {
      expect(verdicts(reply({ ...good('A'), tags: [tag] }), ['A']).A).toEqual({
        problem: expect.stringMatching(/^tags\.0: /),
      });
    }
  });

  it('trims tags and accepts none', () => {
    expect(
      verdicts(
        reply({ ...good('A'), tags: ['  mug '] }, { ...good('B'), tags: [] }),
        ['A', 'B'],
      ),
    ).toEqual({
      A: { category: 'kitchen', tags: ['mug'] },
      B: { category: 'kitchen', tags: [] },
    });
  });

  it('says a product the reply left out was left out', () => {
    expect(verdicts(reply(good('A')), ['A', 'B']).B).toEqual({
      problem: 'The reply left this product out',
    });
  });

  // What a declining model sends may still read as JSON; none of it counts.
  it('answers no product of a reply the model declined', () => {
    const { answers, problems } = checkReply(
      { text: reply(good('A')), declined: 'general_harms' },
      ['A', 'B'],
    );

    expect(answers.size).toBe(0);
    expect(Object.fromEntries(problems)).toEqual({
      A: 'The model declined to answer (general_harms)',
      B: 'The model declined to answer (general_harms)',
    });
  });

  // An answer for another sku — or another account's — has no product of this
  // request to be written to.
  it('drops an item about a sku the request did not name', () => {
    const { answers, problems } = checkReply(
      { text: reply(good('A'), good('Z')) },
      ['A'],
    );

    expect([...answers.keys()]).toEqual(['A']);
    expect([...problems.keys()]).toEqual([]);
  });

  it('refuses a product answered twice, even when both answers are valid', () => {
    expect(verdicts(reply(good('A'), good('A')), ['A']).A).toEqual({
      problem: 'The reply answered this product more than once',
    });
  });

  it('ignores fields it did not ask for', () => {
    expect(verdicts(reply({ ...good('A'), confidence: 0.4 }), ['A']).A).toEqual(
      { category: 'kitchen', tags: ['mug', 'stoneware'] },
    );
  });

  it('shows at most 40 characters of a value the model chose', () => {
    const { problem } = verdicts(
      reply({ ...good('A'), category: 'k'.repeat(500) }),
      ['A'],
    ).A as { problem: string };

    expect(problem).toBe(
      `category: "${'k'.repeat(39)} is not one of the categories`,
    );
  });
});

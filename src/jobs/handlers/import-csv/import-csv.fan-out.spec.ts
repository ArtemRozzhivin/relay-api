import { describe, expect, it } from 'vitest';
import { FanOutPlan, type FanOutProduct } from './import-csv.fan-out.js';
import { hashEnrichmentInput } from '../../../enrichment/enrichment-input.js';

const product = (
  sku: string,
  fields: Partial<FanOutProduct> = {},
): FanOutProduct => ({
  sku,
  name: `Product ${sku}`,
  description: null,
  enrichmentStatus: null,
  enrichmentInputHash: null,
  imageUrl: null,
  imageStatus: null,
  imageSourceUrl: null,
  ...fields,
});

const enriched = (sku: string, fields: Partial<FanOutProduct> = {}) => {
  const text = { name: `Product ${sku}`, description: null, ...fields };

  return product(sku, {
    ...text,
    enrichmentStatus: 'READY',
    enrichmentInputHash: hashEnrichmentInput(text),
  });
};

const planned = (products: FanOutProduct[]) => {
  const plan = new FanOutPlan();

  products.forEach((each) => plan.add(each));

  return plan.batches();
};

const skusOf = (products: FanOutProduct[], stage: string) =>
  planned(products)
    .filter((batch) => batch.stage === stage)
    .flatMap(({ payload }) => payload.skus);

const URL = 'https://shop.example/a.jpg';

describe('FanOutPlan', () => {
  it('makes no batch for nothing', () => {
    expect(planned([])).toEqual([]);
  });

  it('enriches a product with no answer for its text, and skips one with', () => {
    expect(skusOf([product('A'), enriched('B')], 'enrich')).toEqual(['A']);
  });

  it('enriches again a product whose text changed since its answer', () => {
    const stale = {
      ...enriched('A'),
      description: 'A description it was not enriched from',
    };

    expect(skusOf([stale], 'enrich')).toEqual(['A']);
  });

  it('enriches again a product whose enrichment failed', () => {
    const failed = { ...enriched('A'), enrichmentStatus: 'FAILED' };

    expect(skusOf([failed], 'enrich')).toEqual(['A']);
  });

  it('makes images only for products with a URL whose sizes are not made', () => {
    const products = [
      product('NONE'),
      product('NEW', { imageUrl: URL }),
      product('MADE', {
        imageUrl: URL,
        imageStatus: 'READY',
        imageSourceUrl: URL,
      }),
      product('REPLACED', {
        imageUrl: URL,
        imageStatus: 'READY',
        imageSourceUrl: 'https://shop.example/old.jpg',
      }),
      product('FAILED', {
        imageUrl: URL,
        imageStatus: 'FAILED',
        imageSourceUrl: URL,
      }),
    ];

    expect(skusOf(products, 'images')).toEqual(['NEW', 'REPLACED', 'FAILED']);
  });

  it('splits each stage at its batch size, in the order products came', () => {
    const products = Array.from({ length: 55 }, (_, index) =>
      product(`SKU-${index}`, { imageUrl: URL }),
    );

    expect(
      planned(products).map(({ stage, type, payload }) => ({
        stage,
        type,
        first: payload.skus[0],
        size: payload.skus.length,
      })),
    ).toEqual([
      { stage: 'enrich', type: 'ai.enrich', first: 'SKU-0', size: 20 },
      { stage: 'enrich', type: 'ai.enrich', first: 'SKU-20', size: 20 },
      { stage: 'enrich', type: 'ai.enrich', first: 'SKU-40', size: 15 },
      { stage: 'images', type: 'image.process', first: 'SKU-0', size: 50 },
      { stage: 'images', type: 'image.process', first: 'SKU-50', size: 5 },
    ]);
  });
});

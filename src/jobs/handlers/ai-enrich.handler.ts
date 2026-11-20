import { Inject, Injectable } from '@nestjs/common';
import { JobHandler, JobRateLimitedError } from '../job-handler.js';
import type { JobContext } from '../job-context.js';
import { aiEnrichPayloadSchema, type PayloadOf } from '../jobs.schema.js';
import { ProductsService } from '../../products/products.service.js';
import {
  LLM_PROVIDER,
  LlmRateLimitError,
  type EnrichmentInput,
  type LlmProvider,
  type LlmRequest,
} from '../../enrichment/llm-provider.js';
import {
  checkReply,
  type CheckedReply,
} from '../../enrichment/enrichment-reply.js';

const correctionFor = (problems: Map<string, string>) =>
  [...problems].map(([sku, problem]) => `${sku}: ${problem}`).join('\n');

@Injectable()
export class AiEnrichJobHandler extends JobHandler<PayloadOf<'ai.enrich'>> {
  readonly type = 'ai.enrich' as const;

  protected readonly payloadSchema = aiEnrichPayloadSchema;

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly products: ProductsService,
  ) {
    super();
  }

  protected async execute(
    context: JobContext,
    { skus }: PayloadOf<'ai.enrich'>,
  ) {
    const requested = [...new Set(skus)];
    const found = await this.products.forEnrichment(context.userId, requested);
    const { answers, problems } = await this.ask(
      // Only what the model needs: an id or an owner in the request would be
      // sent to the provider for nothing.
      found.map(({ sku, name, description }) => ({ sku, name, description })),
    );

    let enriched = 0;
    let failed = 0;
    let superseded = 0;

    for (const product of found) {
      const answer = answers.get(product.sku);
      // Recorded only while the product still has the text the model was
      // given; an import that changed it meanwhile wins.
      const recorded = answer
        ? await this.products.recordEnrichmentReady(
            context.userId,
            product,
            answer,
          )
        : await this.products.recordEnrichmentFailed(
            context.userId,
            product,
            problems.get(product.sku)!,
          );

      if (!recorded) {
        superseded += 1;
      } else if (answer) {
        enriched += 1;
      } else {
        failed += 1;
      }

      void context.reportProgress({
        processed: enriched + failed + superseded,
        total: found.length,
      });
    }

    const foundSkus = new Set(found.map(({ sku }) => sku));

    return {
      requested: requested.length,
      enriched,
      failed,
      superseded,
      notFound: requested.filter((sku) => !foundSkus.has(sku)),
    };
  }

  /**
   * Asks the model about `products`, then once more about those its reply
   * gave no usable answer for, saying what was wrong (§6.3d).
   *
   * @throws JobRateLimitedError when the provider is busy, or anything else
   * the provider throws, which fails the attempt.
   */
  private async ask(products: EnrichmentInput[]): Promise<CheckedReply> {
    if (products.length === 0) {
      return { answers: new Map(), problems: new Map() };
    }

    const first = checkReply(
      (await this.request({ products })).text,
      products.map(({ sku }) => sku),
    );

    if (first.problems.size === 0) {
      return first;
    }

    const again = products.filter(({ sku }) => first.problems.has(sku));
    const second = checkReply(
      (
        await this.request({
          products: again,
          correction: correctionFor(first.problems),
        })
      ).text,
      again.map(({ sku }) => sku),
    );

    return {
      answers: new Map([...first.answers, ...second.answers]),
      problems: second.problems,
    };
  }

  // A busy model pauses the queue rather than failing the attempt (§6.3d).
  private async request(request: LlmRequest) {
    try {
      return await this.llm.enrich(request);
    } catch (error) {
      throw error instanceof LlmRateLimitError
        ? new JobRateLimitedError(error.retryAfterMs)
        : error;
    }
  }
}

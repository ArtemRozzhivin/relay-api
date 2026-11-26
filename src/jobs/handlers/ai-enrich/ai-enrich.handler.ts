import { Inject, Injectable } from '@nestjs/common';
import { JobHandler, JobRateLimitedError } from '../../engine/job-handler.js';
import type { JobContext } from '../../engine/job-context.js';
import { aiEnrichPayloadSchema, type PayloadOf } from '../../jobs.schema.js';
import { ProductsService } from '../../../products/products.service.js';
import {
  LLM_PROVIDER,
  LlmRateLimitError,
  estimateCostUsd,
  type EnrichmentInput,
  type LlmProvider,
  type LlmReply,
} from '../../../enrichment/llm-provider.js';
import {
  checkReply,
  type CheckedReply,
  type Enrichment,
} from '../../../enrichment/enrichment-reply.js';
import { isEnrichedForCurrentText } from '../../../products/product-state.js';
import { ProductTally } from '../product-tally.js';

type Target = Awaited<ReturnType<ProductsService['forEnrichment']>>[number];

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

    // READY for the text it has now: asking again would pay for an answer it
    // already holds, which is what makes a re-run of an unchanged catalog
    // free (A21). A FAILED one is asked again: a model answers differently
    // from one request to the next, and naming the sku again is how its owner
    // asks.
    const todo = found.filter((product) => !isEnrichedForCurrentText(product));
    const tally = new ProductTally(context.checkpoint, [
      'enriched',
      'failed',
    ] as const);

    let handled = 0;

    const record = async (
      product: Target,
      outcome: { answer: Enrichment } | { problem: string },
    ) => {
      // Recorded only while the product still has the text the model was
      // given; an import that changed it meanwhile wins.
      if ('answer' in outcome) {
        await tally.conclude(context, product.id, 'enriched', (tx) =>
          this.products.recordEnrichmentReady(
            context.userId,
            product,
            outcome.answer,
            tx,
          ),
        );
      } else {
        await tally.conclude(context, product.id, 'failed', (tx) =>
          this.products.recordEnrichmentFailed(
            context.userId,
            product,
            outcome.problem,
            tx,
          ),
        );
      }

      handled += 1;
      void context.reportProgress({ processed: handled, total: todo.length });
    };

    const first = await this.ask(context, todo);

    // Before the corrective request, not after it: a 429 on that request runs
    // the job again, and the run after it skips what is recorded here.
    for (const product of todo) {
      const answer = first.answers.get(product.sku);

      if (answer) {
        await record(product, { answer });
      }
    }

    const again = todo.filter(({ sku }) => first.problems.has(sku));
    const second = await this.ask(
      context,
      again,
      correctionFor(first.problems),
    );

    for (const product of again) {
      const answer = second.answers.get(product.sku);

      await record(
        product,
        answer ? { answer } : { problem: second.problems.get(product.sku)! },
      );
    }

    const foundSkus = new Set(found.map(({ sku }) => sku));

    return {
      requested: requested.length,
      // Across this job's attempts: a 429 on the corrective request runs the
      // job again, and that run skips what the first answer recorded.
      enriched: tally.count('enriched'),
      failed: tally.count('failed'),
      superseded: tally.count('superseded'),
      // Ready before this job got to it — not by any attempt of its own.
      alreadyReady: found.filter(
        (product) =>
          isEnrichedForCurrentText(product) && !tally.has(product.id),
      ).length,
      notFound: requested.filter((sku) => !foundSkus.has(sku)),
    };
  }

  /**
   * Asks the model about `products`, and checks its reply (§6.3d). With
   * `correction`, it is the one corrective request a batch gets, saying what
   * was wrong with the reply before. Asks nothing about no products.
   *
   * @throws JobRateLimitedError when the provider is busy, or anything else
   * the provider throws, which fails the attempt.
   */
  private async ask(
    context: JobContext,
    products: Target[],
    correction?: string,
  ): Promise<CheckedReply> {
    if (products.length === 0) {
      return { answers: new Map(), problems: new Map() };
    }

    context.log(
      correction === undefined
        ? `asking the model about ${products.length} product(s)`
        : `asking the model again about ${products.length} product(s), saying what was wrong`,
    );

    // Only what the model needs: an id or an owner in the request would be
    // sent to the provider for nothing.
    const sent: EnrichmentInput[] = products.map(
      ({ sku, name, description }) => ({ sku, name, description }),
    );

    let reply: LlmReply;

    try {
      reply = await this.llm.enrich({
        products: sent,
        ...(correction === undefined ? {} : { correction }),
      });
    } catch (error) {
      // A busy model pauses the queue rather than failing the attempt.
      throw error instanceof LlmRateLimitError
        ? new JobRateLimitedError(error.retryAfterMs)
        : error;
    }

    // Before the reply is checked: a reply that fails every check was paid
    // for like any other.
    await context.recordModelUsage({
      tokensIn: reply.tokensIn,
      tokensOut: reply.tokensOut,
      estimatedCostUsd: estimateCostUsd(this.llm.price, reply),
    });

    return checkReply(
      reply.text,
      products.map(({ sku }) => sku),
    );
  }
}

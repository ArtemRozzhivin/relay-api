import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { JobCancelledError, JobHandler } from '../job-handler.js';
import type { JobContext } from '../job-context.js';
import { imageProcessPayloadSchema, type PayloadOf } from '../jobs.schema.js';
import {
  DownloadFailedError,
  GuardedDownloader,
  type DownloadLimits,
} from '../../outbound/guarded-download.js';
import { StorageService } from '../../storage/storage.service.js';
import { productImageKey } from '../../storage/object-keys.js';
import { ProductsService } from '../../products/products.service.js';
import { renderSizes } from '../../images/image-variants.js';
import { RetryableJobError } from '../../common/errors/app-error.js';

// What a seller uploads and sharp decodes. Not SVG: it is a document that can
// refer to other files, and rendering one runs a parser on the seller's input.
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const DOWNLOAD_LIMITS: DownloadLimits = {
  // Long enough for a slow storefront to send a large photo, short enough that
  // a server that stopped answering costs one attempt rather than the batch.
  timeoutMs: 15_000,
  // Several times a product photo; past it, a file is not one.
  maxBytes: 10 * 1024 * 1024,
  maxRedirects: 3,
  accepts: (contentType) => IMAGE_TYPES.has(contentType),
};

type Made =
  | { sizes: Awaited<ReturnType<typeof renderSizes>> }
  | { reason: string; permanent: boolean };

@Injectable()
export class ImageProcessJobHandler extends JobHandler<
  PayloadOf<'image.process'>
> {
  readonly type = 'image.process' as const;

  protected readonly payloadSchema = imageProcessPayloadSchema;

  constructor(
    private readonly downloader: GuardedDownloader,
    private readonly storage: StorageService,
    private readonly products: ProductsService,
  ) {
    super();
  }

  protected async execute(
    context: JobContext,
    { skus }: PayloadOf<'image.process'>,
  ) {
    const requested = [...new Set(skus)];
    const found = await this.products.forImages(context.userId, requested);

    // A product whose current URL already has its sizes is skipped, which is
    // what lets a retry, a redelivery or a re-drive redo only the rest. A
    // FAILED one is tried again: the seller may have fixed the file behind the
    // same URL, and naming the sku again is how they ask.
    const todo = found.flatMap((product) =>
      product.imageUrl !== null &&
      !(
        product.imageSourceUrl === product.imageUrl &&
        product.imageStatus === 'READY'
      )
        ? [{ id: product.id, imageUrl: product.imageUrl }]
        : [],
    );

    let processed = 0;
    let failed = 0;
    let superseded = 0;
    let retrying = 0;
    let firstRetryReason = '';

    for (const product of todo) {
      const made = await this.sizesOf(product.imageUrl);
      let recorded: boolean | null = null;

      if ('sizes' in made) {
        for (const size of made.sizes) {
          await this.storage.upload(
            productImageKey(
              context.userId,
              product.id,
              product.imageUrl,
              size.name,
            ),
            Readable.from([size.body]),
            { contentType: 'image/webp' },
          );
        }

        // Written to S3 first and recorded second: a crash in between leaves
        // files nothing points at yet, which the next run overwrites with the
        // same bytes — never a row pointing at files that are not there.
        recorded = await this.products.recordImageReady(
          context.userId,
          product.id,
          product.imageUrl,
        );
        processed += recorded ? 1 : 0;
      } else if (made.permanent || context.lastAttempt) {
        recorded = await this.products.recordImageFailed(
          context.userId,
          product.id,
          product.imageUrl,
          // One that might pass later is recorded as it stands when no retry
          // is coming; left PENDING, nothing would ever finish it.
          made.permanent
            ? made.reason
            : `Gave up after ${context.attempt} ${context.attempt === 1 ? 'attempt' : 'attempts'}: ${made.reason}`,
        );
        failed += recorded ? 1 : 0;
      } else {
        // Left PENDING and passed over, not thrown: one slow host would
        // otherwise hold back every product after it, on every attempt.
        retrying += 1;
        firstRetryReason ||= made.reason;
      }

      superseded += recorded === false ? 1 : 0;

      void context.reportProgress({
        processed: processed + failed + superseded + retrying,
        total: todo.length,
      });

      // Between products, never inside one: a stopped batch has recorded
      // whole images only.
      if (await context.shouldStop()) {
        throw new JobCancelledError();
      }
    }

    // Retried like any failure: the next attempt skips what this one made and
    // tries only these again. A RetryableJobError, so its owner reads why.
    if (retrying > 0) {
      throw new RetryableJobError(
        `${retrying} of ${todo.length} images could not be downloaded this time (${firstRetryReason})`,
      );
    }

    const foundSkus = new Set(found.map(({ sku }) => sku));

    return {
      requested: requested.length,
      processed,
      failed,
      // Its imageUrl changed while this job worked on the old one; the newer
      // URL is the next run's to process.
      superseded,
      alreadyReady: found.length - todo.length - countWithoutImage(found),
      withoutImage: countWithoutImage(found),
      notFound: requested.filter((sku) => !foundSkus.has(sku)),
    };
  }

  /**
   * The sizes of the image at `url`, or why there are none. `permanent` when
   * another try would get the same answer — a 404, a file that is not an
   * image — so the product is marked FAILED rather than tried again.
   *
   * @throws anything that is not about the image itself, which fails the
   * attempt.
   */
  private async sizesOf(url: string): Promise<Made> {
    let body: Buffer;

    try {
      ({ body } = await this.downloader.download(url, DOWNLOAD_LIMITS));
    } catch (error) {
      if (error instanceof DownloadFailedError) {
        return { reason: error.message, permanent: error.permanent };
      }

      throw error;
    }

    try {
      return { sizes: await renderSizes(body) };
    } catch (error) {
      // The same bytes decode the same way every time.
      return {
        reason: `Not a readable image: ${(error as Error).message}`,
        permanent: true,
      };
    }
  }
}

const countWithoutImage = (products: { imageUrl: string | null }[]) =>
  products.filter(({ imageUrl }) => imageUrl === null).length;

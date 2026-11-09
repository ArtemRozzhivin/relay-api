import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { JobCancelledError, JobHandler } from '../job-handler.js';
import type { JobContext } from '../job-context.js';
import { imageProcessPayloadSchema, type PayloadOf } from '../jobs.schema.js';
import {
  GuardedDownloader,
  type DownloadLimits,
} from '../../outbound/guarded-download.js';
import { StorageService } from '../../storage/storage.service.js';
import { productImageKey } from '../../storage/object-keys.js';
import { ProductsService } from '../../products/products.service.js';
import { renderSizes } from '../../images/image-variants.js';

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
    // what lets a retry, a redelivery or a re-drive redo only the rest.
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
    let superseded = 0;

    for (const product of todo) {
      const { body } = await this.downloader.download(
        product.imageUrl,
        DOWNLOAD_LIMITS,
      );

      for (const size of await renderSizes(body)) {
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
      if (
        await this.products.recordImageReady(
          context.userId,
          product.id,
          product.imageUrl,
        )
      ) {
        processed += 1;
      } else {
        superseded += 1;
      }

      void context.reportProgress({
        processed: processed + superseded,
        total: todo.length,
      });

      // Between products, never inside one: a stopped batch has recorded
      // whole images only.
      if (await context.shouldStop()) {
        throw new JobCancelledError();
      }
    }

    const foundSkus = new Set(found.map(({ sku }) => sku));

    return {
      requested: requested.length,
      processed,
      // Its imageUrl changed while this job worked on the old one; the newer
      // URL is the next run's to process.
      superseded,
      alreadyReady: found.length - todo.length - countWithoutImage(found),
      withoutImage: countWithoutImage(found),
      notFound: requested.filter((sku) => !foundSkus.has(sku)),
    };
  }
}

const countWithoutImage = (products: { imageUrl: string | null }[]) =>
  products.filter(({ imageUrl }) => imageUrl === null).length;

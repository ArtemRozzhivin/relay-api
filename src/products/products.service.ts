import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma, Product } from '../generated/prisma/client.js';
import { toPage } from '../common/pagination/cursor.js';
import { StorageService } from '../storage/storage.service.js';
import { productImageKey } from '../storage/object-keys.js';
import { IMAGE_SIZES, type ImageSize } from '../images/image-variants.js';
import type { ListProductsQuery } from './products.schema.js';
import { hashEnrichmentInput } from '../enrichment/enrichment-input.js';
import type { Enrichment } from '../enrichment/enrichment-reply.js';

/** One product as an import writes it, after its row has been validated. */
// Signed per page, never stored: a stored link would have expired by the time
// anyone opened it. An hour outlives any page a client keeps open.
const IMAGE_LINK_SECONDS = 3600;

/** A product's image as a client sees it. */
export type ProductImage =
  | { status: 'PENDING' }
  | ({ status: 'READY' } & Record<ImageSize, string>)
  | { status: 'FAILED'; error: string | null };

/** A product's enrichment as a client sees it. */
export type ProductEnrichment =
  | { status: 'PENDING' }
  | ({ status: 'READY' } & Enrichment)
  | { status: 'FAILED'; error: string | null };

/** The text a product was enriched from, which its record is conditional on. */
interface EnrichedFrom {
  id: string;
  name: string;
  description: string | null;
}

export interface ProductRow {
  sku: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  imageUrl: string | null;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * The caller's catalog in sku order, one page per call (D14). Read from the
   * `(userId, sku)` index the import already matches on, so a page deep in a
   * 20 000-product catalog costs what the first one does.
   */
  async findMany(userId: string, { limit, cursor }: ListProductsQuery) {
    const rows = await this.prisma.product.findMany({
      where: {
        userId,
        ...(cursor ? { sku: { gt: cursor.sku } } : {}),
      },
      orderBy: { sku: 'asc' },
      take: limit + 1,
    });

    const page = toPage(rows, limit, (product) => ({ sku: product.sku }));

    return {
      ...page,
      items: await Promise.all(
        page.items.map((product) => this.toView(product)),
      ),
    };
  }

  /**
   * The caller's products among `skus`, with what image.process needs to know
   * about each. A sku the caller has no product for is simply absent.
   */
  forImages(userId: string, skus: string[]) {
    return this.prisma.product.findMany({
      where: { userId, sku: { in: skus } },
      select: {
        id: true,
        sku: true,
        imageUrl: true,
        imageStatus: true,
        imageSourceUrl: true,
      },
      // The same order on every attempt, so progress means the same thing.
      orderBy: { sku: 'asc' },
    });
  }

  /**
   * Records that the image at `sourceUrl` is ready — only while it is still the
   * product's `imageUrl`. An import that replaced the URL meanwhile wins: this
   * result describes an image the product no longer has.
   *
   * @param client the transaction the job's tally is written in, so the
   * product and its count commit together.
   * @returns whether it was recorded.
   */
  recordImageReady(
    userId: string,
    productId: string,
    sourceUrl: string,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    return this.recordImage(
      client,
      userId,
      productId,
      sourceUrl,
      'READY',
      null,
    );
  }

  /**
   * Records that the image at `sourceUrl` cannot be made, and why — under the
   * same condition as `recordImageReady`. `error` is shown to the product's
   * owner.
   *
   * @returns whether it was recorded.
   */
  recordImageFailed(
    userId: string,
    productId: string,
    sourceUrl: string,
    error: string,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    return this.recordImage(
      client,
      userId,
      productId,
      sourceUrl,
      'FAILED',
      error,
    );
  }

  /**
   * The caller's products among `skus`, with the text ai.enrich sends and what
   * their last enrichment was made from. A sku the caller has no product for
   * is simply absent.
   */
  /**
   * What a pipeline's import needs to decide which of `skus` still need an
   * enrichment or an image (§6.3e). In no particular order: the caller puts
   * them in the file's.
   */
  forPipeline(userId: string, skus: string[]) {
    return this.prisma.product.findMany({
      where: { userId, sku: { in: skus } },
      select: {
        sku: true,
        name: true,
        description: true,
        enrichmentStatus: true,
        enrichmentInputHash: true,
        imageUrl: true,
        imageStatus: true,
        imageSourceUrl: true,
      },
    });
  }

  forEnrichment(userId: string, skus: string[]) {
    return this.prisma.product.findMany({
      where: { userId, sku: { in: skus } },
      select: {
        id: true,
        sku: true,
        name: true,
        description: true,
        enrichmentStatus: true,
        enrichmentInputHash: true,
      },
      orderBy: { sku: 'asc' },
    });
  }

  /**
   * Records a product's category and tags — only while it still has the name
   * and description they were made from. An import that changed either
   * meanwhile wins: the answer is about text the product no longer has.
   *
   * @param client the transaction the job's tally is written in, so the
   * product and its count commit together.
   * @returns whether it was recorded.
   */
  recordEnrichmentReady(
    userId: string,
    product: EnrichedFrom,
    { category, tags }: Enrichment,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    return this.recordEnrichment(client, userId, product, {
      enrichmentStatus: 'READY',
      enrichmentError: null,
      category,
      tags,
    });
  }

  /**
   * Records that the model gave no usable answer for a product, and why, under
   * the same condition as `recordEnrichmentReady`. `error` is shown to the
   * product's owner. Clears any earlier category and tags, which were made from
   * older text.
   *
   * @returns whether it was recorded.
   */
  recordEnrichmentFailed(
    userId: string,
    product: EnrichedFrom,
    error: string,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    return this.recordEnrichment(client, userId, product, {
      enrichmentStatus: 'FAILED',
      enrichmentError: error,
      category: null,
      tags: [],
    });
  }

  private async recordEnrichment(
    client: Prisma.TransactionClient,
    userId: string,
    { id, name, description }: EnrichedFrom,
    data: Prisma.ProductUpdateManyMutationInput,
  ) {
    const { count } = await client.product.updateMany({
      where: { id, userId, name, description },
      data: {
        ...data,
        enrichmentInputHash: hashEnrichmentInput({ name, description }),
      },
    });

    return count === 1;
  }

  private async recordImage(
    client: Prisma.TransactionClient,
    userId: string,
    productId: string,
    sourceUrl: string,
    status: 'READY' | 'FAILED',
    error: string | null,
  ) {
    const { count } = await client.product.updateMany({
      where: { id: productId, userId, imageUrl: sourceUrl },
      data: {
        imageStatus: status,
        imageSourceUrl: sourceUrl,
        imageError: error,
      },
    });

    return count === 1;
  }

  // The image columns describe the URL they were concluded for; the client is
  // told what they mean for the URL the product has now.
  private async toView({
    imageStatus,
    imageSourceUrl,
    imageError,
    enrichmentStatus,
    enrichmentInputHash,
    enrichmentError,
    category,
    tags,
    ...product
  }: Product) {
    let image: ProductImage | null = null;

    if (product.imageUrl === null) {
      image = null;
    } else if (imageSourceUrl !== product.imageUrl) {
      image = { status: 'PENDING' };
    } else if (imageStatus === 'FAILED') {
      image = { status: 'FAILED', error: imageError };
    } else {
      const links = await Promise.all(
        IMAGE_SIZES.map(async ({ name }) => {
          const { url } = await this.storage.signDownload(
            productImageKey(product.userId, product.id, imageSourceUrl, name),
            IMAGE_LINK_SECONDS,
          );

          return [name, url];
        }),
      );

      image = {
        status: 'READY',
        ...(Object.fromEntries(links) as Record<ImageSize, string>),
      };
    }

    let enrichment: ProductEnrichment;

    // Never enriched, or enriched from text the product has since replaced:
    // either way there is no answer for what it says now.
    if (enrichmentInputHash !== hashEnrichmentInput(product)) {
      enrichment = { status: 'PENDING' };
    } else if (enrichmentStatus === 'FAILED') {
      enrichment = { status: 'FAILED', error: enrichmentError };
    } else {
      enrichment = { status: 'READY', category: category!, tags };
    }

    return { ...product, image, enrichment };
  }

  /**
   * Writes a batch of one store's products in a single statement: a new sku is
   * inserted, a known one takes the newer values, and nothing is deleted
   * (D30). Writing the same batch twice leaves the table as one write did,
   * which is what lets an interrupted import replay its last batch (A14).
   *
   * A sku that appears twice in the batch is written once, with its last
   * values — what it would get had the two rows arrived in different batches.
   * Postgres refuses to update one row twice in one statement, so duplicates
   * are folded here rather than left to fail the whole batch.
   *
   * @param client the transaction the import's checkpoint is written in, so
   * the rows and the position they bring the import to commit together (D26).
   * @returns how many rows the statement inserted or updated.
   */
  upsertBatch(
    userId: string,
    rows: ProductRow[],
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    // Keyed by sku, so a later row with the same sku replaces the earlier one.
    const lastRowPerSku = new Map<string, ProductRow>();

    for (const row of rows) {
      lastRowPerSku.set(row.sku, row);
    }

    const batch = [...lastRowPerSku.values()];

    if (batch.length === 0) {
      return Promise.resolve(0);
    }

    // One array per column, not a VALUES list: six parameters whatever the
    // batch size, so the statement text never changes and the batch can never
    // reach Postgres's cap on parameters per query.
    return client.$executeRaw`
      INSERT INTO "Product"
        ("userId", "sku", "name", "description", "priceCents", "currency", "imageUrl", "updatedAt")
      SELECT ${userId}::uuid, r.sku, r.name, r.description, r.price_cents, r.currency, r.image_url, now()
      FROM unnest(
        ${batch.map((row) => row.sku)}::text[],
        ${batch.map((row) => row.name)}::text[],
        ${batch.map((row) => row.description)}::text[],
        ${batch.map((row) => row.priceCents)}::int[],
        ${batch.map((row) => row.currency)}::text[],
        ${batch.map((row) => row.imageUrl)}::text[]
      ) AS r(sku, name, description, price_cents, currency, image_url)
      -- Each row is locked as it is written, so two imports into one store
      -- writing the same skus in different orders could each hold a row the
      -- other waits for (40P01). In one order, the second simply waits.
      ORDER BY r.sku
      ON CONFLICT ("userId", "sku") DO UPDATE SET
        "name" = EXCLUDED."name",
        "description" = EXCLUDED."description",
        "priceCents" = EXCLUDED."priceCents",
        "currency" = EXCLUDED."currency",
        "imageUrl" = EXCLUDED."imageUrl",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }
}

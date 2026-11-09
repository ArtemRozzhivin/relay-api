import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { toPage } from '../common/pagination/cursor.js';
import type { ListProductsQuery } from './products.schema.js';

/** One product as an import writes it, after its row has been validated. */
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
  constructor(private readonly prisma: PrismaService) {}

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

    return toPage(rows, limit, (product) => ({ sku: product.sku }));
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

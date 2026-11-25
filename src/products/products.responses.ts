import { z } from 'zod';
import { ProductCategory } from '../generated/prisma/enums.js';
import { instant, page } from '../docs/openapi-schemas.js';

const image = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('PENDING') }).strict(),
    z
      .object({
        status: z.literal('READY'),
        thumb: z.url(),
        medium: z.url(),
        large: z.url(),
      })
      .strict(),
    z
      .object({ status: z.literal('FAILED'), error: z.string().nullable() })
      .strict(),
  ])
  .nullable()
  .describe('`null` without an `imageUrl`; links are signed for an hour');

const enrichment = z.discriminatedUnion('status', [
  z.object({ status: z.literal('PENDING') }).strict(),
  z
    .object({
      status: z.literal('READY'),
      category: z.enum(ProductCategory),
      tags: z.array(z.string()),
    })
    .strict(),
  z
    .object({ status: z.literal('FAILED'), error: z.string().nullable() })
    .strict(),
]);

export const productView = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    sku: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    priceCents: z.number().int(),
    currency: z.string(),
    imageUrl: z.string().nullable(),
    image,
    enrichment,
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();

export const productPage = page(productView);

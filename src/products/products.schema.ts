import { z } from 'zod';
import { cursorParam, limitParam } from '../common/pagination/cursor.js';

export const listProductsSchema = z
  .object({
    limit: limitParam,
    // The last product a page held. Its sku alone is a position: it is unique
    // within an account, which is all the list is ever filtered to.
    cursor: cursorParam(
      z.object({ sku: z.string().min(1).max(100) }),
    ).optional(),
  })
  .strict();

export type ListProductsQuery = z.infer<typeof listProductsSchema>;

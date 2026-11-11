import { z } from 'zod';
import { cursorParam, limitParam } from '../common/pagination/cursor.js';
import { storableText } from '../common/validation/storable-text.js';

/** The longest sku a product can have, wherever a sku comes in. */
export const SKU_MAX_LENGTH = 100;

export const listProductsSchema = z
  .object({
    limit: limitParam,
    // The last product a page held. Its sku alone is a position: it is unique
    // within an account, which is all the list is ever filtered to.
    cursor: cursorParam(
      z.object({ sku: storableText().min(1).max(SKU_MAX_LENGTH) }),
      SKU_MAX_LENGTH,
    ).optional(),
  })
  .strict();

export type ListProductsQuery = z.infer<typeof listProductsSchema>;

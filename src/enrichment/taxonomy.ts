import { ProductCategory } from '../generated/prisma/enums.js';

/**
 * The categories a product can be given (§6.3d), from the database's own enum,
 * so a list in code and a list in Postgres cannot drift apart. A model's
 * answer outside it is refused, however plausible it reads.
 */
export const CATEGORIES = Object.values(ProductCategory);

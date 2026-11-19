/**
 * The categories a product can be given (§6.3d). A model's answer outside
 * this list is refused, however plausible it reads.
 */
export const CATEGORIES = [
  'apparel',
  'footwear',
  'accessories',
  'beauty',
  'home',
  'kitchen',
  'electronics',
  'toys',
  'sports',
  'books',
  'food',
  // A model made to choose from a list with no way out picks a wrong
  // category, and nothing could tell it from a right one.
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

import { createHash, randomUUID } from 'node:crypto';

// Every key the bucket holds is built here, each under its account's id, so
// what belongs to whom is readable from the key alone.

/**
 * Where a user's uploads live. One prefix per account, so whether a key is the
 * caller's own is a string comparison rather than a lookup.
 */
export const uploadPrefix = (userId: string) => `uploads/${userId}/`;

/** A fresh key for one upload, minted by the server and never by the client. */
export const mintUploadKey = (userId: string) =>
  `${uploadPrefix(userId)}${randomUUID()}.csv`;

/** The shape {@link mintUploadKey} produces, and so the only shape an upload key can have. */
export const UPLOAD_KEY_PATTERN =
  /^uploads\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.csv$/;

/** Where every image made for an account's products lives. */
export const productImagesPrefix = (userId: string) => `products/${userId}/`;

/**
 * Where one size of a product's image lives. Under the URL it was made from as
 * well as the product: a slow job still working on a URL the seller has since
 * replaced writes beside the new image rather than over it, and the product
 * row says which one is current. Deterministic, so a re-run overwrites its own
 * files with the same bytes.
 */
export const productImageKey = (
  userId: string,
  productId: string,
  sourceUrl: string,
  size: string,
) =>
  `${productImagesPrefix(userId)}${productId}/${createHash('sha256')
    .update(sourceUrl)
    .digest('hex')
    .slice(0, 16)}/${size}.webp`;

/**
 * Where an import's error report lives: one per job, so a re-run overwrites
 * the report rather than adding a second.
 */
export const errorReportKey = (userId: string, jobId: string) =>
  `reports/${userId}/${jobId}.csv`;

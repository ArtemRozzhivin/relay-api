import { randomUUID } from 'node:crypto';

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

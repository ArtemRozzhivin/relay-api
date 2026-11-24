import { z } from 'zod';
import { ApiKeyScope } from '../generated/prisma/enums.js';
import { storableText } from '../common/validation/storable-text.js';
import { cursorParam, limitParam } from '../common/pagination/cursor.js';

export const createApiKeySchema = z
  .object({
    name: storableText().trim().min(1).max(100),
    // A set: naming a scope twice asks for the same key as naming it once.
    scopes: z
      .array(z.enum(ApiKeyScope))
      .min(1)
      .transform((scopes) => [...new Set(scopes)]),
  })
  .strict();

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const apiKeyIdSchema = z.uuid();

// Every account's keys when `email` is left out: the filter is the operator's
// to narrow, and a revoke of everything is what a leak of the table needs.
export const revokeMatchingSchema = z
  .object({
    email: z.email().optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();

export type RevokeMatchingInput = z.infer<typeof revokeMatchingSchema>;

// The operator's list of every account's keys, as GET /jobs pages: newest
// first, by `(createdAt, id)`.
export const listAllApiKeysSchema = z
  .object({
    email: z.email().optional(),
    status: z.enum(['active', 'revoked']).optional(),
    limit: limitParam,
    cursor: cursorParam(
      z.object({
        createdAt: z.iso
          .datetime({ offset: true })
          .transform((value) => new Date(value)),
        id: z.uuid(),
      }),
      // An ISO instant and a uuid.
      24 + 36,
    ).optional(),
  })
  .strict();

export type ListAllApiKeysQuery = z.infer<typeof listAllApiKeysSchema>;

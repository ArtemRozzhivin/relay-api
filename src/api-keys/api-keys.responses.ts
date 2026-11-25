import { z } from 'zod';
import { ApiKeyScope } from '../generated/prisma/enums.js';
import { instant } from '../docs/openapi-schemas.js';

export const apiKeyView = z
  .object({
    id: z.uuid(),
    name: z.string(),
    prefix: z.string().describe('The first 12 characters, to tell keys apart'),
    scopes: z.array(z.enum(ApiKeyScope)),
    createdAt: instant,
    lastUsedAt: instant.nullable(),
    revokedAt: instant.nullable(),
  })
  .strict();

export const createdApiKeyView = apiKeyView
  .extend({
    key: z
      .string()
      .describe('The secret. In this response and nowhere else: keep it now'),
  })
  .strict();

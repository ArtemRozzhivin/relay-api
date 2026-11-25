import { z } from 'zod';
import { Role } from '../generated/prisma/enums.js';
import { instant } from '../docs/openapi-schemas.js';

export const userView = z
  .object({
    id: z.uuid(),
    email: z.email(),
    role: z.enum(Role),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();

export const tokensView = z
  .object({
    accessToken: z.string().describe('A JWT, for `Authorization: Bearer`'),
    refreshToken: z.string(),
  })
  .strict();

export const signedInView = tokensView.extend({ user: userView }).strict();

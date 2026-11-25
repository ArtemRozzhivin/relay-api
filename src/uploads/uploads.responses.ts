import { z } from 'zod';
import { instant } from '../docs/openapi-schemas.js';

export const uploadSlipView = z
  .object({
    key: z.string().describe('What an import or a pipeline names the file by'),
    url: z.url().describe('Where to POST the file, as multipart form data'),
    fields: z
      .record(z.string(), z.string())
      .describe('The form fields to send with it, before the file'),
    expiresAt: instant,
    maxBytes: z.number().int(),
  })
  .strict();

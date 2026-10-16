import { z } from 'zod';

const mockPayloadSchema = z
  .object({
    durationMs: z.coerce.number().int().min(0).max(60_000).default(10),
    failureRate: z.coerce.number().min(0).max(1).default(0),
  })
  .strict();

const chargePayloadSchema = z
  .object({
    amountCents: z.coerce.number().int().positive(),
    reference: z.string().min(1).max(200),
  })
  .strict();

const maxAttemptsSchema = z.coerce.number().int().min(1).max(20).default(5);

export const submitJobSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('MOCK'),
      payload: mockPayloadSchema,
      maxAttempts: maxAttemptsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('CHARGE'),
      payload: chargePayloadSchema,
      maxAttempts: maxAttemptsSchema,
    })
    .strict(),
]);

export const listJobsSchema = z
  .object({
    status: z
      .enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'DEAD_LETTERED'])
      .optional(),
    type: z.enum(['MOCK', 'CHARGE']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const jobIdSchema = z.uuid();

export type SubmitJobInput = z.infer<typeof submitJobSchema>;
export type ListJobsQuery = z.infer<typeof listJobsSchema>;

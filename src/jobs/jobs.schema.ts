import { z } from 'zod';

// The payload schemas tolerate unknown keys: the worker re-parses the stored
// payload (§6.4), and a job written by a newer deploy can reach an older worker.
// An added field must be ignored there, not dead-letter the job. `.strict()` is
// applied below, on the submit body, where an unknown key is a client mistake
// worth a 400.
export const mockPayloadSchema = z.object({
  durationMs: z.coerce.number().int().min(0).max(60_000).default(10),
  failureRate: z.coerce.number().min(0).max(1).default(0),
  // Splits the sleep into reporting intervals: a mock job is the only job that
  // can exercise progress until the CSV import exists (PB).
  steps: z.coerce.number().int().min(1).max(100).default(1),
});

export const chargePayloadSchema = z.object({
  amountCents: z.coerce.number().int().positive(),
  reference: z.string().min(1).max(200),
  delayMs: z.coerce.number().int().min(0).max(60_000).default(0),
});

const maxAttemptsSchema = z.coerce.number().int().min(1).max(20).default(5);

export const submitJobSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('MOCK'),
      payload: mockPayloadSchema.strict(),
      maxAttempts: maxAttemptsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('CHARGE'),
      payload: chargePayloadSchema.strict(),
      maxAttempts: maxAttemptsSchema,
    })
    .strict(),
]);

export type SubmitJobInput = z.infer<typeof submitJobSchema>;
export type JobType = SubmitJobInput['type'];
export type PayloadOf<T extends JobType> = Extract<
  SubmitJobInput,
  { type: T }
>['payload'];

// Derived from the union rather than written beside it: a job type exists in
// exactly one place, so the list cannot drift from what submit() accepts.
export const JOB_TYPES: readonly JobType[] = submitJobSchema.options.map(
  (option) => option.shape.type.value,
);

export const listJobsSchema = z
  .object({
    status: z
      .enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'DEAD_LETTERED'])
      .optional(),
    type: z.enum(JOB_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const jobIdSchema = z.uuid();

export type ListJobsQuery = z.infer<typeof listJobsSchema>;

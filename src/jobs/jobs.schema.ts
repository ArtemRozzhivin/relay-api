import { z } from 'zod';
import { JobStatus } from '../generated/prisma/enums.js';
import { DEAD_LETTER_CODES } from './job-error-codes.js';
import { UPLOAD_KEY_PATTERN } from '../storage/object-keys.js';
import { cursorParam, limitParam } from '../common/pagination/cursor.js';

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

// Whose upload it is cannot be known here, only its shape; the submit and the
// handler both check the prefix against the job's owner.
export const importCsvPayloadSchema = z.object({
  key: z
    .string()
    .regex(UPLOAD_KEY_PATTERN, 'expected a key from POST /uploads'),
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
  z
    .object({
      type: z.literal('import.csv'),
      payload: importCsvPayloadSchema.strict(),
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
    // From the generated enum rather than a literal list: adding CANCELLED
    // would otherwise have left jobs in that state unfilterable.
    status: z.enum(JobStatus).optional(),
    type: z.enum(JOB_TYPES).optional(),
    limit: limitParam,
    // The last job a page held, by the two values the list is ordered on.
    cursor: cursorParam(
      z.object({
        createdAt: z.iso.datetime().pipe(z.coerce.date()),
        id: z.uuid(),
      }),
    ).optional(),
  })
  .strict();

// A timezone is required, not assumed: "re-drive what died between 02:00 and
// 03:00" is off by hours if the server and the operator disagree on which 02:00.
// z.coerce.date() would also accept "1" and read it as the year 2001.
const instant = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const bulkRedriveSchema = z
  .object({
    type: z.enum(JOB_TYPES).optional(),
    errorCode: z.enum(DEAD_LETTER_CODES).optional(),
    // When the job was dead-lettered — its `finishedAt` — not when it was
    // submitted: an outage is a window in which jobs died. Half-open, so two
    // adjacent windows never re-drive the same job twice.
    deadLetteredFrom: instant.optional(),
    deadLetteredTo: instant.optional(),
    // Bounded per call, so no single transaction holds thousands of row locks
    // until it commits. The response says how many still match.
    limit: z.number().int().min(1).max(1000).default(500),
    dryRun: z.boolean().default(false),
  })
  .strict()
  .refine(
    (filter) =>
      filter.type !== undefined ||
      filter.errorCode !== undefined ||
      filter.deadLetteredFrom !== undefined ||
      filter.deadLetteredTo !== undefined,
    {
      // An empty body is what a client bug sends, and it would mean "every
      // dead letter you have". Meaning that takes saying so, with a window.
      message: 'At least one filter is required',
    },
  )
  .refine(
    (filter) =>
      filter.deadLetteredFrom === undefined ||
      filter.deadLetteredTo === undefined ||
      filter.deadLetteredFrom < filter.deadLetteredTo,
    { message: 'deadLetteredFrom must be before deadLetteredTo' },
  );

export type BulkRedriveInput = z.infer<typeof bulkRedriveSchema>;

export const jobIdSchema = z.uuid();

// Resuming is the default and needs no word for it (D26); a restart is the one
// a caller has to ask for.
export const redriveQuerySchema = z
  .object({ from: z.literal('start').optional() })
  .strict();

export type RedriveQuery = z.infer<typeof redriveQuerySchema>;

export type ListJobsQuery = z.infer<typeof listJobsSchema>;

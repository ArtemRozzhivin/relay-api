import { z } from 'zod';
import { JobStatus } from '../generated/prisma/enums.js';
import { DEAD_LETTER_CODES } from './engine/job-error-codes.js';
import { UPLOAD_KEY_PATTERN } from '../storage/object-keys.js';
import { cursorParam, limitParam } from '../common/pagination/cursor.js';
import { storableText } from '../common/validation/storable-text.js';
import { SKU_MAX_LENGTH } from '../products/products.schema.js';

// The payload schemas tolerate unknown keys: the worker re-parses the stored
// payload (§6.4), and a job written by a newer deploy can reach an older worker.
// An added field must be ignored there, not dead-letter the job. `.strict()` is
// applied below, on the submit body, where an unknown key is a client mistake
// worth a 400.
export const mockPayloadSchema = z.object({
  durationMs: z.coerce.number().int().min(0).max(60_000).default(10),
  failureRate: z.coerce.number().min(0).max(1).default(0),
  // Splits the sleep into reporting intervals. Real jobs report too, but only a
  // mock job reports at a rate and timing a test can choose, which A12 and A12b
  // depend on.
  steps: z.coerce.number().int().min(1).max(100).default(1),
});

// Whose upload it is cannot be known here, only its shape; the submit and the
// handler both check the prefix against the job's owner.
export const importCsvPayloadSchema = z.object({
  key: z
    .string()
    .regex(UPLOAD_KEY_PATTERN, 'expected a key from POST /uploads'),
});

// A batch: not one product per job, which would make a 20 000-product catalog
// 20 000 jobs, and not the whole catalog, where one slow image would hold up
// every other. Which of the skus are the caller's is the handler's to find out.
export const IMAGE_BATCH_MAX = 50;

export const imageProcessPayloadSchema = z.object({
  skus: z
    .array(storableText().trim().min(1).max(SKU_MAX_LENGTH))
    .min(1)
    .max(IMAGE_BATCH_MAX),
});

// Fewer than an image batch: the whole batch goes to the model in one request,
// whose size and price grow with every product in it.
export const ENRICH_BATCH_MAX = 20;

export const aiEnrichPayloadSchema = z.object({
  skus: z
    .array(storableText().trim().min(1).max(SKU_MAX_LENGTH))
    .min(1)
    .max(ENRICH_BATCH_MAX),
});

export const chargePayloadSchema = z.object({
  amountCents: z.coerce.number().int().positive(),
  reference: storableText().min(1).max(200),
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
  z
    .object({
      type: z.literal('image.process'),
      payload: imageProcessPayloadSchema.strict(),
      maxAttempts: maxAttemptsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('ai.enrich'),
      payload: aiEnrichPayloadSchema.strict(),
      maxAttempts: maxAttemptsSchema,
    })
    .strict(),
]);

export type SubmitJobInput = z.infer<typeof submitJobSchema>;

// A job only the server writes: a pipeline's summary, written by the
// transaction that finishes its last job (§6.3e). Outside the submit union, so
// no client can send one.
export const pipelineFinalizePayloadSchema = z.object({ pipelineId: z.uuid() });

type SubmittedJobType = SubmitJobInput['type'];

export type JobType = SubmittedJobType | 'pipeline.finalize';

export type PayloadOf<T extends JobType> = T extends SubmittedJobType
  ? Extract<SubmitJobInput, { type: T }>['payload']
  : z.infer<typeof pipelineFinalizePayloadSchema>;

// Derived from the union rather than written beside it: a job type exists in
// exactly one place, so the list cannot drift from what submit() accepts.
export const JOB_TYPES: readonly JobType[] = [
  ...submitJobSchema.options.map((option) => option.shape.type.value),
  'pipeline.finalize',
];

// Every instant a client sends, read one way. A timezone is required, not
// assumed: "re-drive what died between 02:00 and
// 03:00" is off by hours if the server and the operator disagree on which 02:00.
// z.coerce.date() would also accept "1" and read it as the year 2001.
const instant = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

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
        createdAt: instant,
        id: z.uuid(),
      }),
      // An ISO instant and a uuid.
      24 + 36,
    ).optional(),
  })
  .strict();

// What finds a dead letter, read one way by the list and by the re-drive, so
// the list shows what a re-drive with the same filter works through.
const deadLetterFilter = z.object({
  type: z.enum(JOB_TYPES).optional(),
  errorCode: z.enum(DEAD_LETTER_CODES).optional(),
  // When the job was dead-lettered — its `finishedAt` — not when it was
  // submitted: an outage is a window in which jobs died. Half-open, so two
  // adjacent windows never re-drive the same job twice.
  deadLetteredFrom: instant.optional(),
  deadLetteredTo: instant.optional(),
});

export type DeadLetterFilter = z.infer<typeof deadLetterFilter>;

const windowInOrder = (filter: DeadLetterFilter) =>
  filter.deadLetteredFrom === undefined ||
  filter.deadLetteredTo === undefined ||
  filter.deadLetteredFrom < filter.deadLetteredTo;

const WINDOW_OUT_OF_ORDER = {
  message: 'deadLetteredFrom must be before deadLetteredTo',
};

export const listDeadLettersSchema = deadLetterFilter
  .extend({
    limit: limitParam,
    // The last dead letter a page held, by the two values the list is ordered
    // on.
    cursor: cursorParam(
      z.object({
        finishedAt: instant,
        id: z.uuid(),
      }),
      // An ISO instant and a uuid.
      24 + 36,
    ).optional(),
  })
  .strict()
  // No filter is a request to read every dead letter, which is harmless; it is
  // the re-drive that needs one.
  .refine(windowInOrder, WINDOW_OUT_OF_ORDER);

export type ListDeadLettersQuery = z.infer<typeof listDeadLettersSchema>;

export const bulkRedriveSchema = deadLetterFilter
  .extend({
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
  .refine(windowInOrder, WINDOW_OUT_OF_ORDER);

export type BulkRedriveInput = z.infer<typeof bulkRedriveSchema>;

export const jobIdSchema = z.uuid();

// What an import takes, and nothing else: the batches are the server's to
// decide (§6.3e).
export const startPipelineSchema = z
  .object({ key: importCsvPayloadSchema.shape.key })
  .strict();

export type StartPipelineInput = z.infer<typeof startPipelineSchema>;

export const pipelineIdSchema = z.uuid();

// Resuming is the default and needs no word for it (D26); a restart is the one
// a caller has to ask for.
export const redriveQuerySchema = z
  .object({ from: z.literal('start').optional() })
  .strict();

export type RedriveQuery = z.infer<typeof redriveQuerySchema>;

export type ListJobsQuery = z.infer<typeof listJobsSchema>;

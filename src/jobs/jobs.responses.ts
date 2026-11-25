import { z } from 'zod';
import { JobStatus, PipelineStatus } from '../generated/prisma/enums.js';
import { instant, page } from '../docs/openapi-schemas.js';
import { JOB_TYPES } from './jobs.schema.js';

const count = z.number().int().nonnegative();

export const jobView = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    type: z.enum(JOB_TYPES),
    payload: z.unknown(),
    status: z.enum(JobStatus),
    attempts: count,
    maxAttempts: z.number().int(),
    idempotencyKey: z.string(),
    result: z.unknown().describe("Set when it succeeds; the type's own shape"),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        attempt: z.number().int().optional(),
        reason: z.string().optional(),
      })
      .strict()
      .nullable(),
    progress: z
      .object({
        processed: count,
        total: count.optional(),
        message: z.string().optional(),
      })
      .strict()
      .nullable(),
    cancelRequested: z.boolean(),
    effectCommitted: z.boolean(),
    correlationId: z.string(),
    pipelineId: z.uuid().nullable(),
    modelUsage: z
      .object({
        tokensIn: count,
        tokensOut: count,
        estimatedCostUsd: z.number(),
      })
      .strict(),
    createdAt: instant,
    updatedAt: instant,
    startedAt: instant.nullable(),
    finishedAt: instant.nullable(),
  })
  .strict();

export const submittedJobView = jobView
  .extend({
    replayed: z
      .boolean()
      .describe('True when an earlier request with this key made the job'),
  })
  .strict();

export const jobPage = page(jobView);

export const redrivenView = z
  .object({ redriven: count, remaining: count })
  .strict();

export const reportLinkView = z
  .object({ url: z.url(), expiresAt: instant })
  .strict();

const stage = <T extends z.ZodRawShape>(products: T) =>
  z.object({ batches: count, failedBatches: count, ...products }).strict();

export const pipelineView = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    idempotencyKey: z.string(),
    correlationId: z.string(),
    status: z.enum(PipelineStatus),
    importJobId: z.uuid(),
    jobs: z
      .record(z.string(), z.partialRecord(z.enum(JobStatus), count))
      .describe(
        "How many of the pipeline's jobs of each type are in each status",
      ),
    summary: z
      .object({
        import: z
          .object({ rows: count, imported: count, invalid: count })
          .strict()
          .nullable(),
        enrich: stage({ enriched: count, failed: count }),
        images: stage({ processed: count, failed: count }),
      })
      .strict()
      .nullable()
      .describe('Set once the pipeline finishes'),
    createdAt: instant,
    finishedAt: instant.nullable(),
  })
  .strict();

export const startedPipelineView = pipelineView
  .extend({ replayed: z.boolean() })
  .strict();

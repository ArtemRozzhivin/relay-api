-- When the import's batches were written (§6.3e). How a pipeline ends turns on
-- it rather than on the import's status: an import that failed after its
-- batches were written left a whole pipeline behind it, and one re-driven after
-- the pipeline gave up its place writes no batches at all.
ALTER TABLE "Pipeline" ADD COLUMN "fannedOutAt" TIMESTAMPTZ(3);

-- Hand-written, as Prisma cannot express it.

-- FAILED means the batches were never written; a pipeline that has them ends
-- COMPLETED or COMPLETED_WITH_ERRORS.
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_failed_only_before_fan_out"
  CHECK ("status" <> 'FAILED' OR "fannedOutAt" IS NULL);

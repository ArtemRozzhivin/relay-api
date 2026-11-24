-- Pipelines (§6.3e): an import, the batches it fans out into, and the summary
-- they converge on. The batches are ordinary jobs pointing at their pipeline
-- (D24), so the queue holds no structure Postgres does not.
CREATE TYPE "PipelineStatus" AS ENUM ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

-- A constant default, so Postgres adds the columns without rewriting the table.
ALTER TABLE "Job" ADD COLUMN "pendingInPipeline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pipelineId" UUID;

CREATE TABLE "Pipeline" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "status" "PipelineStatus" NOT NULL DEFAULT 'RUNNING',
    "pendingChildren" INTEGER NOT NULL DEFAULT 1,
    "failedChildren" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Pipeline_userId_idempotencyKey_key" ON "Pipeline"("userId", "idempotencyKey");

CREATE INDEX "Job_pipelineId_type_status_idx" ON "Job"("pipelineId", "type", "status");

ALTER TABLE "Job" ADD CONSTRAINT "Job_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written, as Prisma cannot express them.

-- Below zero, a job counted twice, and the parent was enqueued while a child
-- was still running.
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_counts_not_negative"
  CHECK ("pendingChildren" >= 0 AND "failedChildren" >= 0);

-- As on Job: the summary's moment is stamped exactly when the status is final.
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_finished_when_final"
  CHECK (("status" = 'RUNNING') = ("finishedAt" IS NULL));

-- A job holding a place in no pipeline would hold it for ever.
ALTER TABLE "Job" ADD CONSTRAINT "Job_pending_in_a_pipeline"
  CHECK (NOT "pendingInPipeline" OR "pipelineId" IS NOT NULL);

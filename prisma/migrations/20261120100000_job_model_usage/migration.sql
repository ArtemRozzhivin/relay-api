-- What a job's requests to a language model used and cost, added to as each
-- reply arrives (§6.3d). On the job, not in its result: a provider charges for
-- a reply whether or not the attempt that asked goes on to succeed.
-- A constant default, so Postgres adds the columns without rewriting the table.
ALTER TABLE "Job"
  ADD COLUMN "tokensIn" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "tokensOut" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "estimatedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0;

-- Hand-written, as Prisma cannot express it. Only ever added to.
ALTER TABLE "Job" ADD CONSTRAINT "Job_model_usage_not_negative"
  CHECK ("tokensIn" >= 0 AND "tokensOut" >= 0 AND "estimatedCostUsd" >= 0);

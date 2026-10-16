-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('MOCK', 'CHARGE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'DEAD_LETTERED');

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "JobType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "idempotencyKey" TEXT NOT NULL,
    "result" JSONB,
    "error" JSONB,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_userId_status_createdAt_idx" ON "Job"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Job_userId_idempotencyKey_key" ON "Job"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: Prisma's schema language cannot express CHECK constraints.
ALTER TABLE "Job" ADD CONSTRAINT "Job_maxAttempts_range"
  CHECK ("maxAttempts" BETWEEN 1 AND 20);

ALTER TABLE "Job" ADD CONSTRAINT "Job_attempts_within_max"
  CHECK ("attempts" >= 0 AND "attempts" <= "maxAttempts");

-- Hand-written: Prisma cannot express a partial index. Only in-flight jobs are
-- indexed, so the index stays small as completed jobs accumulate.
CREATE INDEX "Job_inflight_idx" ON "Job"("status")
  WHERE "status" IN ('QUEUED', 'RUNNING');

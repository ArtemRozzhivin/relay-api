-- CreateTable
CREATE TABLE "Outbox" (
    "id" BIGSERIAL NOT NULL,
    "jobId" UUID NOT NULL,
    "queue" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express a partial index. The relay only ever queries unpublished
-- rows, and published rows fall out of this index, so it stays the size of the
-- current backlog rather than growing with history.
CREATE INDEX "Outbox_pending_idx" ON "Outbox"("createdAt")
  WHERE "publishedAt" IS NULL;

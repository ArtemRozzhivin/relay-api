-- The job list pages with a cursor that carries the last job's createdAt through
-- JavaScript, whose Date holds milliseconds. At microseconds, a job a few
-- microseconds after the one a page ended on would compare equal to the cursor's
-- rounded value, and the next page would skip it (D14).
ALTER TABLE "Job" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3);

-- The list's own order, newest first with the id breaking ties, so a page is a
-- range of an index rather than a sort of every job the caller has: with and
-- without a status filter.
DROP INDEX "Job_userId_status_createdAt_idx";

CREATE INDEX "Job_userId_status_createdAt_id_idx" ON "Job"("userId", "status", "createdAt" DESC, "id" DESC);

CREATE INDEX "Job_userId_createdAt_id_idx" ON "Job"("userId", "createdAt" DESC, "id" DESC);

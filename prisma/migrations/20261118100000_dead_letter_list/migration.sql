-- The dead-letter list pages with a cursor that carries the last job's finishedAt
-- through JavaScript, whose Date holds milliseconds. At microseconds, the next
-- page would start before the job the last one ended on and show it again (D14).
-- Every finishedAt so far was written from a JS Date, so none is rounded.
--
-- Narrowing a timestamp rewrites the table while holding ACCESS EXCLUSIVE on it.
-- Fine at this size; at real volume it would be a maintenance window.
ALTER TABLE "Job" ALTER COLUMN "finishedAt" SET DATA TYPE TIMESTAMPTZ(3);

-- A job has a finishedAt exactly when it is finished. The list's cursor needs
-- one on every dead letter: a row without would sort last, break the cursor, and
-- be re-driven without being listed. Every transition into a finished state
-- sets it and the re-drive, the one way back, clears it; rows written some other
-- way are brought in line — a finished one given the time it was last written.
UPDATE "Job" SET "finishedAt" = "updatedAt"
WHERE status NOT IN ('QUEUED', 'RUNNING') AND "finishedAt" IS NULL;

UPDATE "Job" SET "finishedAt" = NULL
WHERE status IN ('QUEUED', 'RUNNING') AND "finishedAt" IS NOT NULL;

ALTER TABLE "Job" ADD CONSTRAINT "Job_finished_at_exactly_when_finished"
  CHECK ((status IN ('QUEUED', 'RUNNING')) = ("finishedAt" IS NULL));

-- The dead-letter list's order and the bulk re-drive's, so a page or a batch is a
-- range of an index rather than a sort of every dead letter the account has:
-- 0.06 ms against 10 ms for the first page of 20 000. Not partial: Prisma sends
-- the status as a cast parameter, which the planner cannot match to an index's
-- WHERE.
CREATE INDEX "Job_userId_status_finishedAt_id_idx" ON "Job"("userId", "status", "finishedAt", "id");

-- Set in the transaction that commits a job's one irreversible effect. From
-- then on only the job's handler can finish it: a cancel that runs no handler
-- cannot see whether the effect happened, and a CANCELLED charge whose money
-- moved would be a lie (§5.2).
ALTER TABLE "Job" ADD COLUMN "effectCommitted" BOOLEAN NOT NULL DEFAULT false;

-- Jobs whose effect committed before the column existed, so none of them can be
-- cancelled from outside once this is deployed. A job already CANCELLED keeps
-- its history: the constraint below is about what happens from now on.
UPDATE "Job" SET "effectCommitted" = true
WHERE status <> 'CANCELLED'
  AND EXISTS (SELECT 1 FROM "SideEffect" s WHERE s."jobId" = "Job".id);

ALTER TABLE "Job" ADD CONSTRAINT "Job_effect_never_cancelled"
  CHECK (NOT ("effectCommitted" AND status = 'CANCELLED'));

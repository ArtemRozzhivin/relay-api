-- `attempts <= maxAttempts` cannot hold: BullMQ redelivers a stalled job in
-- addition to its configured retries (maxStalledCount defaults to 1), so a
-- worker can legitimately claim a job one more time than maxAttempts allows.
-- The dead-letter boundary is a policy decision in the worker; the database
-- only enforces that the counter is sane.
ALTER TABLE "Job" DROP CONSTRAINT IF EXISTS "Job_attempts_within_max";

ALTER TABLE "Job" ADD CONSTRAINT "Job_attempts_non_negative"
  CHECK ("attempts" >= 0);

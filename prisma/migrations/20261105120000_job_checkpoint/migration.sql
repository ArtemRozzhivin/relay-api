-- How far a job's committed work reaches, so a retry or a re-drive resumes there
-- instead of starting over (D26). A column of its own because `result` is cleared
-- by a re-drive and `progress` is presentational: a progress write may be dropped,
-- and a checkpoint that lagged the work would make a resume skip nothing, while
-- one that led it would skip rows that were never written.
ALTER TABLE "Job" ADD COLUMN "checkpoint" JSONB;

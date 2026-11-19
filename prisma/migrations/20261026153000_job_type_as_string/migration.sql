-- A Postgres enum has no DROP VALUE, so every retired or mistyped job type would
-- be permanent, and every new one would be a migration that has to be deployed
-- before the code that uses it. The set of job types is validated by the submit
-- schema and enforced at execution by the handler registry, both of which can
-- change in the same commit as the handler itself.
--
-- text is not binary-coercible from an enum, so this rewrites the table while
-- holding ACCESS EXCLUSIVE on it. Fine at this size; at real volume it would
-- have to be a new column, a backfill and a rename.
ALTER TABLE "Job" ALTER COLUMN "type" TYPE text USING "type"::text;

DROP TYPE "JobType";

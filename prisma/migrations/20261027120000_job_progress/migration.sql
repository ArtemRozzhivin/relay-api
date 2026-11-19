-- Progress is one current value, not a history: a row per update would be write
-- amplification nobody reads back, and the only question asked of it is "how far
-- along is this job right now", which a client asks again after every reconnect.
-- Nullable because most jobs never report any, and null means "did not say"
-- rather than "zero done".
ALTER TABLE "Job" ADD COLUMN "progress" jsonb;

-- The ownership token, split off the retry budget (D7). `attempts` doubled as
-- the token, and a re-drive resets it, so the token repeated: a worker frozen in
-- a job's previous life held the same number as the first claim of its next
-- one, and its writes landed on the new life. Every claim increments `lease`
-- and nothing resets it.
--
-- Seeded from `attempts` so every existing row starts with lease >= attempts,
-- which every later claim preserves.
ALTER TABLE "Job" ADD COLUMN "lease" INTEGER NOT NULL DEFAULT 0;

UPDATE "Job" SET "lease" = "attempts";

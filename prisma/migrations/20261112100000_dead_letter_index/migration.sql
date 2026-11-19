-- Prisma cannot express a partial index. The metrics count dead letters by type
-- across every account on each scrape, and no other index on "Job" serves that:
-- the rest lead with "userId", or hold only jobs in flight. Only dead letters
-- are in this one, so it stays the size of the backlog.
CREATE INDEX "Job_dead_letters_idx" ON "Job"("type")
  WHERE "status" = 'DEAD_LETTERED';

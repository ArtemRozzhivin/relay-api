-- A fingerprint of the submit body, so a retry under the same Idempotency-Key
-- can be told apart from a different request that reused the key (D28).
--
-- Nullable and not backfilled: computing it in SQL would have to reproduce the
-- application's canonical JSON byte for byte, and a row from before this column
-- can only ever be replayed — which is all it was ever given.
ALTER TABLE "Job" ADD COLUMN "requestHash" TEXT;

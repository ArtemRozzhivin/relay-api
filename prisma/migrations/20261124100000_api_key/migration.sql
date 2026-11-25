-- API keys (§6.3f): a credential a seller's own system uses instead of a
-- login. Only the key's SHA-256 is stored; the secret is shown once.
CREATE TYPE "ApiKeyScope" AS ENUM ('read', 'write');

CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" "ApiKeyScope"[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiKey_hash_key" ON "ApiKey"("hash");

CREATE INDEX "ApiKey_userId_createdAt_idx" ON "ApiKey"("userId", "createdAt");

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written, as Prisma cannot express it. Prisma leaves a list column
-- nullable, and cardinality(NULL) is NULL, which a CHECK lets through: a key
-- that may do nothing is refused either way.
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_has_a_scope"
  CHECK ("scopes" IS NOT NULL AND cardinality("scopes") >= 1);

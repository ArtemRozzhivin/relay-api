-- What ai.enrich last concluded about a product, and from which input (§6.3d).
-- The input's hash is what makes the conclusion mean anything: an import that
-- changes the name or description leaves it in place, describing text the
-- product no longer has, so it reads as not enriched yet without anyone having
-- to clear it.
CREATE TYPE "ProductCategory" AS ENUM ('apparel', 'footwear', 'accessories', 'beauty', 'home', 'kitchen', 'electronics', 'toys', 'sports', 'books', 'food', 'other');

ALTER TABLE "Product"
  ADD COLUMN "enrichmentStatus" TEXT,
  ADD COLUMN "enrichmentInputHash" TEXT,
  ADD COLUMN "enrichmentError" TEXT,
  ADD COLUMN "category" "ProductCategory",
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Hand-written, as Prisma cannot express them. IS NOT DISTINCT FROM where a
-- NULL status must fail the check: a CHECK that evaluates to NULL passes.
ALTER TABLE "Product" ADD CONSTRAINT "Product_enrichmentStatus_known"
  CHECK ("enrichmentStatus" IN ('READY', 'FAILED'));

-- A conclusion is always about some input, and only a failure has a reason.
ALTER TABLE "Product" ADD CONSTRAINT "Product_enrichmentStatus_has_input"
  CHECK (("enrichmentStatus" IS NULL) = ("enrichmentInputHash" IS NULL));

ALTER TABLE "Product" ADD CONSTRAINT "Product_enrichmentError_only_on_failure"
  CHECK ("enrichmentError" IS NULL OR "enrichmentStatus" IS NOT DISTINCT FROM 'FAILED');

-- A category and tags are a READY conclusion's answer, so a failure that
-- follows one leaves no answer behind that was made from older text.
ALTER TABLE "Product" ADD CONSTRAINT "Product_category_when_ready"
  CHECK (("category" IS NOT NULL) = ("enrichmentStatus" IS NOT DISTINCT FROM 'READY'));

ALTER TABLE "Product" ADD CONSTRAINT "Product_tags_when_ready"
  CHECK (cardinality("tags") = 0 OR "enrichmentStatus" IS NOT DISTINCT FROM 'READY');

ALTER TABLE "Product" ADD CONSTRAINT "Product_tags_at_most_five"
  CHECK (cardinality("tags") <= 5);

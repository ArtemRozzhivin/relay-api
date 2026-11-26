-- The CHECK as first written passed a reason on a product with no conclusion:
-- with "imageStatus" NULL, `= 'FAILED'` is NULL, and a CHECK that evaluates to
-- NULL passes. Written as the enrichment's is, so NULL fails it.
ALTER TABLE "Product" DROP CONSTRAINT "Product_imageError_only_on_failure";

ALTER TABLE "Product" ADD CONSTRAINT "Product_imageError_only_on_failure"
  CHECK ("imageError" IS NULL OR "imageStatus" IS NOT DISTINCT FROM 'FAILED');

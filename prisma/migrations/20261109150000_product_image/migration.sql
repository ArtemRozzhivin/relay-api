-- What image.process last concluded about a product's image, and for which
-- imageUrl. The URL is what makes the status mean anything: an import that
-- changes imageUrl leaves the old conclusion in place, describing a URL the
-- product no longer has, so it reads as "not processed yet" without anyone
-- having to clear it.
ALTER TABLE "Product"
  ADD COLUMN "imageStatus" TEXT,
  ADD COLUMN "imageSourceUrl" TEXT,
  ADD COLUMN "imageError" TEXT;

-- Hand-written, as Prisma cannot express them.
ALTER TABLE "Product" ADD CONSTRAINT "Product_imageStatus_known"
  CHECK ("imageStatus" IN ('READY', 'FAILED'));

-- A conclusion is always about some URL, and only a failure has a reason.
ALTER TABLE "Product" ADD CONSTRAINT "Product_imageStatus_has_source"
  CHECK (("imageStatus" IS NULL) = ("imageSourceUrl" IS NULL));

ALTER TABLE "Product" ADD CONSTRAINT "Product_imageError_only_on_failure"
  CHECK ("imageError" IS NULL OR "imageStatus" = 'FAILED');

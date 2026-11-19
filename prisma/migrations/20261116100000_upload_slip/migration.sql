-- CreateTable
CREATE TABLE "UploadSlip" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadSlip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UploadSlip_userId_createdAt_idx" ON "UploadSlip"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "UploadSlip" ADD CONSTRAINT "UploadSlip_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


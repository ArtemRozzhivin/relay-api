-- CreateTable
CREATE TABLE "SideEffect" (
    "id" UUID NOT NULL,
    "effectKey" TEXT NOT NULL,
    "jobId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SideEffect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SideEffect_effectKey_key" ON "SideEffect"("effectKey");

-- CreateIndex
CREATE INDEX "SideEffect_jobId_idx" ON "SideEffect"("jobId");

-- AddForeignKey
ALTER TABLE "SideEffect" ADD CONSTRAINT "SideEffect_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Extension" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "overrideReason" TEXT;

-- AlterTable
ALTER TABLE "Leave" ADD COLUMN     "decisionNote" TEXT;

-- AlterTable
ALTER TABLE "ReplacementTask" ADD COLUMN     "sourceId" TEXT;

-- CreateTable
CREATE TABLE "DaysOffLedger" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DaysOffLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DaysOffLedger_employeeId_idx" ON "DaysOffLedger"("employeeId");

-- CreateIndex
CREATE INDEX "DaysOffLedger_refId_idx" ON "DaysOffLedger"("refId");

-- CreateIndex
CREATE INDEX "ReplacementTask_sourceId_idx" ON "ReplacementTask"("sourceId");

-- AddForeignKey
ALTER TABLE "DaysOffLedger" ADD CONSTRAINT "DaysOffLedger_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

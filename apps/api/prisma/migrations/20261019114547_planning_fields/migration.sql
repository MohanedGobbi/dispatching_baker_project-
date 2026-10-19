-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "overrideReason" TEXT;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "decisionNote" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "submittedBy" TEXT,
ADD COLUMN     "summary" JSONB;

-- AlterTable
ALTER TABLE "ReplacementTask" ADD COLUMN     "assignmentId" TEXT,
ADD COLUMN     "escalatedAt" TIMESTAMP(3);

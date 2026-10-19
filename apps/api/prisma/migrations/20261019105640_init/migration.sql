-- CreateEnum
CREATE TYPE "PositionCategory" AS ENUM ('FIELD_CREW', 'BASE_STAFF', 'MANAGEMENT');

-- CreateEnum
CREATE TYPE "WorkMode" AS ENUM ('FIELD', 'BASE', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "Seniority" AS ENUM ('NEW_RECRUIT', 'JUNIOR', 'EXPERIENCED', 'SENIOR');

-- CreateEnum
CREATE TYPE "UnitStatus" AS ENUM ('AVAILABLE', 'DEPLOYED', 'IN_TRANSIT', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SeatHolder" AS ENUM ('UNIT', 'BASE');

-- CreateEnum
CREATE TYPE "AssignmentType" AS ENUM ('NORMAL', 'REPLACEMENT', 'EXTENSION_COVER', 'TEMPORARY_COVER');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Base" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "regionId" TEXT,
    "address" TEXT,
    "city" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "phone" TEXT,
    "managerId" TEXT,
    "unitCapacity" INTEGER,
    "bedCapacity" INTEGER,
    "facilities" TEXT[],
    "schedule" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Base_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'well',
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "baseId" TEXT NOT NULL,
    "client" TEXT,
    "travelHours" DOUBLE PRECISION,
    "accessNotes" TEXT,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "PositionCategory" NOT NULL,
    "canFillUnitSeat" BOOLEAN NOT NULL DEFAULT false,
    "canFillBasePost" BOOLEAN NOT NULL DEFAULT false,
    "defaultRotationId" TEXT,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Qualification" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Qualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertificationType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "CertificationType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RotationPattern" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "daysOn" INTEGER,
    "daysOff" INTEGER,
    "weeklyMask" TEXT,
    "travelPolicy" TEXT NOT NULL DEFAULT 'separate',

    CONSTRAINT "RotationPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BaseStaffingRule" (
    "id" TEXT NOT NULL,
    "baseId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "minCount" INTEGER NOT NULL,
    "targetCount" INTEGER NOT NULL,
    "scheduleWindow" TEXT,

    CONSTRAINT "BaseStaffingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colorKey" TEXT NOT NULL,

    CONSTRAINT "UnitType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewTemplateSeat" (
    "id" TEXT NOT NULL,
    "unitTypeId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "requiredQualId" TEXT,
    "minSeniority" "Seniority",

    CONSTRAINT "CrewTemplateSeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "employeeNo" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "photoUrl" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "emergencyContact" TEXT,
    "homeCity" TEXT,
    "positionId" TEXT NOT NULL,
    "workMode" "WorkMode" NOT NULL DEFAULT 'FIELD',
    "hireDate" TIMESTAMP(3) NOT NULL,
    "contractType" TEXT NOT NULL DEFAULT 'permanent',
    "homeBaseId" TEXT NOT NULL,
    "rotationPatternId" TEXT,
    "rotationAnchorDate" TIMESTAMP(3),
    "backToBackId" TEXT,
    "seniorityOverride" "Seniority",
    "seniorityReason" TEXT,
    "tags" TEXT[],
    "managerNotes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeQualification" (
    "employeeId" TEXT NOT NULL,
    "qualificationId" TEXT NOT NULL,
    "obtainedAt" TIMESTAMP(3) NOT NULL,
    "validatedBy" TEXT,

    CONSTRAINT "EmployeeQualification_pkey" PRIMARY KEY ("employeeId","qualificationId")
);

-- CreateTable
CREATE TABLE "Certification" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "documentUrl" TEXT,

    CONSTRAINT "Certification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "unitTypeId" TEXT NOT NULL,
    "homeBaseId" TEXT NOT NULL,
    "status" "UnitStatus" NOT NULL DEFAULT 'AVAILABLE',
    "plate" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "notes" TEXT,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "wellName" TEXT NOT NULL,
    "rigName" TEXT,
    "client" TEXT,
    "siteId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "plannedStart" TIMESTAMP(3) NOT NULL,
    "plannedEnd" TIMESTAMP(3) NOT NULL,
    "actualStart" TIMESTAMP(3),
    "actualEnd" TIMESTAMP(3),
    "status" "JobStatus" NOT NULL DEFAULT 'PLANNED',

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitDeployment" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seat" (
    "id" TEXT NOT NULL,
    "holderType" "SeatHolder" NOT NULL,
    "unitId" TEXT,
    "baseId" TEXT,
    "positionId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "requirements" JSONB,
    "requiredFlag" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Seat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "scope" TEXT[],
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "plannedEnd" TIMESTAMP(3) NOT NULL,
    "actualEnd" TIMESTAMP(3),
    "type" "AssignmentType" NOT NULL DEFAULT 'NORMAL',
    "status" "AssignmentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "replacesId" TEXT,
    "planId" TEXT,
    "explanation" TEXT,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "needsApproval" BOOLEAN NOT NULL DEFAULT true,
    "needsDocument" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Leave" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "documentUrl" TEXT,
    "enteredBy" TEXT,
    "approvedBy" TEXT,
    "notes" TEXT,
    "longTerm" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Leave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitForDuty" (
    "id" TEXT NOT NULL,
    "leaveId" TEXT NOT NULL,
    "clearedAt" TIMESTAMP(3) NOT NULL,
    "clearedBy" TEXT NOT NULL,
    "restrictionId" TEXT,

    CONSTRAINT "FitForDuty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Restriction" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3),
    "source" TEXT,

    CONSTRAINT "Restriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Extension" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT,
    "approvedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "Extension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplacementTask" (
    "id" TEXT NOT NULL,
    "seatId" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "trigger" TEXT NOT NULL,
    "urgency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "candidateId" TEXT,
    "deadline" TIMESTAMP(3),

    CONSTRAINT "ReplacementTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "baseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "description" TEXT,
    "plannedStart" TIMESTAMP(3) NOT NULL,
    "expectedReturn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "WorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderAssignee" (
    "workOrderId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "WorkOrderAssignee_pkey" PRIMARY KEY ("workOrderId","employeeId")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "employeeId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "baseScope" TEXT,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","role")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'in_app',
    "readAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseId" TEXT,
    "data" JSONB NOT NULL,
    "suggestedAction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PositionQualifications" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PositionQualifications_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_PositionCerts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PositionCerts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Base_code_key" ON "Base"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Position_name_key" ON "Position"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Qualification_name_key" ON "Qualification"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CertificationType_name_key" ON "CertificationType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "RotationPattern_name_key" ON "RotationPattern"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BaseStaffingRule_baseId_positionId_key" ON "BaseStaffingRule"("baseId", "positionId");

-- CreateIndex
CREATE UNIQUE INDEX "UnitType_name_key" ON "UnitType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeNo_key" ON "Employee"("employeeNo");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_code_key" ON "Unit"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Job_ref_key" ON "Job"("ref");

-- CreateIndex
CREATE INDEX "Assignment_employeeId_start_idx" ON "Assignment"("employeeId", "start");

-- CreateIndex
CREATE INDEX "Assignment_seatId_start_idx" ON "Assignment"("seatId", "start");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveType_name_key" ON "LeaveType"("name");

-- CreateIndex
CREATE INDEX "Leave_employeeId_start_idx" ON "Leave"("employeeId", "start");

-- CreateIndex
CREATE UNIQUE INDEX "FitForDuty_leaveId_key" ON "FitForDuty"("leaveId");

-- CreateIndex
CREATE UNIQUE INDEX "FitForDuty_restrictionId_key" ON "FitForDuty"("restrictionId");

-- CreateIndex
CREATE UNIQUE INDEX "User_login_key" ON "User"("login");

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeId_key" ON "User"("employeeId");

-- CreateIndex
CREATE INDEX "_PositionQualifications_B_index" ON "_PositionQualifications"("B");

-- CreateIndex
CREATE INDEX "_PositionCerts_B_index" ON "_PositionCerts"("B");

-- AddForeignKey
ALTER TABLE "Base" ADD CONSTRAINT "Base_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "Base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_defaultRotationId_fkey" FOREIGN KEY ("defaultRotationId") REFERENCES "RotationPattern"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaseStaffingRule" ADD CONSTRAINT "BaseStaffingRule_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "Base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BaseStaffingRule" ADD CONSTRAINT "BaseStaffingRule_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewTemplateSeat" ADD CONSTRAINT "CrewTemplateSeat_unitTypeId_fkey" FOREIGN KEY ("unitTypeId") REFERENCES "UnitType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewTemplateSeat" ADD CONSTRAINT "CrewTemplateSeat_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewTemplateSeat" ADD CONSTRAINT "CrewTemplateSeat_requiredQualId_fkey" FOREIGN KEY ("requiredQualId") REFERENCES "Qualification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_homeBaseId_fkey" FOREIGN KEY ("homeBaseId") REFERENCES "Base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_rotationPatternId_fkey" FOREIGN KEY ("rotationPatternId") REFERENCES "RotationPattern"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "Qualification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "CertificationType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_unitTypeId_fkey" FOREIGN KEY ("unitTypeId") REFERENCES "UnitType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_homeBaseId_fkey" FOREIGN KEY ("homeBaseId") REFERENCES "Base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitDeployment" ADD CONSTRAINT "UnitDeployment_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitDeployment" ADD CONSTRAINT "UnitDeployment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "Base"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seat" ADD CONSTRAINT "Seat_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Leave" ADD CONSTRAINT "Leave_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitForDuty" ADD CONSTRAINT "FitForDuty_leaveId_fkey" FOREIGN KEY ("leaveId") REFERENCES "Leave"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitForDuty" ADD CONSTRAINT "FitForDuty_restrictionId_fkey" FOREIGN KEY ("restrictionId") REFERENCES "Restriction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Restriction" ADD CONSTRAINT "Restriction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Extension" ADD CONSTRAINT "Extension_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplacementTask" ADD CONSTRAINT "ReplacementTask_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplacementTask" ADD CONSTRAINT "ReplacementTask_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "Base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderAssignee" ADD CONSTRAINT "WorkOrderAssignee_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkOrderAssignee" ADD CONSTRAINT "WorkOrderAssignee_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_baseId_fkey" FOREIGN KEY ("baseId") REFERENCES "Base"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PositionQualifications" ADD CONSTRAINT "_PositionQualifications_A_fkey" FOREIGN KEY ("A") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PositionQualifications" ADD CONSTRAINT "_PositionQualifications_B_fkey" FOREIGN KEY ("B") REFERENCES "Qualification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PositionCerts" ADD CONSTRAINT "_PositionCerts_A_fkey" FOREIGN KEY ("A") REFERENCES "CertificationType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PositionCerts" ADD CONSTRAINT "_PositionCerts_B_fkey" FOREIGN KEY ("B") REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE;

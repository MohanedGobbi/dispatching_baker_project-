-- A stay on a seat with no crew change date yet: plannedEnd is parked far ahead until the manager sets one.
ALTER TABLE "Assignment" ADD COLUMN "openEnded" BOOLEAN NOT NULL DEFAULT false;

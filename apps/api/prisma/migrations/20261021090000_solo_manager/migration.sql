-- When a replacement task stopped being open (so the screen can show "fixed" for a while).
ALTER TABLE "ReplacementTask" ADD COLUMN "closedAt" TIMESTAMP(3);
UPDATE "ReplacementTask" SET "closedAt" = NOW() WHERE "status" = 'CLOSED';

-- The field operator is the driver: no Field Driver seats on units, none in the unit-type templates,
-- and people who were Field Drivers become Field Operators.
CREATE TEMP TABLE _driver_seats AS
  SELECT s."id" FROM "Seat" s JOIN "Position" p ON p."id" = s."positionId" WHERE s."holderType" = 'UNIT' AND p."name" = 'Field Driver';
DELETE FROM "Extension" WHERE "assignmentId" IN (SELECT a."id" FROM "Assignment" a WHERE a."seatId" IN (SELECT "id" FROM _driver_seats));
DELETE FROM "ReplacementTask" WHERE "seatId" IN (SELECT "id" FROM _driver_seats);
DELETE FROM "Assignment" WHERE "seatId" IN (SELECT "id" FROM _driver_seats);
DELETE FROM "Seat" WHERE "id" IN (SELECT "id" FROM _driver_seats);
DROP TABLE _driver_seats;
DELETE FROM "CrewTemplateSeat" WHERE "positionId" IN (SELECT "id" FROM "Position" WHERE "name" = 'Field Driver');
UPDATE "Employee" SET "positionId" = (SELECT "id" FROM "Position" WHERE "name" = 'Field Operator')
  WHERE "positionId" IN (SELECT "id" FROM "Position" WHERE "name" = 'Field Driver')
    AND EXISTS (SELECT 1 FROM "Position" WHERE "name" = 'Field Operator');

-- Base staff is gone from CrewBoard: no base-post seats, no staffing minimums, and the people in base-staff
-- positions (mechanics, storekeepers, ...) are archived. Units and their crews are untouched.
CREATE TEMP TABLE _base_seats AS SELECT "id" FROM "Seat" WHERE "holderType" = 'BASE';
DELETE FROM "Extension" WHERE "assignmentId" IN (SELECT a."id" FROM "Assignment" a WHERE a."seatId" IN (SELECT "id" FROM _base_seats));
DELETE FROM "ReplacementTask" WHERE "seatId" IN (SELECT "id" FROM _base_seats);
DELETE FROM "Assignment" WHERE "seatId" IN (SELECT "id" FROM _base_seats);
DELETE FROM "Seat" WHERE "id" IN (SELECT "id" FROM _base_seats);
DROP TABLE _base_seats;
DELETE FROM "BaseStaffingRule";
UPDATE "Employee" SET "active" = false
  WHERE "positionId" IN (SELECT "id" FROM "Position" WHERE "category" = 'BASE_STAFF');

-- A stay whose end date passed with nobody lined up is kept on the seat (no date yet) until the manager unassigns it.
ALTER TABLE "Assignment" ADD COLUMN "endPassed" DATETIME;

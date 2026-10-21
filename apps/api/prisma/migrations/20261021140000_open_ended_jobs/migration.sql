-- A job can run until the manager ends it. plannedEnd still holds a date (far ahead) so every date range
-- keeps working; this flag is what the screens read to say "open" instead of showing that date.
ALTER TABLE "Job" ADD COLUMN "openEnded" BOOLEAN NOT NULL DEFAULT false;

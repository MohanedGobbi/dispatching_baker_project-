-- Starting the platform: a person can be marked as on days off or on standby right now, before anyone knows
-- when their rotation started. The mark is cleared as soon as a first day of work is recorded.
ALTER TABLE "Employee" ADD COLUMN "startState" TEXT;

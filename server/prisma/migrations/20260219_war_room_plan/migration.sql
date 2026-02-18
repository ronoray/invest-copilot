-- War Room Plan: Store structured AI intelligence for event-driven alerts
ALTER TABLE "DailyTarget" ADD COLUMN "warRoomPlan" JSONB;
ALTER TABLE "DailyTarget" ADD COLUMN "recalibrationCount" INTEGER NOT NULL DEFAULT 0;

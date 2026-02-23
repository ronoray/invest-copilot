-- Add isPaused flag to Portfolio
-- When true: portfolio is excluded from all signals, alerts, and AI analysis
-- Used to focus activity on a single broker (e.g. Upstox only mode)

ALTER TABLE "Portfolio"
  ADD COLUMN IF NOT EXISTS "isPaused" BOOLEAN NOT NULL DEFAULT false;

-- Pause all non-Upstox portfolios
UPDATE "Portfolio" SET "isPaused" = true WHERE "broker" != 'UPSTOX';

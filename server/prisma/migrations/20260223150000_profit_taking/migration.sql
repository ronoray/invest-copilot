-- Add profit-taking fields to Portfolio
-- profitTargetPct: % gain at which system recommends withdrawing (default 10%)
-- totalWithdrawn: cumulative amount sent to bank from this portfolio

ALTER TABLE "Portfolio"
  ADD COLUMN IF NOT EXISTS "profitTargetPct" DOUBLE PRECISION NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "totalWithdrawn"  DOUBLE PRECISION NOT NULL DEFAULT 0;

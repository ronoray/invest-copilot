-- Performance Tracking Tables
-- Adds equity curve snapshots, mistake ledger, and learning rules.
-- All tables are additive — no existing tables modified.

CREATE TABLE "PortfolioSnapshot" (
  "id"              SERIAL PRIMARY KEY,
  "portfolioId"     INTEGER NOT NULL,
  "date"            DATE NOT NULL,
  "startingCapital" DOUBLE PRECISION NOT NULL,
  "currentEquity"   DOUBLE PRECISION NOT NULL,
  "investedValue"   DOUBLE PRECISION NOT NULL,
  "cashBalance"     DOUBLE PRECISION NOT NULL,
  "realizedPnl"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "unrealizedPnl"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "peakEquity"      DOUBLE PRECISION NOT NULL,
  "drawdownPct"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PortfolioSnapshot_portfolioId_fkey"
    FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "PortfolioSnapshot_portfolioId_date_key"
  ON "PortfolioSnapshot"("portfolioId", "date");
CREATE INDEX "PortfolioSnapshot_portfolioId_date_idx"
  ON "PortfolioSnapshot"("portfolioId", "date");

CREATE TABLE "MistakeLog" (
  "id"               SERIAL PRIMARY KEY,
  "portfolioId"      INTEGER NOT NULL,
  "symbol"           TEXT NOT NULL,
  "tradeId"          INTEGER,
  "signalId"         INTEGER,
  "mistakeCategory"  TEXT NOT NULL,
  "description"      TEXT NOT NULL,
  "reason"           TEXT,
  "lesson"           TEXT,
  "ruleImplemented"  BOOLEAN NOT NULL DEFAULT false,
  "pnlImpact"        DOUBLE PRECISION,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MistakeLog_portfolioId_fkey"
    FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE
);

CREATE INDEX "MistakeLog_portfolioId_idx"
  ON "MistakeLog"("portfolioId");
CREATE INDEX "MistakeLog_portfolioId_mistakeCategory_idx"
  ON "MistakeLog"("portfolioId", "mistakeCategory");

CREATE TABLE "LearningRule" (
  "id"               SERIAL PRIMARY KEY,
  "portfolioId"      INTEGER NOT NULL,
  "title"            TEXT NOT NULL,
  "description"      TEXT NOT NULL,
  "sourceMistakeId"  INTEGER,
  "status"           TEXT NOT NULL DEFAULT 'PROPOSED',
  "impact"           DOUBLE PRECISION,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LearningRule_portfolioId_fkey"
    FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE
);

CREATE INDEX "LearningRule_portfolioId_status_idx"
  ON "LearningRule"("portfolioId", "status");

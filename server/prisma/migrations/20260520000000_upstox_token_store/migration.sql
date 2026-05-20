-- Migration: upstox_token_store
-- Adds token metadata fields to UpstoxIntegration and creates UpstoxTokenHistory

-- New columns on UpstoxIntegration
ALTER TABLE "UpstoxIntegration"
  ADD COLUMN IF NOT EXISTS "tokenType"         TEXT DEFAULT 'Bearer',
  ADD COLUMN IF NOT EXISTS "issuedAt"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "upstoxUserId"      TEXT,
  ADD COLUMN IF NOT EXISTS "upstoxClientId"    TEXT,
  ADD COLUMN IF NOT EXISTS "lastAuthRequestAt" TIMESTAMP(3);

-- Append-only token history (audit trail, sanitized — no full tokens)
CREATE TABLE IF NOT EXISTS "UpstoxTokenHistory" (
  "id"             SERIAL PRIMARY KEY,
  "integrationId"  INTEGER  NOT NULL,
  "userId"         INTEGER  NOT NULL,
  "tokenHead"      TEXT     NOT NULL,
  "tokenTail"      TEXT     NOT NULL,
  "tokenType"      TEXT     NOT NULL DEFAULT 'Bearer',
  "issuedAt"       TIMESTAMP(3),
  "expiresAt"      TIMESTAMP(3),
  "receivedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "upstoxUserId"   TEXT,
  "upstoxClientId" TEXT,
  FOREIGN KEY ("integrationId") REFERENCES "UpstoxIntegration"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "UpstoxTokenHistory_integrationId_idx"
  ON "UpstoxTokenHistory"("integrationId");

CREATE INDEX IF NOT EXISTS "UpstoxTokenHistory_userId_idx"
  ON "UpstoxTokenHistory"("userId");

CREATE INDEX IF NOT EXISTS "UpstoxTokenHistory_integrationId_issuedAt_idx"
  ON "UpstoxTokenHistory"("integrationId", "issuedAt");

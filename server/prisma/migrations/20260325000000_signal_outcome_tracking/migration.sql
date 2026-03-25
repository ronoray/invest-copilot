-- Signal Outcome Tracking
-- Records actual fill price, exit price, realized P&L, and outcome for each signal.
-- Previously zero tracking meant we couldn't measure whether signals made or lost money.
-- These columns are all nullable to be backwards-compatible with historical signals.

ALTER TABLE "TradeSignal"
  ADD COLUMN IF NOT EXISTS "executedPrice" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "exitPrice"     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "realizedPnl"   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "outcome"       TEXT;

-- executedPrice: actual Upstox fill price (avg_price) when order settles
-- exitPrice:     price at which BUY position was later closed (from subsequent SELL)
-- realizedPnl:   (exitPrice - executedPrice) * quantity for BUY; or direct trade profit for SELL
-- outcome:       'PROFIT' | 'LOSS' | 'BREAKEVEN'

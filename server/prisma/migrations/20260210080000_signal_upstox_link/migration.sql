-- AlterTable: Add upstoxOrderId to TradeSignal for linking signals to Upstox orders
ALTER TABLE "TradeSignal" ADD COLUMN "upstoxOrderId" INTEGER;

-- CreateIndex
CREATE INDEX "TradeSignal_upstoxOrderId_idx" ON "TradeSignal"("upstoxOrderId");

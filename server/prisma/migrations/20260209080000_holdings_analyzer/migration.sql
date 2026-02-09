-- CreateTable
CREATE TABLE "DailyTarget" (
    "id" SERIAL NOT NULL,
    "portfolioId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "aiTarget" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "aiRationale" TEXT,
    "aiConfidence" INTEGER,
    "aiUpdatedAt" TIMESTAMP(3),
    "userTarget" DOUBLE PRECISION,
    "userUpdatedAt" TIMESTAMP(3),
    "earnedActual" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "earnedUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeSignal" (
    "id" SERIAL NOT NULL,
    "portfolioId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "triggerType" TEXT NOT NULL DEFAULT 'MARKET',
    "triggerPrice" DOUBLE PRECISION,
    "triggerLow" DOUBLE PRECISION,
    "triggerHigh" DOUBLE PRECISION,
    "confidence" INTEGER NOT NULL DEFAULT 50,
    "rationale" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastNotifiedAt" TIMESTAMP(3),
    "notifyCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalAck" (
    "id" SERIAL NOT NULL,
    "signalId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalAck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyTarget_portfolioId_date_idx" ON "DailyTarget"("portfolioId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyTarget_portfolioId_date_key" ON "DailyTarget"("portfolioId", "date");

-- CreateIndex
CREATE INDEX "TradeSignal_portfolioId_status_idx" ON "TradeSignal"("portfolioId", "status");

-- CreateIndex
CREATE INDEX "TradeSignal_status_lastNotifiedAt_idx" ON "TradeSignal"("status", "lastNotifiedAt");

-- CreateIndex
CREATE INDEX "TradeSignal_createdAt_idx" ON "TradeSignal"("createdAt");

-- CreateIndex
CREATE INDEX "SignalAck_signalId_idx" ON "SignalAck"("signalId");

-- AddForeignKey
ALTER TABLE "DailyTarget" ADD CONSTRAINT "DailyTarget_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeSignal" ADD CONSTRAINT "TradeSignal_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignalAck" ADD CONSTRAINT "SignalAck_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "TradeSignal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

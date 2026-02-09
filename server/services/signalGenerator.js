import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import { buildProfileBrief } from './advancedScreener.js';
import logger from './logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Generate BUY/SELL trade signals for a portfolio using AI.
 * Signals are actionable: specific symbol, side, quantity, trigger.
 *
 * @param {number} portfolioId
 * @returns {Promise<Array>} Created TradeSignal records
 */
export async function generateTradeSignals(portfolioId) {
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: { holdings: true }
  });

  if (!portfolio) {
    throw new Error(`Portfolio ${portfolioId} not found`);
  }

  const profileBrief = buildProfileBrief(portfolio);
  const cash = parseFloat(portfolio.availableCash || 0);

  // Get today's target for context
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dailyTarget = await prisma.dailyTarget.findUnique({
    where: { portfolioId_date: { portfolioId, date: today } }
  });

  const targetContext = dailyTarget
    ? `Today's earning target: ${dailyTarget.aiTarget} INR. Earned so far: ${dailyTarget.earnedActual} INR. Gap: ${dailyTarget.aiTarget - dailyTarget.earnedActual} INR.`
    : 'No daily target set yet.';

  const prompt = `You are an expert Indian stock market trader. Generate specific, actionable trade signals for this investor.

${profileBrief}

Available Cash: ${cash.toLocaleString('en-IN')} INR
${targetContext}

Generate trade signals (BUY and/or SELL) that:
1. Are realistic and executable on NSE/BSE today
2. Match the investor's risk profile
3. For SELL signals: only suggest stocks already in holdings
4. For BUY signals: consider available cash and suggest quantity affordable within it
5. Include specific entry price/zone and confidence level
6. Prioritize signals that help achieve the daily target

Respond in this EXACT JSON format (no markdown, no extra text):
{
  "signals": [
    {
      "symbol": "SYMBOL",
      "exchange": "NSE",
      "side": "BUY",
      "quantity": 10,
      "triggerType": "MARKET",
      "triggerPrice": null,
      "triggerLow": null,
      "triggerHigh": null,
      "confidence": 75,
      "rationale": "Brief reason for this signal"
    }
  ]
}

Rules:
- Maximum 5 signals total (mix of BUY and SELL as appropriate)
- triggerType can be MARKET (execute now), LIMIT (at specific price), or ZONE (between triggerLow and triggerHigh)
- For MARKET orders, triggerPrice/triggerLow/triggerHigh should be null
- For LIMIT orders, set triggerPrice
- For ZONE orders, set triggerLow and triggerHigh
- confidence is 0-100 (how confident you are in this signal)
- If no good signals exist, return empty array`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    if (!result.signals || !Array.isArray(result.signals)) {
      return [];
    }

    // Set expiry to end of today (3:30 PM IST = 10:00 UTC)
    const expiresAt = new Date();
    expiresAt.setUTCHours(10, 0, 0, 0);
    if (expiresAt <= new Date()) {
      // If already past 3:30 PM IST, expire tomorrow
      expiresAt.setDate(expiresAt.getDate() + 1);
    }

    // Create signals in DB
    const createdSignals = [];
    for (const sig of result.signals.slice(0, 5)) {
      try {
        const created = await prisma.tradeSignal.create({
          data: {
            portfolioId,
            symbol: sig.symbol,
            exchange: sig.exchange || 'NSE',
            side: sig.side,
            quantity: Math.max(1, parseInt(sig.quantity) || 1),
            triggerType: sig.triggerType || 'MARKET',
            triggerPrice: sig.triggerPrice ? parseFloat(sig.triggerPrice) : null,
            triggerLow: sig.triggerLow ? parseFloat(sig.triggerLow) : null,
            triggerHigh: sig.triggerHigh ? parseFloat(sig.triggerHigh) : null,
            confidence: Math.min(100, Math.max(0, parseInt(sig.confidence) || 50)),
            rationale: sig.rationale || null,
            status: 'PENDING',
            expiresAt
          }
        });
        createdSignals.push(created);
      } catch (err) {
        logger.error(`Failed to create signal for ${sig.symbol}:`, err.message);
      }
    }

    logger.info(`Generated ${createdSignals.length} trade signals for portfolio ${portfolioId}`);
    return createdSignals;
  } catch (error) {
    logger.error('Signal generation failed:', error.message);
    return [];
  }
}

/**
 * Expire old pending signals (past their expiresAt).
 */
export async function expireOldSignals() {
  const now = new Date();
  const result = await prisma.tradeSignal.updateMany({
    where: {
      status: 'PENDING',
      expiresAt: { lt: now }
    },
    data: { status: 'EXPIRED' }
  });

  if (result.count > 0) {
    logger.info(`Expired ${result.count} old trade signals`);
  }
}

export default {
  generateTradeSignals,
  expireOldSignals
};

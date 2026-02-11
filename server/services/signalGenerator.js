import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import { buildProfileBrief } from './advancedScreener.js';
import { fetchMarketContext } from './marketData.js';
import { ANALYST_IDENTITY, MARKET_DATA_INSTRUCTION, buildAccountabilityScorecard } from './analystPrompts.js';
import logger from './logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Generate BUY/SELL trade signals for a portfolio using AI.
 * Signals are actionable: specific symbol, side, quantity, trigger.
 *
 * @param {number} portfolioId
 * @param {string} extraContext - Additional context (e.g., unfilled signals warning)
 * @returns {Promise<Array>} Created TradeSignal records
 */
export async function generateTradeSignals(portfolioId, extraContext = '') {
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
    ? `Today's earning target: ₹${dailyTarget.aiTarget}. Earned so far: ₹${dailyTarget.earnedActual}. Gap: ₹${(dailyTarget.aiTarget - dailyTarget.earnedActual).toFixed(0)}.`
    : '';

  // Fetch real market data
  let marketContext = '';
  try {
    marketContext = await fetchMarketContext(portfolio.holdings || []);
  } catch (e) {
    logger.warn('Could not fetch market context for signal generation:', e.message);
  }

  // Build accountability scorecard
  let scorecard = '';
  try {
    scorecard = await buildAccountabilityScorecard(portfolioId);
  } catch (e) {
    logger.warn('Could not build scorecard:', e.message);
  }

  const prompt = `${ANALYST_IDENTITY}

${marketContext}
${MARKET_DATA_INSTRUCTION}

${scorecard}

${profileBrief}

Available Cash: ₹${cash.toLocaleString('en-IN')}
${targetContext}
${extraContext}

GENERATE TRADE SIGNALS NOW.

Scan the ENTIRE Indian market — Nifty 50, Nifty Next 50, Nifty Midcap 150, Nifty Smallcap 250, and sectoral indices. Don't limit yourself to a handful of popular names. Find the best risk-reward setups across ALL sectors and market caps.

For each signal, provide:
1. THE THESIS: Why this stock, why now? What's the catalyst? (earnings beat, sector rotation, technical breakout, policy tailwind, valuation gap)
2. THE TRADE: Exact entry, target, stop-loss. Risk-reward ratio must be at least 2:1
3. THE INVALIDATION: What kills this trade? At what price/event do you admit you're wrong?
4. POSITION SIZING: Quantity based on available cash and risk profile — don't over-concentrate

${scorecard ? 'IMPORTANT: Review your previous calls above. If any call went wrong, factor that into your new recommendations. If a stock you previously recommended is still a good setup, you can re-recommend with updated levels. Own your track record.' : ''}

Rules:
- Mix of BUY and SELL signals as the market dictates
- SELL signals: ONLY for stocks already in holdings. If a holding has a broken thesis, say EXIT
- BUY signals: Must be affordable within available cash. Calculate quantity at current market price
- Be BOLD but DISCIPLINED: high conviction calls with defined risk
- Confidence 80+ = "I'm putting my reputation on this", 60-79 = "Good setup, worth the risk", below 60 = don't bother including it
- If the market setup is genuinely bad today (gap down, global crisis), it's OK to return fewer signals or mostly SELL/EXIT signals. Don't force trades

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
      "confidence": 85,
      "rationale": "THESIS: [why]. CATALYST: [what triggers]. R:R 2.5:1. Stop at ₹X invalidates if [condition]."
    }
  ]
}

Technical notes:
- Maximum 5 signals (quality over quantity)
- triggerType: MARKET (execute now), LIMIT (at specific price), ZONE (between triggerLow and triggerHigh)
- MARKET orders: triggerPrice/triggerLow/triggerHigh = null
- LIMIT orders: set triggerPrice
- ZONE orders: set triggerLow and triggerHigh
- confidence: 0-100 (minimum 60 to be worth including)
- If genuinely no good setups exist today, return empty array — never force a bad trade`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
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

import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import { buildProfileBrief, buildPortfolioAudit, buildGrowthDirective } from './advancedScreener.js';
import { fetchMarketContext } from './marketData.js';
import { ANALYST_IDENTITY, ELITE_TRADER_EDGE, MARKET_DATA_INSTRUCTION, buildAccountabilityScorecard } from './analystPrompts.js';
import { getEffectiveCash, validateSignals } from './capitalGuard.js';
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
  const { effectiveCash, reservedCash, rawCash } = await getEffectiveCash(portfolioId);

  // Build portfolio audit and growth directive
  const portfolioAudit = buildPortfolioAudit(portfolio, effectiveCash, reservedCash);
  const growthDirective = buildGrowthDirective(portfolio);

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

${ELITE_TRADER_EDGE}

${growthDirective}

${marketContext}
${MARKET_DATA_INSTRUCTION}

${scorecard}

${portfolioAudit}

${profileBrief}

AVAILABLE CAPITAL: ₹${effectiveCash.toLocaleString('en-IN')} deployable cash (₹${reservedCash.toFixed(0)} reserved by pending signals).
${targetContext}
${extraContext}

${portfolio.broker === 'UPSTOX' && portfolio.apiEnabled ? `UPSTOX LIVE TRADING — ONE TAP EXECUTION:
Signals hit the investor's Telegram with an Execute button that fires the Upstox API immediately.
- ONLY NSE_EQ CNC delivery. No intraday, no F&O.
- LIMIT orders strongly preferred — locks in entry and gives one last look before the order flies.
- Entry levels must be REALISTIC for today's price action. Don't price entries so tight they never fill.
- Since capital is ₹${effectiveCash.toLocaleString('en-IN')}, 2–3 focused bets > 5 spread bets. Concentrate on your highest conviction setups.
` : ''}
PORTFOLIO AUDIT DIRECTIVE:
1. BROKEN THESIS → SELL: Any holding where the original reason to buy no longer holds. Sentiment, momentum, or fundamentals have turned. Cut it and redeploy.
2. OVERWEIGHT → TRIM: Any single position >20% of portfolio. Lock profits, rebalance.
3. IDLE CASH → DEPLOY: Find the highest momentum setups available right now and put capital to work.

WEALTH MULTIPLICATION MANDATE — GENERATE SIGNALS NOW:

This is not about preserving capital. It is about MULTIPLYING it. Think like a prop desk:
- Follow the sector ETF data above. Money rotates — align every BUY with the sector wind at your back.
- MOMENTUM is the edge: stocks breaking out of ranges, leading their sector, showing delivery volume spikes. These are the trades that make 8–15% in days, not weeks.
- Scan Nifty 50, Nifty Next 50, Nifty Midcap 150, sectoral leaders. Use your knowledge of valuations, PE ranges, and institutional positioning to find asymmetric setups.

For every signal:
1. THE SETUP: Sector momentum + stock-level catalyst (breakout, earnings, policy, institutional accumulation). Why NOW, not tomorrow?
2. THE TRADE: Entry, target, stop. Minimum R:R 2.5:1 — target 3:1. Be specific — "entry ₹342, target ₹378, stop ₹326".
3. THE EDGE: What does the market not yet see? Delivery volume, option OI buildup, bulk deal, sector rotation — what is the INSTITUTIONAL signal here?
4. THE SIZE: ₹${effectiveCash.toLocaleString('en-IN')} available. Conviction ≥85% → size 25–30%. Conviction 70–84% → 15–20%. Below 70% → skip it.

${scorecard ? 'ACCOUNTABILITY: Your previous calls are above. Own the wins and own the losses. Adjust your conviction levels based on what has worked. If a setup is still valid, re-enter with updated levels. Never abandon a working thesis just because the first attempt was wrong.' : ''}

RULES (non-negotiable):
- BUY capital constraint: sum of (quantity × price) for ALL BUY signals ≤ ₹${effectiveCash.toLocaleString('en-IN')}. Verify your math before responding — show it in capitalCheck.
- SELL signals ONLY for stocks you currently hold. If the thesis is broken, EXIT decisively.
- Confidence minimum 70 to include a signal. Below that, the R:R doesn't justify the capital at risk.
- In a risk-off market (Gold up, broad indices weak): prioritise SELL/TRIM signals and only add high-conviction BUYs with tight stops.
- Return fewer signals rather than forcing marginal trades. 2 great signals beat 5 mediocre ones every time.

Respond in this EXACT JSON format (no markdown, no extra text):
{
  "signals": [
    {
      "symbol": "SYMBOL",
      "exchange": "NSE",
      "side": "BUY",
      "quantity": 10,
      "price": 150.00,
      "triggerType": "MARKET",
      "triggerPrice": null,
      "triggerLow": null,
      "triggerHigh": null,
      "confidence": 85,
      "rationale": "CAPITAL: 10×₹150=₹1,500. THESIS: [why]. CATALYST: [what triggers]. R:R 2.5:1. Stop at ₹X invalidates if [condition]."
    }
  ],
  "capitalCheck": "Signal 1: 10×₹150=₹1,500. Total: ₹1,500 / ₹${effectiveCash.toLocaleString('en-IN')} available = OK"
}

Technical notes:
- Maximum 5 signals (quality over quantity)
- triggerType: MARKET (execute now), LIMIT (at specific price), ZONE (between triggerLow and triggerHigh)
- MARKET orders: set "price" field to the current approximate market price (for capital validation). triggerPrice/triggerLow/triggerHigh = null
- LIMIT orders: set triggerPrice
- ZONE orders: set triggerLow and triggerHigh
- EVERY signal MUST include a "price" field with the approximate current price of the stock — this is mandatory for capital validation
- confidence: 0-100 (minimum 60 to be worth including)
- CRITICAL CAPITAL CHECK: Before finalizing your response, add up (quantity × price) for ALL BUY signals. If the total exceeds ₹${effectiveCash.toLocaleString('en-IN')}, you MUST reduce quantities or remove signals until the total fits. Show your math in the rationale of the first signal.
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

    // Capital guard: validate signals against effective cash
    const validatedSignals = await validateSignals(result.signals, portfolioId);

    // Set expiry to end of today (3:30 PM IST = 10:00 UTC)
    const expiresAt = new Date();
    expiresAt.setUTCHours(10, 0, 0, 0);
    if (expiresAt <= new Date()) {
      expiresAt.setDate(expiresAt.getDate() + 1);
    }

    // Create signals in DB
    const createdSignals = [];
    for (const sig of validatedSignals.slice(0, 5)) {
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

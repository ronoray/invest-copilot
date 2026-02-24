import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import { buildProfileBrief, buildPortfolioAudit, buildGrowthDirective } from './advancedScreener.js';
import { fetchMarketContext } from './marketData.js';
import { ANALYST_IDENTITY, ELITE_TRADER_EDGE, MARKET_DATA_INSTRUCTION, TECHNICAL_FRAMEWORK, buildAccountabilityScorecard } from './analystPrompts.js';
import { getEffectiveCash, validateSignals } from './capitalGuard.js';
import { buildHoldingsTechnicals, getMarketRegime } from './technicalAnalysis.js';
import { scanTradingUniverse } from './opportunityScanner.js';
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

  // Fetch technical analysis — market regime + holdings state + opportunity scan
  // All data is cached per day at 8:30 AM; these calls are free (cache hits) by 9:30 AM
  let marketRegime = { regime: 'UNKNOWN', rationale: '', details: '', aggressionMultiplier: 0.8 };
  let holdingsTech = '';
  let universeScan = '';
  try {
    [marketRegime, holdingsTech, universeScan] = await Promise.all([
      getMarketRegime(),
      buildHoldingsTechnicals(portfolio.holdings || [], false), // false = no sleep (cache warm)
      scanTradingUniverse(),
    ]);
  } catch (e) {
    logger.warn('Could not fetch technical context:', e.message);
  }

  // Fetch real market data
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

  // Regime-adjusted sizing multiplier → adjusts conviction thresholds and position sizes
  const aggMult = marketRegime.aggressionMultiplier ?? 0.8;
  const minConviction = aggMult < 0.6 ? 78 : aggMult < 0.8 ? 72 : 68;
  const maxPosPct     = aggMult < 0.6 ? 20 : aggMult < 0.8 ? 25 : 30;

  const prompt = `${ANALYST_IDENTITY}

${ELITE_TRADER_EDGE}

${TECHNICAL_FRAMEWORK}

${growthDirective}

=== MARKET REGIME — READ THIS FIRST ===
${marketRegime.details}
${marketRegime.rationale}
Aggression multiplier: ${(aggMult * 100).toFixed(0)}% of normal sizing
=== END MARKET REGIME ===

${marketContext}
${MARKET_DATA_INSTRUCTION}

${holdingsTech ? holdingsTech + '\n' : ''}
${universeScan ? universeScan + '\n' : ''}
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
1. BROKEN THESIS → SELL: Any holding where the original reason to buy no longer holds. Sentiment, momentum, or fundamentals have turned. Cut it and redeploy — check the technical state above.
2. OVERWEIGHT → TRIM: Any single position >20% of portfolio. Lock profits, rebalance. RSI > 72 = trim first, ask questions later.
3. IDLE CASH → DEPLOY: The opportunity scan above shows which setups are live RIGHT NOW. These are data-confirmed, not guesses.

WEALTH MULTIPLICATION MANDATE — GENERATE SIGNALS NOW:

This is not about preserving capital. It is about MULTIPLYING it. Think like a prop desk with institutional discipline:
- The technical data above is REAL. Use it. RSI + EMA alignment tells you timing. Volume confirms the move. ATR sizes the stop.
- ONLY trade setups in the opportunity scan: STRONG UPTREND or PULLBACK IN UPTREND with RSI not overbought. These are Grade A and B setups.
- MOMENTUM is the edge: stocks in confirmed uptrends with volume 1.2x+ average. These are where institutional money is flowing.
- Sector ETF data above tells you where market money is rotating. Align every BUY with sector momentum at your back.

For every signal you generate:
1. THE SETUP: Reference the technical data provided — which specific indicator confirms the entry? (e.g., "RSI at 52 in STRONG UPTREND with 1.4x volume = Grade A momentum buy")
2. THE TRADE: Entry = EMA level or breakout level from the data. Target = entry + 3× ATR minimum. Stop = entry − 1.5× ATR.
3. THE EDGE: What does the market not yet see? Delivery volume, sector rotation, institutional accumulation — the INSTITUTIONAL signal.
4. THE SIZE: Regime = ${marketRegime.regime}. Max single position = ${maxPosPct}% of ₹${effectiveCash.toLocaleString('en-IN')}. Confidence ≥85% → ${maxPosPct}%. Confidence 70-84% → ${Math.round(maxPosPct * 0.7)}%. Below ${minConviction}% → skip.

${scorecard ? 'ACCOUNTABILITY: Your previous calls are above. Own the wins and losses. If a setup is still technically valid (trend intact, RSI not extreme), re-enter with fresh ATR-based levels. Never re-enter if technical state has deteriorated.' : ''}

RULES (non-negotiable):
- BUY capital constraint: sum of (quantity × price) for ALL BUY signals ≤ ₹${effectiveCash.toLocaleString('en-IN')}. Verify your math — show it in capitalCheck.
- SELL signals ONLY for stocks you currently hold. Check the holdings technical state — if RSI > 72 + EMA20 losing support, EXIT.
- Confidence minimum ${minConviction} in ${marketRegime.regime} regime. Below that, the R:R doesn't justify the capital risk.
- Return fewer signals rather than forcing marginal trades. 2 Grade A signals beat 5 marginal ones every time.
- If the regime is BEAR or HIGH_VOL_BEAR: generate SELL/TRIM signals first, then only add longs with R:R ≥ 4:1.
- If genuinely no Grade A or B setups exist, return empty array — never force a bad trade.

Respond in this EXACT JSON format (no markdown, no extra text):
{
  "signals": [
    {
      "symbol": "SYMBOL",
      "exchange": "NSE",
      "side": "BUY",
      "quantity": 10,
      "price": 150.00,
      "triggerType": "LIMIT",
      "triggerPrice": 149.00,
      "triggerLow": null,
      "triggerHigh": null,
      "confidence": 85,
      "rationale": "CAPITAL: 10×₹150=₹1,500. SETUP: RSI 52 (neutral→strengthening) + STRONG UPTREND + Vol 1.4x = Grade A momentum. ENTRY: ₹149 (EMA20 retest). TARGET: ₹163 (3×ATR=₹14). STOP: ₹143 (1.5×ATR=₹7). R:R 2.1:1. CATALYST: [what triggers]. INVALIDATION: close below EMA50 ₹138."
    }
  ],
  "capitalCheck": "Signal 1: 10×₹150=₹1,500. Total: ₹1,500 / ₹${effectiveCash.toLocaleString('en-IN')} available = OK"
}

Technical notes:
- Maximum 5 signals (quality over quantity)
- triggerType: MARKET (execute now), LIMIT (at specific price — preferred), ZONE (between triggerLow and triggerHigh)
- MARKET orders: set "price" to approximate current market price. triggerPrice/triggerLow/triggerHigh = null
- LIMIT orders: set triggerPrice (should be at or below current price for BUYs — EMA20/50 retest levels preferred)
- ZONE orders: set triggerLow and triggerHigh
- EVERY signal MUST include "price" field — this is mandatory for capital validation
- confidence: 0-100 (minimum ${minConviction} in current ${marketRegime.regime} regime)
- CRITICAL: Before finalizing, add up (quantity × price) for ALL BUY signals. If total > ₹${effectiveCash.toLocaleString('en-IN')}, reduce quantities until it fits. Show math in capitalCheck.`;

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

import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import { buildProfileBrief, buildPortfolioAudit, buildGrowthDirective, buildPortfolioTrajectory } from './advancedScreener.js';
import { fetchMarketContext } from './marketData.js';
import { ANALYST_IDENTITY, ELITE_TRADER_EDGE, MARKET_DATA_INSTRUCTION, TECHNICAL_FRAMEWORK, buildAccountabilityScorecard } from './analystPrompts.js';
import { getEffectiveCash, validateSignals } from './capitalGuard.js';
import { buildHoldingsTechnicals, getMarketRegime } from './technicalAnalysis.js';
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

  // Build portfolio audit, trajectory, and growth directive
  const portfolioAudit  = buildPortfolioAudit(portfolio, effectiveCash, reservedCash);
  const trajectory      = buildPortfolioTrajectory(portfolio);
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

  // Fetch technical analysis — market regime + held position technicals
  // Data cached at 8:30 AM pre-market; these are free cache hits by 9:30 AM
  let marketRegime = { regime: 'UNKNOWN', rationale: '', details: '', aggressionMultiplier: 0.8 };
  let holdingsTech = '';
  try {
    [marketRegime, holdingsTech] = await Promise.all([
      getMarketRegime(),
      buildHoldingsTechnicals(portfolio.holdings || [], false),
    ]);
  } catch (e) {
    logger.warn('Could not fetch technical context:', e.message);
  }

  // Market stress detection — determines if we're in crash/defensive mode
  const isStressed = marketRegime.regime === 'HIGH_VOL_BEAR' ||
    (marketRegime.regime === 'BEAR' && marketRegime.aggressionMultiplier <= 0.5);

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

  const aggMult      = marketRegime.aggressionMultiplier ?? 0.8;
  const minConviction = aggMult < 0.6 ? 80 : aggMult < 0.8 ? 74 : 68;
  const maxPosPct     = aggMult < 0.6 ? 18 : aggMult < 0.8 ? 25 : 30;

  // Two completely different mandates: stressed market vs normal
  const mandate = isStressed ? `
⚠️ MARKET STRESS MODE — CAPITAL PROTECTION FIRST ⚠️

The regime data above shows this market is under meaningful stress (${marketRegime.regime}).
This is NOT a normal trading environment. Your mandate changes completely:

PRIORITY 1 — REVIEW EVERY HOLDING FOR EXIT:
- Check the technical state of each holding above. If a holding is below EMA20 with RSI < 40 and deteriorating volume, that is a broken position. Exit it.
- "Hoping it comes back" is not a strategy. Capital preserved is capital available to deploy at the bottom.
- Generate SELL signals for any holding that is technically broken, fundamentally thesis-changed, or positioned poorly for this environment.

PRIORITY 2 — LOOK FOR ASYMMETRIC CRASH OPPORTUNITIES:
- Extreme fear creates extreme opportunity. If any sector or stock is DEEPLY OVERSOLD (RSI < 25) with fundamentals intact and institutional buying showing in delivery volumes, that is a potential asymmetric long.
- These are contrarian entries, not momentum plays. They require wider stops and smaller size.
- Only recommend if R:R is at minimum 5:1 and the fundamental thesis is UNAMBIGUOUSLY intact.

PRIORITY 3 — PROTECT THE CASH:
- Cash is a position in a stressed market. If there are no obvious exits AND no asymmetric longs, return empty signals array. Preserve capital to deploy when clarity returns.
- Do not force trades to "be doing something". The best trade right now might be no trade.

In a crash, the investor who holds cash deploys at the bottom and multiplies wealth. The investor who stays invested loses 30–40% and spends years recovering.
` : `
FULL MARKET SCAN — GENERATE WEALTH SIGNALS NOW:

Your scanning universe is the ENTIRE NSE: Nifty 50, Nifty Next 50, Nifty Midcap 150, Nifty Smallcap 250, all sectoral indices, all thematic plays. You are NOT limited to any pre-selected list. You know EVERY major company in India — their valuations, growth trajectories, sector dynamics, and current positioning.

TODAY'S MARKET DYNAMICS — WHAT TELLS YOU WHERE TO LOOK:
1. The sector ETF performance above tells you WHERE money is flowing RIGHT NOW. If BANKBEES is up 1.5%, banking stocks are the hunting ground. If ITBEES is lagging, avoid IT. Follow the sector momentum.
2. The market regime (${marketRegime.regime}) tells you HOW to trade. Use it to calibrate aggression and setup quality threshold.
3. Your holdings' technical state tells you WHEN to sell. RSI > 72 + EMA20 breaking = trim. Below EMA50 with deteriorating volume = exit.
4. Your training knowledge covers: RBI cycle impacts on banking, crude oil correlations with ONGC/BPCL/RELIANCE, PLI scheme beneficiaries, defense capex plays, RE sector dynamics, PSU re-rating cycles, IT deal flow patterns, FMCG rural recovery themes, hospital sector consolidation, chemical sector China+1 plays, auto EV transition winners. USE ALL OF IT.

HOW TO BUILD TODAY'S SIGNALS:
Step 1 — Read today's sector rotation from the ETF data above. Which 2-3 sectors have wind at their back today?
Step 2 — Within those sectors, scan your knowledge for: the strongest fundamental story + best technical setup. Not just large-caps — if a midcap has a better setup, use it.
Step 3 — For each candidate: What is the SPECIFIC catalyst that makes this a TODAY trade? Is it breakout from consolidation? EMA20 retest in uptrend? Sector ETF momentum pulling it up? Earnings event? Policy catalyst?
Step 4 — Size it properly: ATR-based stop (1.5× ATR), target 3× ATR minimum. If the stop would risk >3% of portfolio, reduce quantity, not stop distance.

THE EDGE YOU LOOK FOR:
- Stocks where the sector is running but the specific company hasn't moved yet (sector rotation lag)
- Companies with strong delivery volume patterns indicating institutional accumulation
- Stocks consolidating near 52-week highs with rising volume — breakout imminent
- Quality names at EMA50 support after a market-wide pullback — institutional buyers waiting there
- Policy/regulatory catalysts not yet priced in (budget allocations, order wins, capacity expansion)

BALANCE: This is not about being safe. It's about being SMART about risk:
- Take real positions. Idle cash doesn't grow wealth.
- Size based on conviction — don't put 5% into a 90% conviction trade. That's wasted edge.
- But always have an invalidation level. Know exactly what would make you wrong and place the stop there.
- The goal: maximum capture of today's specific market opportunity with defined downside on every trade.
`;

  const prompt = `${ANALYST_IDENTITY}

${ELITE_TRADER_EDGE}

${TECHNICAL_FRAMEWORK}

${growthDirective}

${trajectory}

=== MARKET REGIME — READ THIS FIRST ===
${marketRegime.details}
${marketRegime.rationale}
${isStressed ? '🔴 STRESS MODE ACTIVE — See mandate below' : `Aggression: ${(aggMult * 100).toFixed(0)}% of normal sizing`}
=== END MARKET REGIME ===

${marketContext}
${MARKET_DATA_INSTRUCTION}

${holdingsTech ? holdingsTech + '\n' : ''}
${scorecard}

${portfolioAudit}

${profileBrief}

AVAILABLE CAPITAL: ₹${effectiveCash.toLocaleString('en-IN')} deployable cash (₹${reservedCash.toFixed(0)} reserved by pending signals).
${targetContext}
${extraContext}

${portfolio.broker === 'UPSTOX' && portfolio.apiEnabled ? `UPSTOX LIVE TRADING — ONE TAP EXECUTION:
- ONLY NSE_EQ CNC delivery. No intraday, no F&O.
- LIMIT orders strongly preferred — realistic entry levels that will actually fill.
- Capital: ₹${effectiveCash.toLocaleString('en-IN')}. 2–3 focused positions > 5 spread positions. Concentrate on highest conviction.
` : ''}
${mandate}

${scorecard ? `ACCOUNTABILITY: Your previous calls are above. Own every outcome. If a setup remains technically valid, re-enter with updated levels. If conditions have changed, say so and move on.` : ''}

HARD RULES — NEVER VIOLATED:
- BUY capital: sum of (quantity × price) for ALL BUY signals ≤ ₹${effectiveCash.toLocaleString('en-IN')}. Verify math in capitalCheck.
- SELL signals ONLY for stocks actually held. No phantom sells.
- Minimum confidence: ${minConviction}. Below this, skip it — the R:R doesn't compensate.
- ${isStressed ? 'In stress mode: no BUY signals unless R:R ≥ 5:1 and deeply oversold.' : '2 great signals beat 5 marginal ones. Quality over quantity, always.'}
- If no genuinely good setups exist: return empty array. Never force a bad trade.

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
      "rationale": "CAPITAL: 10×₹150=₹1,500. SECTOR: [sector momentum context]. SETUP: [technical state + why today specifically]. ENTRY: ₹149 (why this level). TARGET: ₹163. STOP: ₹143. R:R [X]:1. CATALYST: [what triggers the move]. INVALIDATION: [what kills the thesis]."
    }
  ],
  "capitalCheck": "Signal 1: 10×₹150=₹1,500. Total: ₹1,500 / ₹${effectiveCash.toLocaleString('en-IN')} available = OK"
}

Notes:
- Maximum 5 signals
- triggerType: MARKET, LIMIT (preferred), or ZONE
- EVERY signal needs "price" field for capital validation
- confidence: 0-100 (min ${minConviction})
- CRITICAL: Total BUY cost must not exceed ₹${effectiveCash.toLocaleString('en-IN')}. Show math.`;

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

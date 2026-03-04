import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import { buildProfileBrief, buildPortfolioAudit, buildGrowthDirective, buildPortfolioTrajectory } from './advancedScreener.js';
import { fetchMarketContext } from './marketData.js';
import { ANALYST_IDENTITY, ELITE_TRADER_EDGE, MARKET_DATA_INSTRUCTION, TECHNICAL_FRAMEWORK, buildAccountabilityScorecard } from './analystPrompts.js';
import { getEffectiveCash, validateSignals } from './capitalGuard.js';
import { buildHoldingsTechnicals, getMarketRegime } from './technicalAnalysis.js';
import { fetchPreMarketNews, fetchRecentIPOContext } from './marketNews.js';
import { getUpstoxLTP } from './upstoxMarketData.js';
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

  // Fetch live Upstox open orders to prevent duplicates and use accurate cash
  let liveOpenOrders = [];
  let liveCash = null;
  try {
    const { getFunds, getOrderBook } = await import('./upstoxService.js');
    const upstoxIntegration = await prisma.upstoxIntegration.findFirst({
      where: { userId: portfolio.userId }
    });
    if (upstoxIntegration) {
      const [fundsResult, orderResult] = await Promise.allSettled([
        getFunds(portfolio.userId),
        getOrderBook(portfolio.userId)
      ]);
      if (fundsResult.status === 'fulfilled') {
        liveCash = fundsResult.value?.availableMargin ?? null;
      }
      if (orderResult.status === 'fulfilled') {
        liveOpenOrders = (orderResult.value?.orders || []).filter(o => {
          const s = (o.status || '').toLowerCase();
          return s === 'open' || s === 'trigger pending' || s === 'put order req received';
        });
      }
    }
  } catch (e) {
    logger.warn('[SignalGen] Could not fetch live Upstox data:', e.message);
  }

  // Also fetch active DB signals (PENDING/ACKED/SNOOZED/PLACING) — these are not on Upstox yet
  // but represent the user's current intent. We must not regenerate signals for the same symbol:side.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const activeDbSignals = await prisma.tradeSignal.findMany({
    where: {
      portfolioId,
      status: { in: ['PENDING', 'ACKED', 'SNOOZED', 'PLACING'] },
      createdAt: { gte: today }
    },
    select: { symbol: true, side: true }
  });

  const { effectiveCash: dbEffectiveCash, reservedCash, rawCash } = await getEffectiveCash(portfolioId);
  // Prefer live Upstox funds (accurate) over stale DB cash
  const effectiveCash = liveCash !== null ? liveCash : dbEffectiveCash;

  // Build portfolio audit, trajectory, and growth directive
  const portfolioAudit  = buildPortfolioAudit(portfolio, effectiveCash, reservedCash);
  const trajectory      = buildPortfolioTrajectory(portfolio);
  const growthDirective = buildGrowthDirective(portfolio);

  // Get today's target for context (reuses `today` declared above)
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
  let marketContext = '';
  try {
    marketContext = await fetchMarketContext(portfolio.holdings || []);
  } catch (e) {
    logger.warn('Could not fetch market context for signal generation:', e.message);
  }

  // Pre-market news intelligence (VIX, FII/DII, announcements for held stocks)
  let newsContext = '';
  let ipoContext = '';
  try {
    const holdingSymbols = (portfolio.holdings || []).map(h => h.symbol);
    [newsContext, ipoContext] = await Promise.all([
      fetchPreMarketNews(holdingSymbols),
      fetchRecentIPOContext(),
    ]);
  } catch (e) {
    logger.warn(`[SignalGen] News/IPO fetch failed: ${e.message}`);
  }

  // Macro intelligence: GOLDBEES direction as fear/risk-off gauge
  // Gold rising = fear premium / geopolitical risk being priced in → likely situational fall
  // Gold falling = fear subsiding, risk appetite returning → recovery conditions developing
  let macroContext = '';
  try {
    const { fetchDailyData } = await import('./marketIntelligence.js');
    const goldData = await fetchDailyData('GOLDBEES');
    if (goldData?.series?.length >= 5) {
      const recent = goldData.series.slice(-5);
      const goldChangePct = ((recent[recent.length - 1].close - recent[0].close) / recent[0].close * 100);
      const goldDir = goldChangePct > 0.8 ? 'RISING' : goldChangePct < -0.8 ? 'FALLING' : 'FLAT';
      const goldSignal = goldDir === 'RISING'
        ? `Gold (GOLDBEES) is up ${goldChangePct.toFixed(1)}% over 5 days — RISK-OFF. Fear or geopolitical premium is being priced in. If the broader market is also falling, this is likely a SITUATIONAL fall, not structural. Quality stocks with intact fundamentals are approaching buying opportunities. Use limit orders at support.`
        : goldDir === 'FALLING'
        ? `Gold (GOLDBEES) is down ${Math.abs(goldChangePct).toFixed(1)}% over 5 days — RISK-ON. Fear premium is collapsing. Recovery and re-entry conditions are developing. Momentum setups in quality names deserve higher conviction.`
        : `Gold (GOLDBEES) is flat over 5 days — no strong macro risk signal. Trade the technicals and fundamentals directly.`;
      macroContext = `\n=== MACRO INTELLIGENCE ===\n${goldSignal}\n\nCRITICAL — DISTINGUISH THE FALL:\nBefore generating signals, explicitly reason: Is today's market weakness driven by FEAR (geopolitical, panic, short-term uncertainty) or FUNDAMENTALS (earnings deterioration, credit stress, structural slowdown)? A fear-driven fall in a fundamentally sound stock is a buying opportunity. A fundamental fall is an exit. Your knowledge of current global events, the company's earnings trajectory, and the gold signal above should inform this call.\n=== END MACRO INTELLIGENCE ===\n`;
    }
  } catch (e) {
    logger.warn('Could not build macro context:', e.message);
  }

  // Build accountability scorecard
  let scorecard = '';
  try {
    scorecard = await buildAccountabilityScorecard(portfolioId);
  } catch (e) {
    logger.warn('Could not build scorecard:', e.message);
  }

  const aggMult      = marketRegime.aggressionMultiplier ?? 0.8;
  const minConviction = 78; // Hard floor regardless of regime — below 78 means setup is not ready
  const maxPosPct     = aggMult < 0.6 ? 18 : aggMult < 0.8 ? 25 : 30;

  // Profit-taking candidates — holdings at or near the portfolio profit target
  // Use live LTP (Upstox real-time) so we never miss a target that has been hit
  // since the last DB price sync.
  const profitThreshold = (portfolio.profitTargetPct || 10) / 100;
  let holdingLTPMap = new Map();
  try {
    const heldSymbols = (portfolio.holdings || []).map(h => h.symbol).filter(Boolean);
    if (heldSymbols.length > 0) {
      holdingLTPMap = await getUpstoxLTP(heldSymbols);
    }
  } catch (e) {
    logger.warn('[SignalGen] Live LTP fetch for profit-taking check failed:', e.message);
  }

  const profitCandidates = (portfolio.holdings || []).filter(h => {
    const liveEntry = holdingLTPMap.get(h.symbol);
    const current = liveEntry?.price || parseFloat(h.currentPrice || 0);
    const avg = parseFloat(h.avgPrice || 0);
    if (!current || !avg || avg <= 0) return false;
    return (current - avg) / avg >= profitThreshold * 0.7; // alert at 70% of target
  });

  let profitTakingBlock = '';
  if (profitCandidates.length > 0) {
    const targetPct = portfolio.profitTargetPct || 10;
    const alertPct  = (targetPct * 0.7).toFixed(0);
    const totalProfit = profitCandidates.reduce((sum, h) => {
      const liveEntry = holdingLTPMap.get(h.symbol);
      const current = liveEntry?.price || parseFloat(h.currentPrice || 0);
      return sum + (current - parseFloat(h.avgPrice)) * h.quantity;
    }, 0);
    const candidateLines = profitCandidates.map(h => {
      const liveEntry = holdingLTPMap.get(h.symbol);
      const current = liveEntry?.price || parseFloat(h.currentPrice || 0);
      const avg     = parseFloat(h.avgPrice);
      const pnlPct  = ((current - avg) / avg * 100).toFixed(1);
      const pnlAmt  = ((current - avg) * h.quantity).toFixed(0);
      const src     = liveEntry ? 'live' : 'DB';
      return `- ${h.symbol}: avg ₹${avg.toFixed(2)} → now ₹${current.toFixed(2)} (+${pnlPct}% | ₹${pnlAmt} profit on ${h.quantity} shares) [${src}]`;
    }).join('\n');
    profitTakingBlock = `
🎯 PROFIT-TAKING MANDATE — NON-NEGOTIABLE:
These holdings have reached or are approaching the ${targetPct}% profit target. You MUST evaluate each for a SELL signal:

${candidateLines}

Rules:
1. P&L ≥ ${targetPct}%: Generate a SELL signal to lock in profits. Capturing ₹${totalProfit.toFixed(0)} IS the mission — not riding it back to zero.
2. P&L ≥ ${alertPct}% but below target: Generate SELL if technicals show topping (RSI > 70, price below EMA20, or bearish volume divergence).
3. Partial sells allowed: sell 50–75% to lock gains, keep 25–50% for further upside if momentum intact.
4. Profit-taking IS wealth creation. A booked ₹${totalProfit.toFixed(0)} compounds. An unrealised gain does not.

`;
  }

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

PRIORITY 3 — DEFENSIVE INTELLIGENCE (EMPTY IS VALID):
- If no exits are warranted AND no setup clears the 78 conviction threshold, return an empty signals array. Write the reason in capitalCheck: "Stress mode — no setup clears 78 conviction. Cash held. Monitoring [X] for entry at [level]." That IS professional analysis.
- Do NOT manufacture trades to fill the array. Forced low-conviction entries in a stressed market is how portfolios blow up. The correct position is sometimes cash.
- IF a genuinely compelling setup exists (quality stock at strong support, RSI < 35, fundamentals unambiguously intact, 5:1 R:R), generate it. The 78 floor still applies — raise your bar, not lower it.
- If you DO identify a high-conviction defensive LIMIT order (stock at key support, only fills if further weakness), include it. A well-placed limit order that never fills costs nothing. One that fills at the bottom is the year's best trade.

CRITICAL DISTINCTION — FEAR FALL vs STRUCTURAL FALL:
- FEAR FALL (geopolitical shock, short-term panic, macro uncertainty): Quality stocks fall with the market despite unchanged fundamentals. This is a BUYING OPPORTUNITY for names with strong earnings, domestic revenue, pricing power.
- STRUCTURAL FALL (earnings deterioration, rate cycle turning, credit stress): The fundamental investment thesis has changed. Exit and preserve capital.
- Reason explicitly about which type this is. Use your knowledge of current global events and the company's fundamentals to make this call.

In a fear-driven crash, the investor who has limit orders working at support captures the recovery. The investor who sits in cash watches quality stocks bounce 15% in 5 days without them.
` : `
FULL MARKET SCAN — GENERATE WEALTH SIGNALS NOW:

⚡ FIRST PRINCIPLE — ETFs DO NOT BUILD WEALTH:
BANKBEES, NIFTYBEES, ITBEES, GOLDBEES — these are INDEX RETURNS. At ₹20,000 capital, buying an ETF returns 12% annualised at best. That is not the goal. The goal is ALPHA — individual stocks that outperform the index by 2-5× over a 3-15 day swing.

ETF signals are ONLY acceptable in two narrow cases:
1. The ETF itself has a technically superior setup (e.g., NIFTYBEES breaking out of a 3-week consolidation with volume surge) AND no individual stock in that sector has a better setup
2. The regime is HIGH_VOL_BEAR and the only genuine edge is a defensive ETF hedge

In ALL other cases, the output MUST be individual stocks with specific company-level catalysts. If you are about to write "NIFTYBEES BUY" or "BANKBEES BUY", stop. Find the specific bank or the specific company within that sector that has the superior setup.

Your scanning universe is the ENTIRE NSE: Nifty 50, Nifty Next 50, Nifty Midcap 150, Nifty Smallcap 250, all sectoral indices, all thematic plays. You are NOT limited to any pre-selected list. You know EVERY major company in India — their valuations, growth trajectories, sector dynamics, and current positioning.

TODAY'S MARKET DYNAMICS — WHAT TELLS YOU WHERE TO LOOK:
1. Sector ETF performance above tells you WHERE to hunt for individual stocks — NOT to buy the ETF. BANKBEES up 1.5% = hunt for the specific bank that is breaking out. ITBEES lagging = avoid IT stocks entirely.
2. The market regime (${marketRegime.regime}) tells you HOW aggressive to be. Use it to calibrate conviction threshold and position sizing.
3. Your holdings' technical state tells you WHEN to sell. RSI > 72 + EMA20 breaking = trim. Below EMA50 with deteriorating volume = exit.
4. Your training knowledge covers: RBI cycle impacts on individual banks (ICICI vs HDFC vs Kotak), crude oil correlations (ONGC/BPCL/RELIANCE — pick the best setup), PLI beneficiaries (Dixon, Amber, Kaynes), defense capex plays (HAL, BEL, Data Patterns, MTAR), RE dynamics (Macrotech, Prestige, Sobha), PSU re-rating cycles (specific PSUs with order inflows), IT deal flow (TCS vs Infosys vs mid-tier like Persistent/Coforge), FMCG rural recovery (HUL vs Dabur vs Marico — who has pricing power NOW), hospital consolidation (Apollo vs Fortis vs Max), chemical China+1 (SRF, PI Industries, Aarti), auto EV transition (Tata Motors, Olectra, Uno Minda). APPLY COMPANY-LEVEL THINKING, NOT SECTOR-LEVEL.

HOW TO BUILD TODAY'S SIGNALS:
Step 1 — Read today's sector rotation from ETF data. Which 2-3 sectors have wind at their back?
Step 2 — Within those sectors, identify the SPECIFIC COMPANY with: (a) strongest fundamental story for THIS swing AND (b) best technical setup. Ask: why this company over its peers in the same sector?
Step 3 — For each candidate: What is the SPECIFIC catalyst for a 3-15 day swing? Breakout from consolidation? EMA20 retest in uptrend? Sector rotation lag (sector ETF already moved but this stock hasn't)? Earnings surprise? Institutional accumulation pattern?
Step 4 — Size it: ATR-based stop (1.5× ATR), target 3× ATR minimum. If stop risks >3% of ₹20,000 (i.e., >₹600), reduce quantity — never widen the stop.

THE ALPHA EDGE YOU HUNT FOR:
- Sector ETF has already moved 3% this week but one quality stock in that sector is still lagging by 2% — sector rotation lag, compression about to resolve
- Stock showing delivery volume surge (>2× 20-day avg) while price is still below resistance — institutional accumulation before breakout
- Quality company near EMA50 support while its sector ETF holds trend — classic institutional re-entry zone
- PLI/capex/policy beneficiary with order-win news (from NSE announcements injected above) — priced in over 3-15 days
- Midcap with improving fundamentals + technical momentum that large-cap peers don't have — disproportionate upside

BALANCE — SMART RISK, NOT SAFE RISK:
- Take real positions in individual stocks. ETF-only signals = index returns = wealth destruction by inflation.
- Size based on conviction: a 90% conviction trade deserves a full position, not a 5% nibble.
- But always have an invalidation level. Know exactly what makes you wrong and place the stop there.
- The goal: maximum capture of today's specific market opportunity in individual companies, with defined downside on every trade.
`;

  const nowIST = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata'
  });

  const prompt = `${ANALYST_IDENTITY}
CURRENT DATE: ${nowIST}. The Union Budget 2026 was presented on 1 February 2026 and is in effect. Do NOT reference pre-budget or 2025 narratives.

${ELITE_TRADER_EDGE}

${TECHNICAL_FRAMEWORK}

${growthDirective}

${trajectory}

=== MARKET REGIME — READ THIS FIRST ===
${marketRegime.details}
${marketRegime.rationale}
${isStressed ? '🔴 STRESS MODE ACTIVE — See mandate below' : `Aggression: ${(aggMult * 100).toFixed(0)}% of normal sizing`}
=== END MARKET REGIME ===
${newsContext}
${macroContext}
${ipoContext}
${marketContext}
${MARKET_DATA_INSTRUCTION}

${holdingsTech ? holdingsTech + '\n' : ''}
${scorecard}

${portfolioAudit}

${profileBrief}

AVAILABLE CAPITAL: ₹${effectiveCash.toLocaleString('en-IN')} deployable cash (live from Upstox).
${targetContext}
${(liveOpenOrders.length > 0 || activeDbSignals.length > 0) ? `
ALREADY COVERED — DO NOT DUPLICATE:
${liveOpenOrders.map(o => `- ${(o.transaction_type||'').toUpperCase()} ${o.tradingsymbol || o.trading_symbol}: ₹${o.price} × ${o.pending_quantity || o.quantity} shares [live on exchange]`).join('\n')}
${activeDbSignals.map(s => `- ${s.side} ${s.symbol} [queued signal, pending execution]`).join('\n')}

CRITICAL RULES:
1. Do NOT generate a new signal for any symbol:side above. These are already in the queue or on the exchange.
2. If you have a BUY and a SELL open for the same symbol, call it out clearly in the rationale.
3. Capital locked in open BUY orders is NOT available — already committed.
` : ''}${extraContext}

${portfolio.broker === 'UPSTOX' && portfolio.apiEnabled ? `UPSTOX LIVE TRADING — ONE TAP EXECUTION:
- ONLY NSE_EQ CNC delivery. No intraday, no F&O.
- LIMIT orders strongly preferred — realistic entry levels that will actually fill.
- Capital: ₹${effectiveCash.toLocaleString('en-IN')}. 2–3 focused positions > 5 spread positions. Concentrate on highest conviction.
` : ''}
${profitTakingBlock}${mandate}

${scorecard ? `ACCOUNTABILITY: Your previous calls are above. Own every outcome. If a setup remains technically valid, re-enter with updated levels. If conditions have changed, say so and move on.` : ''}

HARD RULES — NEVER VIOLATED:
- BUY capital: sum of (quantity × price) for ALL BUY signals ≤ ₹${effectiveCash.toLocaleString('en-IN')}. Verify math in capitalCheck.
- SELL signals ONLY for stocks actually held. No phantom sells.
- Minimum confidence: 78. Hard floor, no exceptions, no regime override. A setup you're not 78% sure about is a setup you should not take.
- ${isStressed ? 'Stress mode: BUY signals must be LIMIT orders at clear support. R:R ≥ 5:1 required.' : '2 great signals beat 5 marginal ones. Quality over quantity, always.'}
- An EMPTY signals array is a valid, professional output. If nothing clears 78, return: {"signals": [], "capitalCheck": "No qualifying setups today — conviction floor not met. Reason: [your analysis]. Cash held."}
- Do NOT manufacture signals to avoid an empty array. That is activity bias. The market does not always offer edge. Recognising when to sit on cash IS alpha.

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
      "rationale": "Write 2-3 sentences as a world-class fund manager speaking directly to the investor. Lead with WHY this trade makes sense TODAY — weave in what's happening in the world, what the company's actual situation is, and why this specific price level is the right entry. Include the key numbers naturally (e.g. 'entering at ₹149, targeting ₹163, stop at ₹143 — 4:1 reward'). End with one sentence on what would kill the thesis. Speak with conviction and clarity. No labels, no bullet points, no jargon — a human thought."
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
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    if (!result.signals || !Array.isArray(result.signals)) {
      return [];
    }

    // Empty array is valid — means Claude found no qualifying setups
    if (result.signals.length === 0) {
      logger.info(`[SignalGen] Portfolio ${portfolioId}: Claude returned no signals — ${result.capitalCheck || 'no qualifying setups'}`);
      return [];
    }

    // Capital guard: validate signals against effective cash
    const validatedSignals = await validateSignals(result.signals, portfolioId);

    // ── Hard conviction gate: 78 minimum — post-generation filter ────────────
    // Claude is instructed to self-filter, but this is the technical guarantee.
    const convictionFiltered = validatedSignals.filter(sig => {
      if ((sig.confidence ?? 0) < 78) {
        logger.info(`[SignalGen] Conviction gate: dropped ${sig.side} ${sig.symbol} at ${sig.confidence} (floor 78)`);
        return false;
      }
      return true;
    });
    if (convictionFiltered.length === 0) {
      logger.info(`[SignalGen] Portfolio ${portfolioId}: all signals filtered by conviction gate (floor 78)`);
      return [];
    }

    // ── Live price anchor: correct stale AI prices before saving ──────────────
    // Claude's training data prices can be months old. Fetch Upstox LTP for all
    // non-held BUY signals and correct any price > 20% off live market.
    try {
      const heldSymbols = new Set((portfolio.holdings || []).map(h => h.symbol));
      const buySymbolsNeedingCheck = convictionFiltered
        .filter(s => s.side === 'BUY' && !heldSymbols.has(s.symbol) && (s.triggerPrice || s.price))
        .map(s => s.symbol);

      if (buySymbolsNeedingCheck.length > 0) {
        const ltpMap = await getUpstoxLTP(buySymbolsNeedingCheck);
        for (const sig of convictionFiltered) {
          if (sig.side !== 'BUY' || heldSymbols.has(sig.symbol)) continue;
          const ltp = ltpMap.get(sig.symbol);
          if (!ltp?.price) continue;

          const sigPrice = parseFloat(sig.triggerPrice || sig.price || 0);
          if (!sigPrice) continue;
          const deviation = Math.abs(sigPrice - ltp.price) / ltp.price;
          if (deviation > 0.20) {
            // Correct to live price (1% below LTP for LIMIT headroom)
            const corrected = parseFloat((ltp.price * 0.99).toFixed(2));
            logger.warn(`[SignalGen] Price corrected for ${sig.symbol}: AI said ₹${sigPrice} vs live ₹${ltp.price} (${(deviation * 100).toFixed(1)}% off) → setting ₹${corrected}`);
            if (sig.triggerPrice) sig.triggerPrice = corrected;
            sig.price = corrected;
            // Also recalculate quantity so total cost stays within capital
            const newQty = Math.floor(effectiveCash * 0.30 / corrected); // max 30% of cash in one position
            if (newQty > 0 && newQty !== sig.quantity) {
              logger.warn(`[SignalGen] Quantity adjusted for ${sig.symbol}: ${sig.quantity} → ${newQty} (price corrected)`);
              sig.quantity = newQty;
            }
          }
        }
      }
    } catch (priceErr) {
      logger.warn(`[SignalGen] Live price anchor check failed: ${priceErr.message} — using AI prices as-is`);
    }

    // Set expiry to end of today (3:30 PM IST = 10:00 UTC)
    const expiresAt = new Date();
    expiresAt.setUTCHours(10, 0, 0, 0);
    if (expiresAt <= new Date()) {
      expiresAt.setDate(expiresAt.getDate() + 1);
    }

    // Dedup: skip signals for symbols that already have coverage via:
    // 1. Live Upstox open orders (already on exchange)
    // 2. Active DB signals today (PENDING/ACKED/SNOOZED/PLACING — not yet on exchange but queued)
    const alreadyCoveredKeys = new Set([
      ...liveOpenOrders.map(o => `${(o.tradingsymbol || o.trading_symbol || '').replace(/-EQ$/, '')}:${(o.transaction_type || '').toUpperCase()}`),
      ...activeDbSignals.map(s => `${s.symbol}:${s.side}`)
    ]);
    const dedupedSignals = convictionFiltered.filter(sig => {
      const key = `${sig.symbol}:${sig.side}`;
      if (alreadyCoveredKeys.has(key)) {
        logger.info(`[SignalGen] Skipping duplicate signal ${sig.side} ${sig.symbol} — already covered by active signal or open Upstox order`);
        return false;
      }
      return true;
    });

    // Create signals in DB
    const createdSignals = [];
    for (const sig of dedupedSignals.slice(0, 5)) {
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
    const errDetail = error?.message || error?.error?.message || JSON.stringify(error) || String(error);
    const errStatus = error?.status || error?.statusCode || '';
    logger.error(`Signal generation failed [${errStatus}]: ${errDetail}`);
    if (error?.stack) logger.error('Stack:', error.stack.slice(0, 600));
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
      status: { in: ['PENDING', 'ACKED', 'SNOOZED'] },
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

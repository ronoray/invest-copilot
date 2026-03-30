// server/services/advancedScreener.js
// Claude-powered, profile-aware stock screener
// Replaces the old hardcoded mock screener with real AI analysis

import Anthropic from '@anthropic-ai/sdk';
import { getCurrentPrice, fetchMarketContext } from './marketData.js';
import { ANALYST_IDENTITY, MARKET_DATA_INSTRUCTION, buildAccountabilityScorecard } from './analystPrompts.js';
import { validateAllocations } from './capitalGuard.js';
import logger from './logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Build a detailed profile brief for Claude from portfolio data.
 * This is the foundation — every AI prompt in the system should use this.
 */
export function buildProfileBrief(portfolio) {
  if (!portfolio) {
    return 'No portfolio context available. Recommend for a moderate-risk Indian retail investor with ₹50,000 capital.';
  }

  const holdingsList = portfolio.holdings?.length > 0
    ? portfolio.holdings.map(h => {
        const invested = h.quantity * parseFloat(h.avgPrice);
        const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
        const pl = current - invested;
        const plPct = invested > 0 ? ((pl / invested) * 100).toFixed(1) : '0';
        return `  - ${h.symbol} (${h.exchange}): ${h.quantity} shares @ ₹${parseFloat(h.avgPrice).toFixed(0)} avg, current ₹${parseFloat(h.currentPrice || h.avgPrice).toFixed(0)}, P&L ${pl >= 0 ? '+' : ''}₹${pl.toFixed(0)} (${plPct}%)`;
      }).join('\n')
    : '  (No holdings yet — fresh portfolio)';

  const totalInvested = portfolio.holdings?.reduce((sum, h) => sum + h.quantity * parseFloat(h.avgPrice), 0) || 0;
  const totalCurrent = portfolio.holdings?.reduce((sum, h) => sum + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0) || 0;
  const totalPL = totalCurrent - totalInvested;

  // Broker-specific execution context
  const availableCash = parseFloat(portfolio.availableCash || 0);
  const startingCapital = parseFloat(portfolio.startingCapital || 0);
  let executionContext = '';
  if (portfolio.broker === 'UPSTOX' && portfolio.apiEnabled) {
    // Typical affordable position size given the capital
    const maxSinglePosition = Math.min(Math.round(availableCash * 0.25 / 100) * 100, 5000);
    executionContext = `
**EXECUTION MODE: UPSTOX LIVE API — SIGNALS ARE DIRECTLY EXECUTABLE**
- Signals generated here are delivered to Telegram within minutes with a 1-tap Execute button
- Orders are placed via Upstox API automatically — no manual broker login required
- Product: CNC (Cash and Carry = delivery equity). ONLY equity delivery on NSE. NO intraday, NO F&O, NO futures, NO options
- Every BUY signal must be affordable: quantity × price ≤ ₹${availableCash.toLocaleString('en-IN')} (hard limit enforced by system)
- Position sizing for ₹${startingCapital.toLocaleString('en-IN')} capital: target ₹500–₹${maxSinglePosition.toLocaleString('en-IN')} per position (5–15% of capital per trade)
- Prefer LIMIT orders over MARKET orders — gives the investor a better entry and time to review
- SELL signals only for stocks actually held (see holdings). Do NOT suggest sells without a real holding`;
  } else {
    executionContext = `
**EXECUTION MODE: MANUAL (no API trading)**
- Broker: ${(portfolio.broker || 'UNKNOWN').replace(/_/g, ' ')}
- Signals are advisory only — investor must log in to broker to execute
- Verify actual account balance before sizing positions`;
  }

  return `**INVESTOR PROFILE:**
- Name: ${portfolio.ownerName || 'Unknown'}
- Portfolio: "${portfolio.name || 'Unnamed'}"
- Broker: ${(portfolio.broker || 'UNKNOWN').replace(/_/g, ' ')}
- Risk Profile: ${portfolio.riskProfile || 'BALANCED'}
- Investment Goal: ${portfolio.investmentGoal?.replace(/_/g, ' ') || 'Not specified'}
- Experience Level: ${portfolio.investmentExperience || 'Not specified'}
- Monthly Income: ${portfolio.monthlyIncome ? '₹' + parseFloat(portfolio.monthlyIncome).toLocaleString('en-IN') : 'Not disclosed'}
- Age: ${portfolio.age || 'Not specified'}
- Markets: ${(portfolio.markets || ['NSE']).join(', ')}
${executionContext}

**CAPITAL:**
- Starting Capital: ₹${startingCapital.toLocaleString('en-IN')}
- Available Cash: ₹${availableCash.toLocaleString('en-IN')}
- Currently Invested: ₹${totalInvested.toLocaleString('en-IN')}
- Current Value: ₹${totalCurrent.toLocaleString('en-IN')}
- Unrealized P&L: ${totalPL >= 0 ? '+' : ''}₹${totalPL.toLocaleString('en-IN')}

**CURRENT HOLDINGS:**
${holdingsList}`;
}

/**
 * Build a detailed portfolio audit for AI signal generation.
 * Shows holdings by weight, concentrations, idle cash analysis.
 *
 * @param {object} portfolio - Portfolio with holdings included
 * @param {number} effectiveCash - Available cash after pending signal reservations
 * @param {number} reservedCash - Cash reserved by pending signals
 * @returns {string} Structured audit text block
 */
export function buildPortfolioAudit(portfolio, effectiveCash, reservedCash) {
  if (!portfolio) return '';

  const holdings = portfolio.holdings || [];
  const totalInvested = holdings.reduce((sum, h) => sum + h.quantity * parseFloat(h.avgPrice), 0);
  const totalCurrent = holdings.reduce((sum, h) => sum + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0);
  const totalPortfolioValue = totalCurrent + effectiveCash;

  // Per-holding metrics sorted by weight
  const holdingRows = holdings
    .map(h => {
      const invested = h.quantity * parseFloat(h.avgPrice);
      const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
      const plPct = invested > 0 ? ((current - invested) / invested * 100) : 0;
      const weight = totalPortfolioValue > 0 ? (current / totalPortfolioValue * 100) : 0;
      return { symbol: h.symbol, exchange: h.exchange, qty: h.quantity, avgPrice: parseFloat(h.avgPrice), currentPrice: parseFloat(h.currentPrice || h.avgPrice), plPct, value: current, weight };
    })
    .sort((a, b) => b.weight - a.weight);

  // Exchange concentration
  const exchangeGroups = {};
  for (const h of holdingRows) {
    const key = h.exchange || 'NSE';
    exchangeGroups[key] = (exchangeGroups[key] || 0) + h.value;
  }

  const cashPct = totalPortfolioValue > 0 ? (effectiveCash / totalPortfolioValue * 100) : 100;
  const investedPct = totalPortfolioValue > 0 ? (totalCurrent / totalPortfolioValue * 100) : 0;

  const lastVerified = portfolio.lastVerifiedAt
    ? new Date(portfolio.lastVerifiedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    : 'NEVER';

  let audit = `=== PORTFOLIO AUDIT ===
Total Capital: ₹${totalPortfolioValue.toLocaleString('en-IN')} | Available Cash: ₹${effectiveCash.toLocaleString('en-IN')} (effective, ₹${reservedCash.toFixed(0)} reserved) | Invested: ₹${totalCurrent.toLocaleString('en-IN')}
Cash Utilization: ${investedPct.toFixed(1)}% | Idle Cash: ${cashPct.toFixed(1)}%
Last Verified: ${lastVerified}
`;

  if (holdingRows.length > 0) {
    audit += `\nHOLDINGS BY WEIGHT:\n| Symbol | Qty | Avg ₹ | Current ₹ | P&L % | Value ₹ | Weight % |\n`;
    for (const h of holdingRows) {
      audit += `| ${h.symbol} | ${h.qty} | ${h.avgPrice.toFixed(0)} | ${h.currentPrice.toFixed(0)} | ${h.plPct >= 0 ? '+' : ''}${h.plPct.toFixed(1)}% | ${h.value.toLocaleString('en-IN')} | ${h.weight.toFixed(1)}% |\n`;
    }

    // Top concentrations
    const overweight = holdingRows.filter(h => h.weight > 15);
    if (overweight.length > 0) {
      audit += `\nTOP CONCENTRATIONS:\n`;
      for (const h of overweight) {
        audit += `- ${h.symbol} = ${h.weight.toFixed(1)}% of portfolio (OVERWEIGHT >15%)\n`;
      }
    }
  } else {
    audit += `\nNO HOLDINGS — fresh portfolio, all capital is idle.\n`;
  }

  // Idle cash analysis
  const riskProfile = portfolio.riskProfile || 'BALANCED';
  let cashCommentary;
  if (riskProfile === 'AGGRESSIVE') {
    cashCommentary = cashPct > 10
      ? `TOO MUCH IDLE CASH for aggressive growth. Deploy at least ${(cashPct - 5).toFixed(0)}% of this immediately.`
      : `Cash reserve acceptable for aggressive portfolio.`;
  } else if (riskProfile === 'CONSERVATIVE') {
    cashCommentary = cashPct < 20
      ? `Low cash reserve for conservative portfolio. Consider trimming to build 20% buffer.`
      : `Healthy cash reserve for conservative portfolio.`;
  } else {
    cashCommentary = cashPct > 30
      ? `Significant idle cash. Consider deploying to improve returns.`
      : cashPct < 10
        ? `Low cash buffer. Maintain at least 10% for opportunities.`
        : `Cash level adequate for balanced portfolio.`;
  }
  audit += `\nIDLE CASH ANALYSIS:\n₹${effectiveCash.toLocaleString('en-IN')} idle = ${cashPct.toFixed(1)}% of capital. ${cashCommentary}\n`;

  return audit;
}

/**
 * Build a portfolio wealth trajectory block — the strategic compass for every signal.
 *
 * Tells Claude: where did we start, where are we now, are we winning or losing the
 * compounding battle, and what posture does that demand right now.
 *
 * This is the difference between transactional signals ("good trade today") and
 * strategic wealth generation ("we're 4% behind the monthly target — we need
 * controlled aggression on the next 2 setups to close the gap").
 *
 * @param {object} portfolio - Portfolio with holdings included
 * @returns {string} Formatted trajectory block for prompt injection
 */
export function buildPortfolioTrajectory(portfolio) {
  if (!portfolio) return '';

  const startingCapital = parseFloat(portfolio.startingCapital || 0);
  if (startingCapital <= 0) return '';

  const holdings        = portfolio.holdings || [];
  const availableCash   = parseFloat(portfolio.availableCash || 0);
  const totalWithdrawn  = parseFloat(portfolio.totalWithdrawn || 0);

  // Mark-to-market portfolio value
  const totalCurrent    = holdings.reduce((s, h) => s + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0);
  const totalValue      = totalCurrent + availableCash;

  // Total wealth = current value + profits already banked
  const totalWealth     = totalValue + totalWithdrawn;
  const totalPnL        = totalWealth - startingCapital;
  const totalPnLPct     = (totalPnL / startingCapital) * 100;

  // Days the portfolio has been active
  const startDate   = portfolio.createdAt ? new Date(portfolio.createdAt) : null;
  const daysActive  = startDate
    ? Math.max(1, Math.floor((Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24)))
    : null;

  // Implied compounding rates
  const impliedMonthlyRate  = daysActive ? (totalPnLPct / daysActive) * 30 : null;
  const annualizedRate      = impliedMonthlyRate !== null ? impliedMonthlyRate * 12 : null;

  // Monthly target comparison
  const monthlyTargetPct  = parseFloat(portfolio.profitTargetPct || 5);
  const targetByNow       = daysActive ? monthlyTargetPct * (daysActive / 30) : null;
  const gapPct            = targetByNow !== null ? totalPnLPct - targetByNow : null;
  const gapAmount         = targetByNow !== null
    ? ((targetByNow / 100) * startingCapital) - totalPnL
    : null; // positive = need to earn this to catch up

  // Drawdown from starting capital
  const isDrawdown     = totalPnLPct < -2;
  const recoveryNeeded = isDrawdown ? Math.abs(totalPnL) : null;

  // Trajectory verdict and action mandate
  let trajectoryStatus, trajectoryMandate;

  if (isDrawdown && totalPnLPct < -5) {
    trajectoryStatus  = '🔴 DRAWDOWN — RECOVERY MODE ACTIVE';
    trajectoryMandate = `Portfolio is ${Math.abs(totalPnLPct).toFixed(1)}% below starting capital. I owe this portfolio ₹${recoveryNeeded.toFixed(0)} to break even. MANDATE: Every signal must have an absolute stop. No speculative plays until we're back above starting capital. High-conviction setups only. R:R minimum 3:1.`;
  } else if (isDrawdown) {
    trajectoryStatus  = '🟡 SLIGHT DRAWDOWN — CAUTIOUS RECOVERY';
    trajectoryMandate = `Portfolio is ${Math.abs(totalPnLPct).toFixed(1)}% below starting capital. Recovery target: ₹${recoveryNeeded.toFixed(0)}. MANDATE: Moderate aggression. Only Grade A setups. Stops are non-negotiable.`;
  } else if (gapPct !== null && gapPct < -4) {
    trajectoryStatus  = '🟡 BEHIND MONTHLY TARGET — ACCELERATE';
    trajectoryMandate = `${Math.abs(gapPct).toFixed(1)}% behind the ${monthlyTargetPct}%/month compounding target. Need to earn ₹${Math.abs(gapAmount || 0).toFixed(0)} more to hit the target for these ${daysActive} days. MANDATE: Take full-sized positions on high-conviction setups. This is controlled aggression — full size on 80%+ confidence trades, not gambling on weak setups.`;
  } else if (gapPct !== null && gapPct > 5) {
    trajectoryStatus  = '🟢 AHEAD OF TARGET — LOCK IN GAINS';
    trajectoryMandate = `${gapPct.toFixed(1)}% ahead of the monthly trajectory. We've already built a buffer. MANDATE: Tighten stops on existing positions. Don't give back gains chasing marginal setups. Only enter new positions if conviction is 80%+.`;
  } else {
    trajectoryStatus  = '🟢 ON TRACK — MAINTAIN COMPOUNDING DISCIPLINE';
    trajectoryMandate = `Portfolio is compounding on schedule at ${impliedMonthlyRate !== null ? impliedMonthlyRate.toFixed(2) + '%/month' : 'target rate'}. MANDATE: Maintain discipline. Full-sized positions on good setups, reduced size on borderline calls.`;
  }

  const lines = [
    '=== WEALTH TRAJECTORY — MY PERFORMANCE MANDATE ===',
    `Capital Deployed: ₹${startingCapital.toLocaleString('en-IN')}`,
    `Current Portfolio Value: ₹${totalValue.toLocaleString('en-IN')}` +
      ` (₹${availableCash.toLocaleString('en-IN')} cash + ₹${totalCurrent.toLocaleString('en-IN')} invested)`,
    totalWithdrawn > 0
      ? `Profits Withdrawn: ₹${totalWithdrawn.toLocaleString('en-IN')} (total wealth ₹${totalWealth.toLocaleString('en-IN')})`
      : '',
    `Total P&L: ${totalPnL >= 0 ? '+' : ''}₹${totalPnL.toLocaleString('en-IN')}` +
      ` (${totalPnL >= 0 ? '+' : ''}${totalPnLPct.toFixed(2)}% on capital)`,
    daysActive
      ? `Days Active: ${daysActive} | Implied: ${impliedMonthlyRate !== null ? (impliedMonthlyRate >= 0 ? '+' : '') + impliedMonthlyRate.toFixed(2) + '%/month' : 'N/A'}` +
        ` (${annualizedRate !== null ? (annualizedRate >= 0 ? '+' : '') + annualizedRate.toFixed(1) + '% annualized' : ''})`
      : '',
    targetByNow !== null
      ? `Monthly Target: ${monthlyTargetPct}%/month | Target by day ${daysActive}: ${targetByNow.toFixed(1)}% | Actual: ${totalPnLPct.toFixed(1)}% | Gap: ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(1)}%`
      : '',
    `Trajectory: ${trajectoryStatus}`,
    trajectoryMandate,
    '=== END TRAJECTORY ===',
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Build growth directive — capital-aware and trajectory-aware.
 * Computes actual rupee targets based on the portfolio's specific state.
 * This is what makes recommendations personal, not generic.
 *
 * @param {object} portfolio - Portfolio object with holdings
 * @param {number} [effectiveCash] - Available cash (optional, uses portfolio.availableCash if not passed)
 * @returns {string} Growth directive text
 */
export function buildGrowthDirective(portfolio, effectiveCash) {
  if (!portfolio) return '';

  const startingCapital = parseFloat(portfolio.startingCapital || 0);
  const availableCash   = effectiveCash ?? parseFloat(portfolio.availableCash || 0);
  const holdings        = portfolio.holdings || [];
  const totalWithdrawn  = parseFloat(portfolio.totalWithdrawn || 0);

  const totalCurrent    = holdings.reduce((s, h) => s + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0);
  const totalValue      = totalCurrent + availableCash;
  const totalWealth     = totalValue + totalWithdrawn;
  const totalPnL        = totalWealth - startingCapital;
  const totalPnLPct     = startingCapital > 0 ? (totalPnL / startingCapital) * 100 : 0;

  // Actual position sizing for this account
  const maxPositions      = Math.min(4, Math.max(2, Math.floor(availableCash / 3000)));
  const perPositionBudget = maxPositions > 0 ? Math.floor(availableCash / maxPositions / 100) * 100 : availableCash;
  const perPositionTarget = Math.round(perPositionBudget * 0.10); // 10% gain per position = realistic swing target
  const totalTargetGain   = perPositionTarget * maxPositions;

  // What stock price range makes sense? Need 10+ shares per position
  const maxStockPrice = Math.floor(perPositionBudget / 10);

  // Recovery state
  const inDrawdown      = totalPnLPct < -2;
  const recoveryNeeded  = inDrawdown ? Math.abs(totalPnL) : 0;
  const monthlyTargetPct = parseFloat(portfolio.profitTargetPct || 5);
  const monthlyTargetAmt = startingCapital * monthlyTargetPct / 100;

  let directive = `=== GROWTH DIRECTIVE — THIS ACCOUNT, THIS CAPITAL ===\n`;

  directive += `Available capital: ₹${availableCash.toLocaleString('en-IN')} | Total portfolio value: ₹${totalValue.toLocaleString('en-IN')}\n`;
  directive += `P&L since inception: ${totalPnL >= 0 ? '+' : ''}₹${totalPnL.toFixed(0)} (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(1)}% on ₹${startingCapital.toLocaleString('en-IN')} starting capital)\n`;

  if (inDrawdown) {
    directive += `\n🔴 IN DRAWDOWN — ₹${recoveryNeeded.toFixed(0)} below starting capital.\n`;
    directive += `Recovery target first, then growth. The monthly target of ${monthlyTargetPct}% (₹${monthlyTargetAmt.toFixed(0)}) is secondary to getting back above ₹${startingCapital.toLocaleString('en-IN')}.\n`;
  }

  directive += `\nPOSITION SIZING FOR THIS ACCOUNT:\n`;
  directive += `- Max ${maxPositions} positions (concentrated, not diversified — this is swing trading)\n`;
  directive += `- Budget per position: ₹${perPositionBudget.toLocaleString('en-IN')} (deploy all available cash across ${maxPositions} trades)\n`;
  directive += `- Target gain per position: ₹${perPositionTarget.toLocaleString('en-IN')} (10% return on ₹${perPositionBudget.toLocaleString('en-IN')}) — achievable in 3-10 trading days on a good setup\n`;
  directive += `- Portfolio-level gain target: ₹${totalTargetGain.toLocaleString('en-IN')} if all ${maxPositions} positions hit target\n`;
  directive += `- Stock price sweet spot: ≤ ₹${maxStockPrice} per share (gets 10+ shares at ₹${perPositionBudget.toLocaleString('en-IN')} budget — meaningful exposure)\n`;

  directive += `\nWHAT MAKES A RECOMMENDATION SPECIFIC (NOT GENERIC):\n`;
  directive += `- It names the exact stock, exact entry price, exact target, exact stop. No vague "buy near support".\n`;
  directive += `- It states: "At ₹${perPositionBudget.toLocaleString('en-IN')}, this buys X shares. Target ₹Y gain. Stop at ₹Z loss. R:R = N:1."\n`;
  directive += `- It explains WHY this specific stock beats its sector peers for this setup RIGHT NOW.\n`;
  directive += `- It is NOT a recommendation that belongs in a generic monthly newsletter. It belongs to THIS account TODAY.\n`;
  directive += `=== END GROWTH DIRECTIVE ===`;

  return directive;
}

/**
 * Build a brief for ALL portfolios (cross-portfolio view).
 */
export function buildAllPortfoliosBrief(portfolios) {
  if (!portfolios || portfolios.length === 0) {
    return 'No portfolios found.';
  }

  // Exclude paused portfolios from AI analysis
  const active = portfolios.filter(p => !p.isPaused);
  const pausedCount = portfolios.length - active.length;

  if (active.length === 0) {
    return 'All portfolios are currently on hold. No active portfolios to analyze.';
  }

  const pausedNote = pausedCount > 0
    ? `\nNOTE: ${pausedCount} portfolio(s) are currently ON HOLD and excluded from this analysis. Focus exclusively on the active portfolio(s) below.\n`
    : '';

  const sections = active.map((p, i) => {
    return `--- Portfolio ${i + 1}: ${p.name} ---\n${buildProfileBrief(p)}`;
  });

  const totalCapital = active.reduce((s, p) => s + parseFloat(p.startingCapital || 0), 0);
  const totalCash = active.reduce((s, p) => s + parseFloat(p.availableCash || 0), 0);
  const allHoldings = active.flatMap(p => p.holdings || []);
  const totalInvested = allHoldings.reduce((s, h) => s + h.quantity * parseFloat(h.avgPrice), 0);
  const totalCurrent = allHoldings.reduce((s, h) => s + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0);

  return `**ACTIVE PORTFOLIO OVERVIEW (${active.length} active${pausedCount > 0 ? `, ${pausedCount} on hold` : ''}):**${pausedNote}
- Total Capital: ₹${totalCapital.toLocaleString('en-IN')}
- Total Available Cash: ₹${totalCash.toLocaleString('en-IN')}
- Total Invested: ₹${totalInvested.toLocaleString('en-IN')}
- Total Current Value: ₹${totalCurrent.toLocaleString('en-IN')}
- Total Holdings: ${allHoldings.length} stocks

${sections.join('\n\n')}`;
}

/**
 * Scan market for opportunities — CLAUDE-POWERED, PROFILE-AWARE
 *
 * @param {object} options
 * @param {object} options.portfolio - Full portfolio object with holdings (from Prisma)
 * @param {object} options.targetCount - { high: N, medium: N, low: N }
 * @param {number} options.baseAmount - Total amount to invest
 * @param {boolean} options.fetchRealPrices - Whether to fetch real prices (slower, rate-limited)
 * @returns {{ high: Array, medium: Array, low: Array }}
 */
export async function scanMarketForOpportunities(options = {}) {
  const {
    portfolio = null,
    targetCount = { high: 3, medium: 3, low: 3 },
    baseAmount = 10000,
    fetchRealPrices = false,
  } = options;

  const totalStocks = (targetCount.high || 3) + (targetCount.medium || 3) + (targetCount.low || 3);

  logger.info(`Starting Claude-powered scan (${totalStocks} stocks, ₹${baseAmount})...`);

  const profileBrief = buildProfileBrief(portfolio);

  // Determine what to emphasize based on risk profile
  const riskProfile = portfolio?.riskProfile || 'BALANCED';
  let riskGuidance;
  if (riskProfile === 'CONSERVATIVE') {
    riskGuidance = `This is a CONSERVATIVE portfolio. Prioritize:
- Low risk: Large-cap dividend stocks (Nifty 50 components), established businesses with consistent earnings
- Medium risk: Select mid-caps only if they have strong fundamentals and low debt
- High risk: Minimal allocation — only include if there's exceptional opportunity with defined downside
- Favor: Banking, FMCG, IT, Pharma, Infrastructure bluechips
- Avoid: Penny stocks, highly leveraged companies, pure momentum plays`;
  } else if (riskProfile === 'AGGRESSIVE') {
    riskGuidance = `This is an AGGRESSIVE portfolio. Prioritize:
- High risk: Momentum small-caps, sector disruptors, turnaround stories, high-beta stocks
- Medium risk: Growth mid-caps in trending sectors (EV, defense, renewable energy, AI/tech)
- Low risk: Include a few large-cap anchors but focus on growth over dividends
- Consider: F&O opportunities, sector rotation plays, IPO-recent listings with momentum
- Be bold but always define stop-losses`;
  } else {
    riskGuidance = `This is a BALANCED portfolio. Provide a well-diversified mix:
- Low risk: Quality large-caps with growth + dividends (40% of allocation)
- Medium risk: Mid-caps in growing sectors with reasonable valuations (35%)
- High risk: Select high-conviction small-cap or momentum plays (25%)
- Balance between value and growth across sectors`;
  }

  const existingSymbols = (portfolio?.holdings || []).map(h => h.symbol).join(', ');

  // Fetch real market data for AI context
  let marketContext = '';
  try {
    marketContext = await fetchMarketContext(portfolio?.holdings || []);
  } catch (e) {
    logger.warn('Could not fetch market context for scan:', e.message);
  }

  // Build accountability scorecard if portfolio exists
  let scorecard = '';
  if (portfolio?.id) {
    try {
      scorecard = await buildAccountabilityScorecard(portfolio.id);
    } catch (e) {
      logger.warn('Could not build scorecard for scan:', e.message);
    }
  }

  const prompt = `${ANALYST_IDENTITY}

${marketContext}
${MARKET_DATA_INSTRUCTION}

${scorecard}

${profileBrief}

FULL MARKET SCAN — I need your best conviction picks across the ENTIRE Indian market.

**CAPITAL TO DEPLOY:** ₹${baseAmount.toLocaleString('en-IN')}

**RISK FRAMEWORK:**
${riskGuidance}

**ALREADY HOLDING (DO NOT DUPLICATE):** ${existingSymbols || 'None'}

SCAN METHODOLOGY — work through this systematically:
1. SECTOR SWEEP: Analyze ALL major sectors — Banking, IT, Pharma, Auto, FMCG, Metals, Energy, Infra, Defense, Chemicals, Textiles, Real Estate, Telecom, Media, Insurance. Which sectors have the best risk-reward setup RIGHT NOW?
2. MARKET CAP SPECTRUM: Cover Nifty 50 (large), Nifty Midcap 150, Nifty Smallcap 250. The best opportunities are often outside the top 50
3. THEMATIC PLAYS: Government policy beneficiaries, China+1, PLI scheme winners, capex cycle plays, consumption recovery — what's working?
4. VALUATION FILTER: For each pick, explain the valuation case — PE vs sector average, PEG ratio, earnings growth trajectory

For EACH stock, provide:
- THE THESIS: Why this stock, why now? Not "good company" — what's the CATALYST?
- THE TRADE: Entry, target, stop-loss. Risk-reward ratio (must be at least 2:1)
- THE INVALIDATION: What breaks this trade?
- PORTFOLIO FIT: How does it complement what this investor already holds?

${scorecard ? 'ACCOUNTABILITY: Your previous calls are shown above. Factor your track record into conviction levels. If a sector burned you recently, explain why you think it works now.' : ''}

Provide exactly ${targetCount.high || 3} HIGH risk, ${targetCount.medium || 3} MEDIUM risk, and ${targetCount.low || 3} LOW risk picks.

Return ONLY valid JSON (no markdown):
{
  "high": [
    {
      "symbol": "SYMBOL",
      "exchange": "NSE",
      "price": 100.00,
      "changePercent": 2.5,
      "riskScore": 8,
      "riskCategory": "high",
      "capCategory": "smallCap",
      "targetPrice": 130.00,
      "stopLoss": 85.00,
      "timeHorizon": "SHORT",
      "timeHorizonDays": 15,
      "suggestedAmount": 3000,
      "simpleWhy": [
        "THESIS: [specific catalyst/reason]",
        "VALUATION: [PE/PEG/growth metrics that justify entry]",
        "PORTFOLIO FIT: [how it complements existing holdings]"
      ],
      "expectedReturns": {
        "best": "+30%",
        "likely": "+15%",
        "worst": "-15%"
      },
      "sector": "Energy",
      "reasoning": "Full thesis with catalyst, valuation basis, and invalidation trigger"
    }
  ],
  "medium": [ ... same structure ... ],
  "low": [ ... same structure ... ]
}

RULES:
- Real NSE symbols only. Scan across ALL market caps and sectors — don't just pick Nifty 50 names
- Price estimates should be your best knowledge of current levels
- HARD LIMIT: Total suggestedAmount across ALL picks MUST NOT exceed ₹${baseAmount.toLocaleString('en-IN')}. Sum your allocations before responding — if they exceed this limit, scale them down
- simpleWhy: 3 strings — THESIS, VALUATION, PORTFOLIO FIT
- Be BOLD. If you have 90% conviction, say it. If it's a speculative play, flag it honestly
- Return ONLY the JSON object`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
    });

    if (message.stop_reason === 'max_tokens') {
      logger.warn(`Claude scan response truncated (${message.usage?.output_tokens} tokens used). Retrying with fewer stocks...`);
      // Retry with fewer stocks if truncated
      if (totalStocks > 6) {
        return scanMarketForOpportunities({ portfolio, targetCount: { high: 2, medium: 2, low: 2 }, baseAmount, fetchRealPrices });
      }
    }

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Failed to parse Claude response for stock scan');
    }

    const results = JSON.parse(jsonMatch[0]);

    // Validate structure
    const high = results.high || [];
    const medium = results.medium || [];
    const low = results.low || [];

    // Capital guard: ensure total allocations don't exceed budget
    const allPicks = [...high, ...medium, ...low];
    validateAllocations(allPicks, baseAmount, 'suggestedAmount');

    logger.info(`Claude scan complete: ${high.length} high, ${medium.length} medium, ${low.length} low`);

    // Optionally fetch real prices to replace Claude's estimates
    if (fetchRealPrices) {
      const allStocks = [...high, ...medium, ...low];
      for (const stock of allStocks) {
        try {
          const priceData = await getCurrentPrice(stock.symbol, stock.exchange || 'NSE');
          if (priceData?.price) {
            const ratio = priceData.price / stock.price; // How far off was Claude's estimate
            stock.price = priceData.price;
            stock.change = priceData.change || 0;
            stock.changePercent = priceData.changePercent || stock.changePercent || 0;
            // Scale target and stop-loss proportionally
            stock.targetPrice = parseFloat((stock.targetPrice * ratio).toFixed(2));
            stock.stopLoss = parseFloat((stock.stopLoss * ratio).toFixed(2));
            logger.info(`Real price for ${stock.symbol}: ₹${priceData.price}`);
          }
          // Rate limit: Alpha Vantage free tier = 5/min
          await new Promise(resolve => setTimeout(resolve, 13000));
        } catch (err) {
          logger.warn(`Could not fetch real price for ${stock.symbol}: ${err.message}`);
          // Keep Claude's estimated price
        }
      }
    }

    return { high, medium, low };

  } catch (error) {
    const errDetail = error?.error?.message || error?.message || JSON.stringify(error);
    logger.error(`Claude stock scan error: ${errDetail}`);
    if (error?.status) logger.error(`Claude API status: ${error.status}`);

    // Re-throw so the caller knows the scan failed (not just "0 results")
    throw new Error(`AI scan failed: ${errDetail}`);
  }
}

/**
 * Calculate technicals for a single stock (uses real price data)
 * Kept for backward compatibility
 */
export async function calculateTechnicals(symbol, exchange) {
  try {
    const priceData = await getCurrentPrice(symbol, exchange);
    return {
      price: priceData.price,
      change: priceData.change,
      changePercent: priceData.changePercent,
    };
  } catch (error) {
    logger.error(`Tech calc failed for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get a flat list of common NSE symbols (for reference/fallback)
 */
export function getAllNSESymbols() {
  return [
    // Large Cap
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'ITC', 'SBIN', 'BHARTIARTL',
    'HINDUNILVR', 'LT', 'KOTAKBANK', 'BAJFINANCE', 'MARUTI', 'TITAN', 'ASIANPAINT',
    // Mid Cap
    'ZOMATO', 'PAYTM', 'TATAPOWER', 'ADANIGREEN', 'IRCTC', 'FEDERALBNK', 'VOLTAS',
    'HAVELLS', 'POLYCAB', 'PERSISTENT', 'COFORGE', 'MPHASIS', 'DEEPAKNTR',
    // Small Cap
    'SUZLON', 'YESBANK', 'SAIL', 'NMDC', 'TATACHEM', 'JINDALSAW', 'GMRINFRA',
    'RAILTEL', 'IRFC', 'RVNL', 'BEL', 'HAL', 'COCHINSHIP',
  ];
}

export default { scanMarketForOpportunities, calculateTechnicals, getAllNSESymbols, buildProfileBrief, buildAllPortfoliosBrief, buildPortfolioAudit, buildGrowthDirective, buildPortfolioTrajectory };

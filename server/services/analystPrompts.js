// server/services/analystPrompts.js
// Shared analyst identity, prompt foundations, and accountability loop
// This is the analytical brain of the system — every AI call flows through here

import prisma from './prisma.js';
import logger from './logger.js';

// ============================================
// THE ANALYST IDENTITY
// ============================================

export const ANALYST_IDENTITY = `You are a CFA-certified, PhD-level equity research analyst running a multi-crore Indian family office. You have 20+ years of experience across equities, derivatives, commodities, fixed income, and alternative investments in Indian markets.

YOUR ANALYTICAL DNA:
- You think in frameworks: DCF for valuation, sector rotation for timing, correlation matrices for diversification, risk-adjusted returns for position sizing
- You reason from first principles: RBI policy → credit growth → bank NII → stock price, not just "banks look good"
- You track macro chains: crude oil → current account deficit → INR → IT earnings → portfolio impact
- You understand market microstructure: FII/DII flows, delivery volumes, options chain positioning, institutional accumulation patterns
- You know Indian market cycles intimately: election cycles, budget impact, monsoon plays, Q3 earnings seasonality

YOUR VOICE:
- You are direct, confident, and opinionated. You give clear conviction calls, not hedged suggestions
- You say "BUY HDFCBANK at ₹1,650, target ₹1,850, stop ₹1,580" — not "you might want to consider HDFCBANK"
- When you're wrong, you own it immediately: "My TATAPOWER call is down 4%. Here's what I missed and here's the recovery plan"
- You never say "I don't have access to real-time data" or "please check Moneycontrol" — YOU are the analyst
- You never disclaim with "as an AI" or "I should note that" — you speak as a practitioner
- You are not rude, but you are commanding: "Do this. Here's exactly why. The risk-reward is 3:1 and the thesis is sound"
- You use specific numbers, not vague ranges. "Fair value ₹2,400 based on 22x FY26E EPS of ₹109" — not "looks fairly valued"

YOUR MARKET KNOWLEDGE:
- You know approximate valuations, PE ranges, sector multiples, and price levels for Nifty 500+ stocks
- You understand mutual fund schemes by name, their track records, expense ratios, and fund manager styles
- You know commodity cycles, gold/crude correlations, SGB series, and MCX dynamics
- You know fixed income instruments: G-Secs, SDL, corporate bonds, FDs, PPF, NPS, EPF
- You know REITs (Embassy, Mindspace, Brookfield), InvITs, and alternative investments available in India
- When real-time data is provided, use it to ANCHOR your analysis. When it's not, use your knowledge to estimate and state your basis

CRITICAL RULES:
- NEVER say "I don't have access to real-time data" or "I recommend checking [website]"
- NEVER give generic advice. Every recommendation must be specific to THIS investor's situation
- NEVER hedge every statement. Take positions. Be bold. Accept that some calls will be wrong
- When you estimate a price, say "trading around ₹X based on recent levels" — don't refuse to engage
- Always provide specific entry, target, stop-loss, position size, and timeframe
- Always explain the THESIS (why), the CATALYST (what triggers the move), and the INVALIDATION (what kills the trade)
- If a previous call went wrong, address it head-on with a recovery plan`;

// ============================================
// MARKET DATA INTEGRATION PROMPT
// ============================================

export const MARKET_DATA_INSTRUCTION = `
REAL-TIME DATA USAGE:
- Where real-time market data is provided above, use those exact prices as your anchor
- For stocks without provided live data, use your knowledge to estimate current levels and state your basis (e.g., "RELIANCE trading around ₹2,950 based on recent range")
- Combine provided data with your analytical reasoning — the data is an INPUT to your analysis, not a cage around it
- Your job is to REASON, ANALYZE, and RECOMMEND — not just parrot provided numbers
`;

// ============================================
// ACCOUNTABILITY LOOP: Previous Calls Scorecard
// ============================================

/**
 * Build a scorecard of recent trade signals and their outcomes.
 * Fed into every prompt so the analyst can own its calls.
 *
 * @param {number} portfolioId
 * @param {number} [days=7] - Look back period
 * @returns {Promise<string>} Formatted scorecard text
 */
export async function buildAccountabilityScorecard(portfolioId, days = 7) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const recentSignals = await prisma.tradeSignal.findMany({
      where: {
        portfolioId,
        createdAt: { gte: since }
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    if (recentSignals.length === 0) {
      return '';
    }

    // Get current prices from holdings for comparison
    const portfolio = await prisma.portfolio.findUnique({
      where: { id: portfolioId },
      include: { holdings: true }
    });

    const holdingPrices = {};
    for (const h of (portfolio?.holdings || [])) {
      holdingPrices[h.symbol.toUpperCase()] = parseFloat(h.currentPrice || h.avgPrice);
    }

    const lines = ['=== MY PREVIOUS CALLS (Last 7 Days) ==='];
    let wins = 0;
    let losses = 0;

    for (const sig of recentSignals) {
      const status = sig.status;
      const symbol = sig.symbol;
      const side = sig.side;
      const triggerPrice = sig.triggerPrice || sig.triggerLow || 0;
      const currentPrice = holdingPrices[symbol.toUpperCase()];

      let outcome = '';
      if (currentPrice && triggerPrice > 0) {
        const diff = side === 'BUY'
          ? ((currentPrice - triggerPrice) / triggerPrice * 100)
          : ((triggerPrice - currentPrice) / triggerPrice * 100);
        const emoji = diff >= 0 ? '✅' : '❌';
        outcome = ` → Now ₹${currentPrice.toFixed(0)} (${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%)`;
        if (diff >= 0) wins++; else losses++;
      }

      const statusTag = status === 'EXECUTED' ? '[EXECUTED]'
        : status === 'PENDING' ? '[PENDING - NOT ACTED ON]'
        : status === 'DISMISSED' ? '[DISMISSED]'
        : status === 'EXPIRED' ? '[EXPIRED - MISSED]'
        : `[${status}]`;

      const dateStr = sig.createdAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      lines.push(`${dateStr}: ${side} ${symbol} @ ₹${triggerPrice.toFixed(0)} ${statusTag}${outcome} | Confidence: ${sig.confidence}%`);
      if (sig.rationale) {
        lines.push(`  Thesis: ${sig.rationale}`);
      }
    }

    if (wins + losses > 0) {
      const winRate = ((wins / (wins + losses)) * 100).toFixed(0);
      lines.push(`\nScorecard: ${wins}W / ${losses}L (${winRate}% hit rate)`);
      if (losses > wins) {
        lines.push('⚠️ More losses than wins recently. Adjust your new recommendations: tighter stops, higher conviction threshold, prefer mean-reversion setups over momentum.');
      }
    }

    // Check for PENDING signals that were never acted on
    const pendingCount = recentSignals.filter(s => s.status === 'PENDING' || s.status === 'EXPIRED').length;
    if (pendingCount > 0) {
      lines.push(`\n${pendingCount} signal(s) were not acted on. Consider: were these good calls missed, or was the investor right to skip them?`);
    }

    lines.push('=== END SCORECARD ===');
    return '\n' + lines.join('\n') + '\n';

  } catch (error) {
    logger.error('Failed to build accountability scorecard:', error.message);
    return '';
  }
}

/**
 * Build a comprehensive context block combining market data, scorecard, and analyst identity.
 * Use this as the universal prefix for all AI prompts.
 *
 * @param {object} options
 * @param {string} options.marketContext - Real-time market data text
 * @param {string} options.scorecard - Previous calls scorecard
 * @param {string} options.profileBrief - Investor profile text
 * @returns {string} Complete prompt prefix
 */
export function buildAnalystPromptPrefix({ marketContext = '', scorecard = '', profileBrief = '' }) {
  return `${ANALYST_IDENTITY}

${marketContext ? marketContext + '\n' + MARKET_DATA_INSTRUCTION : ''}
${scorecard}
${profileBrief}`;
}

export default {
  ANALYST_IDENTITY,
  MARKET_DATA_INSTRUCTION,
  buildAccountabilityScorecard,
  buildAnalystPromptPrefix
};

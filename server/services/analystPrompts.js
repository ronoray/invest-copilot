// server/services/analystPrompts.js
// The analytical brain and ownership engine of the system
// Every AI call flows through here — this is what makes us a business, not a chatbot

import prisma from './prisma.js';
import logger from './logger.js';

// ============================================
// THE ANALYST IDENTITY — OWNERSHIP MENTALITY
// ============================================

export const ANALYST_IDENTITY = `You are the chief investment architect of a six-figure portfolio operation. This is YOUR business. These portfolios are YOUR responsibility. When they profit, it's because YOUR analysis was sharp. When they lose, it's YOUR failure — and you fix it immediately.

You have a CFA charter, a PhD in quantitative finance, and 20+ years running money in Indian markets. You've seen 2008, the taper tantrum, COVID crash, and every cycle in between. You don't panic, you don't hedge your words, and you don't pass the buck.

YOUR OWNERSHIP MANDATE:
- Every rupee in this portfolio is your reputation. You track it, you protect it, you grow it
- When YOUR call loses money, you don't wait for the next scheduled review. You address it IMMEDIATELY with a specific recovery plan
- You set daily/weekly targets and you HUNT for ways to hit them. Falling short is unacceptable — you find the trade that closes the gap
- You never say "the market was against us" as an excuse. You say "I misjudged the timing on X, here's how I'm recovering ₹Y by Friday"
- You are RELENTLESS about capital protection. A 5% loss requires a 5.3% gain to recover — you know the math of losses and you prevent them

YOUR ANALYTICAL FRAMEWORK:
- DCF for intrinsic value, sector rotation for timing, correlation matrices for diversification, Kelly criterion for position sizing
- First principles chain reasoning: RBI policy → credit growth → bank NII → stock price. Crude oil → current account → INR → IT earnings
- Market microstructure: FII/DII flows, delivery volumes, options chain positioning, institutional accumulation patterns
- Full market scan capability: Nifty 50, Next 50, Midcap 150, Smallcap 250, sectoral indices — you miss nothing

YOUR VOICE:
- You are direct, confident, and commanding — but never rude. You speak like a senior partner to a valued client
- "I need you to execute this before 10 AM. Here's exactly why — the risk-reward is 3:1 and the setup won't last past lunch"
- "My TATAPOWER call is down 4%. I own that. The sector rotated faster than I modeled. Exit at ₹398, rotate into NTPC at ₹372. We recover ₹1,800 by Friday"
- You use specific numbers ALWAYS. "Fair value ₹2,400 based on 22x FY26E EPS of ₹109" — never "looks fairly valued"
- You NEVER say "I don't have access to real-time data" or "check Moneycontrol" — YOU are the data source
- You NEVER disclaim with "as an AI" or "I should note that" — you speak as the portfolio manager you are

YOUR MARKET KNOWLEDGE:
- You know valuations, PE ranges, sector multiples, and price ranges for Nifty 500+ stocks from your experience
- You know mutual fund schemes by name — fund managers, track records, expense ratios, category rankings
- You know commodity cycles, gold/crude correlations, SGB series, MCX dynamics
- You know fixed income: G-Secs, SDL, corporate bonds, yield curves, duration management, FD rates by bank
- You know REITs (Embassy, Mindspace, Brookfield), InvITs, and every alternative investment available in India
- Real-time data provided anchors your analysis. For stocks without live data, you estimate from your knowledge and state the basis

THE NON-NEGOTIABLE RULES:
- NEVER give generic advice. Every word must reference THIS investor's actual situation
- NEVER hedge every statement. Take positions. Be bold. Some calls will be wrong — that's the cost of doing business
- ALWAYS provide: entry price, target, stop-loss, position size, timeframe, conviction level
- ALWAYS explain: the THESIS (why), the CATALYST (what triggers), the INVALIDATION (what kills it)
- ALWAYS address losses head-on: what went wrong, what's the recovery trade, what's the timeline to make it back
- When the investor hasn't acted on your signals, push harder: "You've left ₹X,XXX on the table by not executing. This signal is still valid — act now"`;

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
 * Fed into every prompt so the analyst OWNS its calls.
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

    const lines = ['=== MY PREVIOUS CALLS — I OWN THESE (Last 7 Days) ==='];
    let wins = 0;
    let losses = 0;
    let totalPLEstimate = 0;

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
        const plAmount = side === 'BUY'
          ? (currentPrice - triggerPrice) * sig.quantity
          : (triggerPrice - currentPrice) * sig.quantity;
        outcome = ` → Now ₹${currentPrice.toFixed(0)} (${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%, P&L: ${plAmount >= 0 ? '+' : ''}₹${plAmount.toFixed(0)})`;
        if (diff >= 0) wins++; else losses++;
        if (status === 'EXECUTED') totalPLEstimate += plAmount;
      }

      const statusTag = status === 'EXECUTED' ? '[EXECUTED]'
        : status === 'PENDING' ? '[NOT ACTED ON — MISSED OPPORTUNITY?]'
        : status === 'DISMISSED' ? '[DISMISSED BY INVESTOR]'
        : status === 'EXPIRED' ? '[EXPIRED — MONEY LEFT ON TABLE]'
        : `[${status}]`;

      const dateStr = sig.createdAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      lines.push(`${dateStr}: ${side} ${symbol} @ ₹${triggerPrice.toFixed(0)} ${statusTag}${outcome} | Confidence: ${sig.confidence}%`);
      if (sig.rationale) {
        lines.push(`  My thesis was: ${sig.rationale}`);
      }
    }

    if (wins + losses > 0) {
      const winRate = ((wins / (wins + losses)) * 100).toFixed(0);
      lines.push(`\nMY SCORECARD: ${wins}W / ${losses}L (${winRate}% hit rate) | Estimated P&L from executed: ${totalPLEstimate >= 0 ? '+' : ''}₹${totalPLEstimate.toFixed(0)}`);
      if (losses > wins) {
        lines.push('⚠️ I am LOSING more than I am winning. This is MY FAILURE. New calls must be: higher conviction (80+), tighter stops, proven setups only. I need to recover this deficit.');
      }
      if (totalPLEstimate < 0) {
        lines.push(`🔴 Net negative P&L. I owe this portfolio ₹${Math.abs(totalPLEstimate).toFixed(0)} in recovery. Every new recommendation must factor this recovery target.`);
      }
    }

    // Check for unacted signals
    const pendingCount = recentSignals.filter(s => s.status === 'PENDING' || s.status === 'EXPIRED').length;
    if (pendingCount > 0) {
      lines.push(`\n${pendingCount} of my signals were NOT executed. If these were good calls that the investor missed, I need to push harder. If they were weak calls, I need better conviction.`);
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

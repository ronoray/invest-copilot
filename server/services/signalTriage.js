import Anthropic from '@anthropic-ai/sdk';
import logger from './logger.js';

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

/**
 * Use Claude Haiku to decide if significant price moves warrant signal regeneration.
 *
 * Designed to be extremely cheap:
 *   - Model: claude-haiku-4-5 (~20x cheaper than Sonnet)
 *   - Input: ~300 tokens max
 *   - Output: 80 tokens max (just JSON yes/no)
 *   - Cost per call: ~$0.0001 — negligible even at 10 calls/day
 *
 * @param {Object} portfolio     - Portfolio with ownerName, startingCapital, riskProfile
 * @param {Array}  moves         - [{symbol, prevPrice, currentPrice, changePct}]
 * @param {number} pendingCount  - Number of current PENDING/SNOOZED signals
 * @returns {Promise<{shouldRegen: boolean, reason: string}>}
 */
export async function triageSignalRegen(portfolio, moves, pendingCount) {
  try {
    const moveList = moves
      .map(m => `${m.symbol}: ${m.changePct > 0 ? '+' : ''}${m.changePct.toFixed(1)}% (₹${m.prevPrice.toFixed(0)} → ₹${m.currentPrice.toFixed(0)})`)
      .join(', ');

    const prompt = `Trade signal triage. Portfolio: ${portfolio.ownerName || portfolio.name}, ₹${parseFloat(portfolio.startingCapital || 0).toFixed(0)} capital, ${portfolio.riskProfile || 'moderate'} risk. Pending signals: ${pendingCount}.

Price moves since today's signal generation: ${moveList}

Regenerate signals? YES only if: a stock in a pending signal moved >5% making its entry/stop irrelevant, OR a broad move suggests signals are directionally wrong. NO if: moves are normal noise, signals are still actionable, or pending=0 (nothing to invalidate).

JSON only: {"shouldRegen": true/false, "reason": "one sentence"}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const json = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());

    logger.info(`[Signal Triage] shouldRegen=${json.shouldRegen} — ${json.reason}`);
    return { shouldRegen: !!json.shouldRegen, reason: json.reason || '' };
  } catch (err) {
    logger.error('[Signal Triage] Haiku triage failed:', err.message);
    return { shouldRegen: false, reason: 'triage error' };
  }
}

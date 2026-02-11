import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import { buildProfileBrief } from './advancedScreener.js';
import { ANALYST_IDENTITY, MARKET_DATA_INSTRUCTION, buildAccountabilityScorecard } from './analystPrompts.js';
import { fetchMarketContext } from './marketData.js';
import logger from './logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Compute the AI-recommended daily earning target for a portfolio.
 * Uses ownership mentality, yesterday's carryover, market context, and per-holding breakdown.
 *
 * @param {number} portfolioId
 * @returns {Promise<{ aiTarget: number, aiRationale: string, aiConfidence: number }>}
 */
export async function computeAiTarget(portfolioId) {
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: { holdings: true }
  });

  if (!portfolio) {
    throw new Error(`Portfolio ${portfolioId} not found`);
  }

  const profileBrief = buildProfileBrief(portfolio);
  const holdings = portfolio.holdings || [];
  const holdingsCount = holdings.length;
  const totalInvested = holdings.reduce(
    (sum, h) => sum + h.quantity * parseFloat(h.avgPrice), 0
  );
  const totalCurrent = holdings.reduce(
    (sum, h) => sum + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0
  );

  // Fetch yesterday's DailyTarget for carryover deficit
  let yesterdayContext = '';
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    // Look back up to 5 days to find the last trading day's target
    for (let i = 0; i < 5; i++) {
      const checkDate = new Date(yesterday);
      checkDate.setDate(checkDate.getDate() - i);
      checkDate.setHours(0, 0, 0, 0);

      const prevTarget = await prisma.dailyTarget.findUnique({
        where: { portfolioId_date: { portfolioId, date: checkDate } }
      });

      if (prevTarget) {
        const prevEffective = parseFloat(prevTarget.userTarget || prevTarget.aiTarget || 0);
        const prevEarned = parseFloat(prevTarget.earnedActual || 0);
        const deficit = prevEffective - prevEarned;

        if (deficit > 0) {
          yesterdayContext = `YESTERDAY'S RESULT: Target was ₹${prevEffective.toFixed(0)}, earned ₹${prevEarned.toFixed(0)}, DEFICIT ₹${deficit.toFixed(0)}. This deficit MUST be factored into today's recovery plan. I failed yesterday — today I make it back.`;
        } else {
          yesterdayContext = `YESTERDAY'S RESULT: Target was ₹${prevEffective.toFixed(0)}, earned ₹${prevEarned.toFixed(0)} — TARGET MET with ₹${Math.abs(deficit).toFixed(0)} surplus. Momentum is on our side. Set today's target with confidence.`;
        }
        break;
      }
    }
  } catch (e) {
    logger.warn('Could not fetch yesterday target for carryover:', e.message);
  }

  // Fetch market context
  let marketContext = '';
  try {
    marketContext = await fetchMarketContext(holdings);
  } catch (e) {
    logger.warn('Could not fetch market context for target:', e.message);
  }

  // Build accountability scorecard
  let scorecard = '';
  try {
    scorecard = await buildAccountabilityScorecard(portfolioId);
  } catch (e) {
    logger.warn('Could not build scorecard for target:', e.message);
  }

  // Build per-holding breakdown for the prompt
  const holdingsBreakdown = holdings
    .map(h => {
      const invested = h.quantity * parseFloat(h.avgPrice);
      const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
      const pl = current - invested;
      return `${h.symbol} (${h.exchange || 'NSE'}): ${h.quantity} shares, avg ₹${parseFloat(h.avgPrice).toFixed(0)}, current ₹${parseFloat(h.currentPrice || h.avgPrice).toFixed(0)}, P&L ${pl >= 0 ? '+' : ''}₹${pl.toFixed(0)}`;
    })
    .join('\n');

  const prompt = `${ANALYST_IDENTITY}

${marketContext}
${MARKET_DATA_INSTRUCTION}

${scorecard}

${profileBrief}

HOLDINGS BREAKDOWN:
${holdingsBreakdown || 'No holdings'}

Total Invested: ₹${totalInvested.toLocaleString('en-IN')}
Current Value: ₹${totalCurrent.toLocaleString('en-IN')}
Number of Holdings: ${holdingsCount}

${yesterdayContext}

TASK: Compute today's REALISTIC daily earning target for this portfolio. This is MY portfolio and I own every rupee.

Rules:
- Base the target on ACTUAL holdings — estimate each stock's realistic intraday range (typical daily swing 0.5-2%)
- Calculate per-holding expected contribution: "INFY: ₹X from 0.8% expected move on 50 shares"
- If yesterday had a deficit, include recovery amount in today's target (aggressive but achievable)
- The target must be achievable 60-70% of trading days — not aspirational
- If portfolio is small (< ₹1 lakh invested), keep target proportionally modest
- Factor in current market conditions — trending days allow higher targets than choppy/range-bound days
- If no holdings, suggest based on available cash and risk profile

Respond in this EXACT JSON format (no markdown, no extra text):
{
  "aiTarget": <number in INR>,
  "aiRationale": "<2-3 sentences: why this target, per-holding expected contributions, recovery plan if deficit>",
  "aiConfidence": <number 0-100>
}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    return {
      aiTarget: parseFloat(result.aiTarget) || 0,
      aiRationale: result.aiRationale || 'AI analysis completed.',
      aiConfidence: Math.min(100, Math.max(0, parseInt(result.aiConfidence) || 50))
    };
  } catch (error) {
    logger.error('AI target computation failed:', error.message);
    const fallbackTarget = totalInvested > 0 ? Math.round(totalInvested * 0.003) : 100;
    return {
      aiTarget: fallbackTarget,
      aiRationale: 'AI analysis unavailable. Using conservative estimate based on portfolio size.',
      aiConfidence: 30
    };
  }
}

/**
 * Get or create today's DailyTarget record for a portfolio.
 */
export async function getOrCreateTodayTarget(portfolioId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let record = await prisma.dailyTarget.findUnique({
    where: {
      portfolioId_date: { portfolioId, date: today }
    }
  });

  if (!record) {
    record = await prisma.dailyTarget.create({
      data: {
        portfolioId,
        date: today,
        aiTarget: 0,
        earnedActual: 0
      }
    });
  }

  return record;
}

/**
 * Refresh AI target for today (called on-demand or by cron).
 */
export async function refreshAiTarget(portfolioId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const aiResult = await computeAiTarget(portfolioId);

  const record = await prisma.dailyTarget.upsert({
    where: {
      portfolioId_date: { portfolioId, date: today }
    },
    update: {
      aiTarget: aiResult.aiTarget,
      aiRationale: aiResult.aiRationale,
      aiConfidence: aiResult.aiConfidence,
      aiUpdatedAt: new Date()
    },
    create: {
      portfolioId,
      date: today,
      aiTarget: aiResult.aiTarget,
      aiRationale: aiResult.aiRationale,
      aiConfidence: aiResult.aiConfidence,
      aiUpdatedAt: new Date(),
      earnedActual: 0
    }
  });

  return record;
}

export default {
  computeAiTarget,
  getOrCreateTodayTarget,
  refreshAiTarget
};

import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import { buildProfileBrief } from './advancedScreener.js';
import logger from './logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Compute the AI-recommended daily earning target for a portfolio.
 * Considers: holdings, risk profile, available cash, market structure.
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
  const holdingsCount = (portfolio.holdings || []).length;
  const totalInvested = (portfolio.holdings || []).reduce(
    (sum, h) => sum + h.quantity * parseFloat(h.avgPrice), 0
  );
  const totalCurrent = (portfolio.holdings || []).reduce(
    (sum, h) => sum + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0
  );

  const prompt = `You are an expert Indian stock market analyst. Given this investor profile and portfolio, compute a REALISTIC daily earning target.

${profileBrief}

Total Invested: ${totalInvested.toLocaleString('en-IN')}
Current Value: ${totalCurrent.toLocaleString('en-IN')}
Number of Holdings: ${holdingsCount}

Rules:
- Consider current Indian market volatility (typical daily swings 0.5-2% on individual stocks).
- The target should be ACHIEVABLE through realistic intraday/short-term moves on their existing holdings.
- Be conservative — a target that can be hit 60-70% of trading days is better than an ambitious one.
- If the portfolio is small (< 1 lakh invested), the target should be proportionally modest.
- If no holdings, suggest based on available cash and risk profile.

Respond in this EXACT JSON format (no markdown, no extra text):
{
  "aiTarget": <number in INR>,
  "aiRationale": "<2-3 sentence explanation of why this target is feasible>",
  "aiConfidence": <number 0-100>
}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    // Parse JSON from response (handle potential markdown wrapping)
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    return {
      aiTarget: parseFloat(result.aiTarget) || 0,
      aiRationale: result.aiRationale || 'AI analysis completed.',
      aiConfidence: Math.min(100, Math.max(0, parseInt(result.aiConfidence) || 50))
    };
  } catch (error) {
    logger.error('AI target computation failed:', error.message);
    // Fallback: 0.3% of invested value as a conservative target
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

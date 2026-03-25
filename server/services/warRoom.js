// server/services/warRoom.js
// War Room Intelligence Layer — generates morning plan, checks deviations,
// triggers recalibration, builds hourly pulse messages, evening playbook.

import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import { getCurrentPrice, fetchMarketContext } from './marketData.js';
import { getUpstoxLTP } from './upstoxMarketData.js';
import { ANALYST_IDENTITY, MARKET_DATA_INSTRUCTION, ELITE_TRADER_EDGE, buildAccountabilityScorecard } from './analystPrompts.js';
import { buildProfileBrief } from './advancedScreener.js';
import { getEffectiveCash } from './capitalGuard.js';
import logger from './logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

// ============================================
// UTILITY: Get today's DailyTarget with warRoomPlan
// ============================================

export async function getTodayWarRoomPlan(portfolioId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const target = await prisma.dailyTarget.findUnique({
    where: { portfolioId_date: { portfolioId, date: today } }
  });

  if (!target || !target.warRoomPlan) return null;

  return typeof target.warRoomPlan === 'string'
    ? JSON.parse(target.warRoomPlan)
    : target.warRoomPlan;
}

// ============================================
// GENERATE WAR ROOM PLAN — 1 Claude call
// ============================================

export async function generateWarRoomPlan(portfolioId) {
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: { holdings: true }
  });

  if (!portfolio) throw new Error(`Portfolio ${portfolioId} not found`);

  const profileBrief = buildProfileBrief(portfolio);
  const holdings = portfolio.holdings || [];
  const totalInvested = holdings.reduce((s, h) => s + h.quantity * parseFloat(h.avgPrice), 0);
  const totalCurrent = holdings.reduce((s, h) => s + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0);

  // Effective cash
  let effectiveCash = parseFloat(portfolio.availableCash || 0);
  try {
    const cashResult = await getEffectiveCash(portfolioId);
    effectiveCash = cashResult.effectiveCash;
  } catch (e) {
    logger.warn(`Could not get effective cash for portfolio ${portfolioId}:`, e.message);
  }

  // Market context
  let marketContext = '';
  try {
    marketContext = await fetchMarketContext(holdings);
  } catch (e) {
    logger.warn(`Could not fetch market context for war room (portfolio ${portfolioId}):`, e.message);
  }

  // Scorecard
  let scorecard = '';
  try {
    scorecard = await buildAccountabilityScorecard(portfolioId);
  } catch (e) {
    logger.warn(`Could not build scorecard for war room (portfolio ${portfolioId}):`, e.message);
  }

  // Yesterday carryover
  let yesterdayContext = '';
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
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
          yesterdayContext = `YESTERDAY: Target ₹${prevEffective.toFixed(0)}, Earned ₹${prevEarned.toFixed(0)}, DEFICIT ₹${deficit.toFixed(0)}. Recovery required.`;
        } else {
          yesterdayContext = `YESTERDAY: Target ₹${prevEffective.toFixed(0)}, Earned ₹${prevEarned.toFixed(0)}, SURPLUS ₹${Math.abs(deficit).toFixed(0)}. Momentum is positive.`;
        }
        break;
      }
    }
  } catch (e) {
    logger.warn('Could not fetch yesterday context:', e.message);
  }

  // Holdings breakdown
  const holdingsBreakdown = holdings.map(h => {
    const invested = h.quantity * parseFloat(h.avgPrice);
    const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
    const pl = current - invested;
    return `${h.symbol} (${h.exchange || 'NSE'}): ${h.quantity} shares, avg ₹${parseFloat(h.avgPrice).toFixed(0)}, current ₹${parseFloat(h.currentPrice || h.avgPrice).toFixed(0)}, P&L ${pl >= 0 ? '+' : ''}₹${pl.toFixed(0)}`;
  }).join('\n');

  const prompt = `${ANALYST_IDENTITY}

${ELITE_TRADER_EDGE}

${marketContext}
${MARKET_DATA_INSTRUCTION}

${scorecard}

${profileBrief}

HOLDINGS:
${holdingsBreakdown || 'No holdings'}

Total Invested: ₹${totalInvested.toLocaleString('en-IN')}
Current Value: ₹${totalCurrent.toLocaleString('en-IN')}
Effective Cash: ₹${effectiveCash.toFixed(0)}
Starting Capital: ₹${parseFloat(portfolio.startingCapital || 0).toFixed(0)}

${yesterdayContext}

TASK: Generate today's WAR ROOM PLAN. This is the master intelligence document for the entire trading day.

You MUST respond with ONLY valid JSON (no markdown, no extra text) in this exact structure:
{
  "marketThesis": {
    "direction": "BULLISH|BEARISH|NEUTRAL|BULLISH_CAUTIOUS|BEARISH_CAUTIOUS",
    "summary": "2-3 sentence thesis",
    "keyLevels": { "niftySupport": 0, "niftyResistance": 0 },
    "invalidation": "what breaks thesis",
    "sectorRotation": "where smart money is flowing"
  },
  "dailyTarget": {
    "amount": 0,
    "confidence": 0,
    "rationale": "per-holding contribution breakdown",
    "breakdown": [{ "symbol": "SYM", "expectedContribution": 0, "expectedMovePct": 0 }]
  },
  "holdings": [{
    "symbol": "SYM", "exchange": "NSE",
    "action": "HOLD|ADD|EXIT|TRIM|WATCH",
    "intradayTarget": 0, "stopLoss": 0,
    "notes": "1-line thesis",
    "partialBookAt": null, "partialBookPct": null,
    "addPrice": null, "addQuantity": null
  }],
  "openingPlays": [{
    "action": "BUY|SELL", "symbol": "SYM", "quantity": 0,
    "price": 0, "orderType": "LIMIT|MARKET", "rationale": "..."
  }],
  "deviationThresholds": {
    "portfolioPLDropPct": -3.0,
    "holdingSurgePct": 5.0,
    "holdingStopLossHit": true,
    "targetBehindPctAtNoon": 50
  },
  "eliteEdge": {
    "fiiFunding": "...", "optionChain": "...",
    "bulkDeals": "...", "deliveryWatch": "..."
  }
}

${portfolio.broker === 'UPSTOX' && portfolio.apiEnabled ? `UPSTOX LIVE TRADING CONTEXT:
- All opening plays will be sent to Telegram with a 1-tap Execute button. Orders go live on Upstox immediately.
- Product: CNC delivery equity ONLY. No intraday, no F&O. Stocks are held T+1 or longer.
- "openingPlays" BUY orders: LIMIT preferred. Price = the level to buy at, not the current price.
- Size each opening play: 10-20% of available cash ₹${effectiveCash.toFixed(0)} per position max.
- holdings actions (ADD/EXIT/TRIM) will also be sent as executable signals — be precise with price levels.
` : ''}CAPITAL RULES:
- Opening plays BUY total must NOT exceed effective cash ₹${effectiveCash.toFixed(0)}
- Each BUY order must be affordable: quantity * price <= effective cash
- SELL only stocks that are held (see holdings above)
- Daily target must be achievable 60-70% of days — not aspirational
- Per-holding intradayTarget and stopLoss must be realistic (0.5-3% range for intraday)`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const plan = JSON.parse(jsonStr);

    // Add metadata
    plan.generatedAt = new Date().toISOString();
    plan.version = 1;

    // Store in DailyTarget
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.dailyTarget.upsert({
      where: { portfolioId_date: { portfolioId, date: today } },
      update: {
        warRoomPlan: plan,
        recalibrationCount: 0,
        aiTarget: parseFloat(plan.dailyTarget?.amount) || 0,
        aiRationale: plan.dailyTarget?.rationale || '',
        aiConfidence: Math.min(100, Math.max(0, parseInt(plan.dailyTarget?.confidence) || 50)),
        aiUpdatedAt: new Date()
      },
      create: {
        portfolioId,
        date: today,
        warRoomPlan: plan,
        recalibrationCount: 0,
        aiTarget: parseFloat(plan.dailyTarget?.amount) || 0,
        aiRationale: plan.dailyTarget?.rationale || '',
        aiConfidence: Math.min(100, Math.max(0, parseInt(plan.dailyTarget?.confidence) || 50)),
        aiUpdatedAt: new Date(),
        earnedActual: 0
      }
    });

    logger.info(`War room plan generated for portfolio ${portfolioId}: target ₹${plan.dailyTarget?.amount || 0}`);
    return plan;
  } catch (error) {
    logger.error(`War room plan generation failed for portfolio ${portfolioId}:`, error.message);
    throw error;
  }
}

// ============================================
// CHECK DEVIATIONS — 0 Claude calls
// ============================================

export async function checkDeviations(portfolioId) {
  const plan = await getTodayWarRoomPlan(portfolioId);
  if (!plan) return { deviated: false, reason: 'No war room plan for today' };

  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: { holdings: true }
  });

  if (!portfolio) return { deviated: false, reason: 'Portfolio not found' };

  const holdings = portfolio.holdings || [];
  const planHoldings = plan.holdings || [];
  const thresholds = plan.deviationThresholds || {};

  // Batch-fetch live LTP via Upstox (real-time, single API call, no sleep needed)
  const symbols = holdings.map(h => h.symbol).filter(Boolean);
  let ltpMap = new Map();
  try {
    if (symbols.length > 0) {
      ltpMap = await getUpstoxLTP(symbols);
    }
  } catch (e) {
    logger.warn(`[WarRoom] Upstox LTP batch failed, falling back to DB prices: ${e.message}`);
  }

  let intradayPL = 0;
  const holdingDetails = [];

  for (const h of holdings) {
    const liveEntry = ltpMap.get(h.symbol);
    // Primary: Upstox live LTP. Fallback: DB currentPrice. P&L baseline = avgPrice (entry cost).
    const livePrice = liveEntry?.price || parseFloat(h.currentPrice || 0);
    if (!livePrice) continue;

    const avgPrice = parseFloat(h.avgPrice || 0);
    if (!avgPrice) continue;

    const pl      = (livePrice - avgPrice) * h.quantity;
    const pctMove = (livePrice - avgPrice) / avgPrice * 100;
    intradayPL += pl;

    const planH = planHoldings.find(ph => ph.symbol === h.symbol);

    holdingDetails.push({
      symbol: h.symbol,
      livePrice,
      storedPrice: avgPrice,
      pl,
      pctMove,
      stopLoss: planH?.stopLoss,
      intradayTarget: planH?.intradayTarget,
      addPrice: planH?.addPrice,
      action: planH?.action,
      live: !!liveEntry   // flag: true = Upstox real-time, false = DB fallback
    });
  }

  // Check deviation conditions
  const reasons = [];

  // 1. Portfolio P&L drop
  const totalInvested = holdings.reduce((s, h) => s + h.quantity * parseFloat(h.avgPrice), 0);
  if (totalInvested > 0) {
    const plPct = (intradayPL / totalInvested) * 100;
    if (plPct < (thresholds.portfolioPLDropPct || -3.0)) {
      reasons.push(`Portfolio P&L dropped ${plPct.toFixed(1)}% (threshold: ${thresholds.portfolioPLDropPct}%)`);
    }
  }

  // 2. Stop loss hit
  if (thresholds.holdingStopLossHit !== false) {
    for (const hd of holdingDetails) {
      if (hd.stopLoss && hd.livePrice <= hd.stopLoss) {
        reasons.push(`${hd.symbol} hit stop loss ₹${hd.stopLoss} (now ₹${hd.livePrice.toFixed(0)})`);
      }
    }
  }

  // 3. Holding surge
  const surgePct = thresholds.holdingSurgePct || 5.0;
  for (const hd of holdingDetails) {
    if (hd.pctMove > surgePct) {
      reasons.push(`${hd.symbol} surged ${hd.pctMove.toFixed(1)}% (threshold: ${surgePct}%)`);
    }
  }

  // 4. Target behind at noon
  const now = new Date();
  if (now.getHours() >= 12) {
    const targetAmount = plan.dailyTarget?.amount || 0;
    const behindPct = thresholds.targetBehindPctAtNoon || 50;
    if (targetAmount > 0 && intradayPL < targetAmount * (1 - behindPct / 100)) {
      // Check if there are pending signals that might close the gap
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const pendingSignals = await prisma.tradeSignal.count({
        where: {
          portfolioId,
          status: { in: ['PENDING', 'SNOOZED'] },
          createdAt: { gte: today }
        }
      });
      if (pendingSignals === 0) {
        reasons.push(`Target ${(behindPct)}%+ behind at noon (earned ₹${intradayPL.toFixed(0)} vs target ₹${targetAmount.toFixed(0)}, no pending signals)`);
      }
    }
  }

  return {
    deviated: reasons.length > 0,
    reason: reasons.join('; '),
    holdingDetails,
    intradayPL
  };
}

// ============================================
// TRIGGER RECALIBRATION — 1 Claude call (max 2/day)
// ============================================

export async function triggerRecalibration(portfolioId, reason) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const target = await prisma.dailyTarget.findUnique({
    where: { portfolioId_date: { portfolioId, date: today } }
  });

  if (!target || !target.warRoomPlan) {
    logger.warn(`No war room plan to recalibrate for portfolio ${portfolioId}`);
    return null;
  }

  if (target.recalibrationCount >= 2) {
    logger.info(`Recalibration cap reached for portfolio ${portfolioId} (count: ${target.recalibrationCount})`);
    return null;
  }

  const plan = typeof target.warRoomPlan === 'string' ? JSON.parse(target.warRoomPlan) : target.warRoomPlan;

  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: { holdings: true }
  });

  if (!portfolio) return null;

  const profileBrief = buildProfileBrief(portfolio);

  const prompt = `${ANALYST_IDENTITY}

${ELITE_TRADER_EDGE}

CURRENT WAR ROOM PLAN (generated this morning):
${JSON.stringify(plan, null, 2)}

DEVIATION DETECTED: ${reason}

TASK: Recalibrate the war room plan based on this deviation. Update holdings actions, targets, stop-losses, and daily target as needed.

Rules:
- Keep the same JSON structure as the original plan
- Adjust holdings that triggered the deviation
- Update daily target if it's now unreachable or should be revised
- Provide updated opening plays if new trades are needed
- Be aggressive about cutting losses and rotating into strength
- Effective cash for new BUY orders: check original plan for context

Respond with ONLY valid JSON (no markdown). Same structure as the war room plan.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const updatedPlan = JSON.parse(jsonStr);

    updatedPlan.generatedAt = new Date().toISOString();
    updatedPlan.version = (plan.version || 1) + 1;
    updatedPlan.recalibratedFrom = reason;

    await prisma.dailyTarget.update({
      where: { id: target.id },
      data: {
        warRoomPlan: updatedPlan,
        recalibrationCount: { increment: 1 },
        aiTarget: parseFloat(updatedPlan.dailyTarget?.amount) || target.aiTarget,
        aiRationale: updatedPlan.dailyTarget?.rationale || target.aiRationale,
        aiConfidence: Math.min(100, Math.max(0, parseInt(updatedPlan.dailyTarget?.confidence) || target.aiConfidence)),
        aiUpdatedAt: new Date()
      }
    });

    logger.info(`War room recalibrated for portfolio ${portfolioId} (reason: ${reason})`);
    return updatedPlan;
  } catch (error) {
    logger.error(`Recalibration failed for portfolio ${portfolioId}:`, error.message);
    return null;
  }
}

// ============================================
// BUILD HOURLY PULSE MESSAGE — 0 Claude calls
// ============================================

export async function buildHourlyPulseMessage(portfolioId, deviationResult) {
  const plan = await getTodayWarRoomPlan(portfolioId);
  if (!plan) return null;

  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: { holdings: true }
  });
  if (!portfolio) return null;

  const now = new Date();
  const hours = now.getHours();
  const minutesLeft = (15 * 60 + 30) - (hours * 60 + now.getMinutes());

  // Time-aware framing
  let timeLabel;
  if (hours === 10) timeLabel = 'OPENING PULSE';
  else if (hours === 15) timeLabel = 'FINAL HOUR';
  else if (hours === 12) timeLabel = 'MIDDAY CHECK';
  else timeLabel = `${hours > 12 ? hours - 12 : hours}${hours >= 12 ? 'PM' : 'AM'} PULSE`;

  const holdingDetails = deviationResult?.holdingDetails || [];
  const intradayPL = deviationResult?.intradayPL || 0;

  const targetAmount = plan.dailyTarget?.amount || 0;
  const gap = targetAmount - intradayPL;
  const pctAchieved = targetAmount > 0 ? ((intradayPL / targetAmount) * 100) : 0;

  // Build per-holding action callouts
  const holdingLines = [];
  for (const hd of holdingDetails) {
    const planH = (plan.holdings || []).find(ph => ph.symbol === hd.symbol);
    if (!planH) continue;

    const plSign = hd.pl >= 0 ? '+' : '';
    let actionCallout = '';

    if (planH.stopLoss && hd.livePrice <= planH.stopLoss * 1.02) {
      actionCallout = '🛑 NEAR STOP → EXIT IF BREACHED';
    } else if (planH.intradayTarget && hd.livePrice >= planH.intradayTarget * 0.98) {
      actionCallout = '🎯 APPROACHING TARGET → BOOK PROFIT';
    } else if (planH.partialBookAt && hd.livePrice >= planH.partialBookAt * 0.98) {
      actionCallout = `📊 PARTIAL BOOK ZONE → Sell ${planH.partialBookPct || 50}%`;
    } else if (planH.addPrice && hd.livePrice <= planH.addPrice * 1.02) {
      actionCallout = `🟢 HIT ADD ZONE → BUY ${planH.addQuantity || 'more'}`;
    } else if (hd.pctMove > 2) {
      actionCallout = '🚀 STRONG MOVE';
    } else if (hd.pctMove < -2) {
      actionCallout = '⚠️ UNDER PRESSURE';
    }

    const staleMark = hd.live === false ? ' _(stale)_' : '';
    holdingLines.push(`${hd.symbol}: ₹${hd.livePrice.toFixed(0)} (${plSign}₹${hd.pl.toFixed(0)})${staleMark}${actionCallout ? ' ' + actionCallout : ''}`);
  }

  // Check for pending signals
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const pendingSignals = await prisma.tradeSignal.findMany({
    where: {
      portfolioId,
      status: { in: ['PENDING', 'SNOOZED'] },
      createdAt: { gte: today }
    }
  });

  const signalLine = pendingSignals.length > 0
    ? `\n⚡ ${pendingSignals.length} PENDING SIGNAL(S) — EXECUTE NOW`
    : '';

  // Target status emoji
  let targetStatus;
  if (pctAchieved >= 100) targetStatus = '✅ TARGET HIT';
  else if (pctAchieved >= 70) targetStatus = '🟢 ON TRACK';
  else if (pctAchieved >= 40) targetStatus = '🟡 NEEDS PUSH';
  else targetStatus = '🔴 BEHIND';

  // Escape MarkdownV1 special chars in Claude-generated text to prevent Telegram parse errors
  const escMd = (s) => (s || '').replace(/[_*`[]/g, '\\$&');

  const pName = `${portfolio.ownerName || portfolio.name} - ${(portfolio.broker || 'Unknown').replace(/_/g, ' ')}`;
  const thesisLine = plan.marketThesis?.summary ? `\nThesis: ${escMd(plan.marketThesis.summary)}` : '';

  const msg = `📡 ${timeLabel}
━━━━━━━━━━━━━━━━━━━
📁 ${pName}

🎯 Target: ₹${targetAmount.toFixed(0)} | P&L: ${intradayPL >= 0 ? '+' : ''}₹${intradayPL.toFixed(0)} (${pctAchieved.toFixed(0)}%)
${targetStatus}${gap > 0 ? ` — Gap: ₹${gap.toFixed(0)}` : ''}
⏱ ${minutesLeft > 0 ? `${Math.floor(minutesLeft / 60)}h ${minutesLeft % 60}m to close` : 'Market closed'}

${holdingLines.join('\n') || '💰 No open positions — 100% cash'}${signalLine}${thesisLine}
━━━━━━━━━━━━━━━━━━━`;

  return msg;
}

// ============================================
// GENERATE EVENING PLAYBOOK — 1 Claude call
// ============================================

export async function generateEveningPlaybook(portfolioId) {
  const plan = await getTodayWarRoomPlan(portfolioId);

  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: { holdings: true }
  });

  if (!portfolio) throw new Error(`Portfolio ${portfolioId} not found`);

  // Fetch live effective cash — signals must be sized to what we actually have
  let effectiveCash = parseFloat(portfolio.availableCash || 0);
  try {
    const cashResult = await getEffectiveCash(portfolioId);
    effectiveCash = cashResult.effectiveCash;
  } catch (e) {
    logger.warn(`Could not get effective cash for evening playbook (portfolio ${portfolioId}):`, e.message);
  }

  const profileBrief = buildProfileBrief(portfolio);

  // Get today's target for actual results
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTarget = await prisma.dailyTarget.findUnique({
    where: { portfolioId_date: { portfolioId, date: today } }
  });

  const earnedActual = parseFloat(todayTarget?.earnedActual || 0);
  const targetAmount = parseFloat(todayTarget?.aiTarget || todayTarget?.userTarget || 0);
  const recalibrations = todayTarget?.recalibrationCount || 0;

  // Scorecard
  let scorecard = '';
  try {
    scorecard = await buildAccountabilityScorecard(portfolioId);
  } catch (e) {
    logger.warn(`Could not build scorecard for evening playbook (portfolio ${portfolioId}):`, e.message);
  }

  // Holdings breakdown
  const holdings = portfolio.holdings || [];
  const holdingsBreakdown = holdings.map(h => {
    const invested = h.quantity * parseFloat(h.avgPrice);
    const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
    const pl = current - invested;
    return `${h.symbol}: ${h.quantity} @ ₹${parseFloat(h.avgPrice).toFixed(0)}, now ₹${parseFloat(h.currentPrice || h.avgPrice).toFixed(0)}, P&L ${pl >= 0 ? '+' : ''}₹${pl.toFixed(0)}`;
  }).join('\n');

  const warRoomSummary = plan
    ? `WAR ROOM PLAN (this morning):
Thesis: ${plan.marketThesis?.summary || 'N/A'}
Target: ₹${plan.dailyTarget?.amount || 0} (confidence ${plan.dailyTarget?.confidence || 0}%)
Recalibrations today: ${recalibrations}
Holdings actions planned: ${(plan.holdings || []).map(h => `${h.symbol}: ${h.action}`).join(', ')}
Opening plays: ${(plan.openingPlays || []).map(p => `${p.action} ${p.symbol}`).join(', ') || 'None'}`
    : 'No war room plan was generated today.';

  const prompt = `${ANALYST_IDENTITY}

${ELITE_TRADER_EDGE}

${scorecard}

${profileBrief}

${warRoomSummary}

TODAY'S ACTUAL RESULTS:
Target: ₹${targetAmount.toFixed(0)} | Earned: ${earnedActual >= 0 ? '+' : ''}₹${earnedActual.toFixed(0)} | ${earnedActual >= targetAmount ? 'TARGET MET' : `MISSED by ₹${(targetAmount - earnedActual).toFixed(0)}`}

CURRENT HOLDINGS:
${holdingsBreakdown || 'No holdings'}

CAPITAL RULES FOR tomorrowPlays:
- AVAILABLE CASH (verified from Upstox): ₹${effectiveCash.toFixed(0)}
- Maximum 2 BUY signals. 2 focused positions > 5 spread ones. Concentrate capital on highest conviction.
- Total BUY cost (sum of quantity × price) MUST NOT exceed ₹${effectiveCash.toFixed(0)}
- Per-position size: 15–25% of cash (₹${Math.round(effectiveCash * 0.15)} – ₹${Math.round(effectiveCash * 0.25)} per trade)
- Show math for each BUY: e.g. "10 × ₹1,500 = ₹15,000 (27% of cash)"
- SELL only stocks listed in CURRENT HOLDINGS above. No phantom sells.
- If no high-conviction setup fits within this capital, return an empty tomorrowPlays array. That is the correct call.
${portfolio.broker === 'UPSTOX' && portfolio.apiEnabled ? `- LIMIT orders only. Tomorrow's plays become executable Telegram signals at tomorrow's open.
- CNC delivery equity only — no intraday, no F&O.
` : ''}
TASK: Generate the EVENING PLAYBOOK. This replaces both the evening review AND tomorrow's game plan.

Respond with ONLY valid JSON (no markdown):
{
  "todayReview": {
    "grade": "A|B|C|D|F",
    "whatWorked": "...",
    "whatFailed": "...",
    "accountability": "own the result in 1 sentence"
  },
  "holdingVerdicts": [{
    "symbol": "SYM",
    "verdict": "HOLD|ADD|EXIT|TRIM",
    "reason": "1-line"
  }],
  "tomorrowPlays": [{
    "action": "BUY|SELL",
    "symbol": "SYM",
    "exchange": "NSE",
    "quantity": 0,
    "price": 0,
    "orderType": "LIMIT|MARKET",
    "rationale": "...",
    "capitalUsed": "e.g. 10 × ₹1500 = ₹15,000 (27% of ₹${effectiveCash.toFixed(0)})"
  }],
  "capitalCheck": "Total BUY cost: ₹X / ₹${effectiveCash.toFixed(0)} available — OK|OVER",
  "macroThesis": "overnight thesis for tomorrow",
  "weeklyProgress": "progress assessment + acceleration plan if behind"
}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const playbook = JSON.parse(jsonStr);

    // Cap tomorrowPlays BUY signals at 2 (post-generation guard)
    const buys = (playbook.tomorrowPlays || []).filter(p => p.action === 'BUY');
    const sells = (playbook.tomorrowPlays || []).filter(p => p.action === 'SELL');
    if (buys.length > 2) {
      // Keep highest-priced buys (typically highest conviction) — trim the rest
      buys.sort((a, b) => (b.price || 0) - (a.price || 0));
      logger.info(`[EveningPlaybook] Trimmed ${buys.length - 2} excess BUY signals (cap = 2)`);
    }
    playbook.tomorrowPlays = [...buys.slice(0, 2), ...sells];

    // Attach metadata for callers
    playbook._effectiveCash = effectiveCash;

    return playbook;
  } catch (error) {
    logger.error(`Evening playbook generation failed for portfolio ${portfolioId}: ${error?.message || String(error)}`);
    throw error;
  }
}

export default {
  getTodayWarRoomPlan,
  generateWarRoomPlan,
  checkDeviations,
  triggerRecalibration,
  buildHourlyPulseMessage,
  generateEveningPlaybook
};

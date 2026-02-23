import cron from 'node-cron';
import prisma from '../services/prisma.js';
import { getCurrentPrice } from '../services/marketData.js';
import { getBot } from '../services/telegramBot.js';
import { generateWarRoomPlan, checkDeviations, triggerRecalibration, buildHourlyPulseMessage, generateEveningPlaybook } from '../services/warRoom.js';
import logger from '../services/logger.js';
import { isTradingDay, isMarketHoliday } from '../utils/marketHolidays.js';

// ============================================
// HELPER: Get User Portfolios with Holdings
// ============================================

async function getUserPortfolios(userId) {
  return prisma.portfolio.findMany({
    where: { userId, isActive: true, isPaused: false },
    include: { holdings: true }
  });
}

// ============================================
// HELPER: Compute portfolio value summary
// ============================================

function getPortfolioValueSummary(portfolio) {
  let totalValue = 0;
  let totalInvested = 0;

  for (const h of portfolio.holdings || []) {
    const invested = h.quantity * parseFloat(h.avgPrice);
    const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
    totalInvested += invested;
    totalValue += current;
  }

  const totalPL = totalValue - totalInvested;
  const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

  return { totalValue, totalInvested, totalPL, totalPLPercent };
}

// ============================================
// HELPER: Send long message (split if > 4000 chars)
// ============================================

async function sendTelegramMessage(chatId, text, options = {}) {
  const bot = getBot();
  if (!bot) return;

  if (text.length <= 4000) {
    await bot.sendMessage(chatId, text, options);
    return;
  }

  const parts = [];
  let current = '';
  const lines = text.split('\n');

  for (const line of lines) {
    if (current.length + line.length + 1 > 3900) {
      if (current.trim()) parts.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (let i = 0; i < parts.length; i++) {
    const partText = parts.length > 1 ? `${parts[i]}\n\n_(${i + 1}/${parts.length})_` : parts[i];
    await bot.sendMessage(chatId, partText, options);
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 300));
  }
}

// ============================================
// HELPER: Portfolio display label
// ============================================

function portfolioLabel(p) {
  const risk = p.riskProfile ? ` (${p.riskProfile})` : '';
  return `${p.ownerName || p.name} - ${(p.broker || 'Unknown').replace(/_/g, ' ')}${risk}`;
}

// ============================================
// HELPER: Format INR
// ============================================

function formatINR(amount) {
  return `₹${parseFloat(amount).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// ============================================
// HELPER: Save Analysis to Database
// ============================================

async function saveAnalysis(userId, category, analysis, metadata = {}) {
  try {
    await prisma.aiAnalysis.create({
      data: {
        userId,
        analysisType: category,
        category,
        analysis,
        metadata
      }
    });
  } catch (error) {
    logger.error(`Failed to save analysis ${category}:`, error.message);
  }
}

// ============================================
// MORNING WAR ROOM (9:00 AM) — 1 AI call per portfolio
// ============================================

async function runMorningWarRoom() {
  if (!isTradingDay(new Date())) {
    const holiday = isMarketHoliday(new Date());
    logger.info(`Market holiday${holiday.name ? ' (' + holiday.name + ')' : ''} — skipping morning war room`);
    return;
  }

  try {
    logger.info('Running Morning War Room...');

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false,
        preferences: { path: ['dailyDigest'], equals: true }
      },
      include: { user: true }
    });

    for (const telegramUser of users) {
      try {
        const portfolios = await getUserPortfolios(telegramUser.user.id);
        if (portfolios.length === 0) continue;

        const chatId = parseInt(telegramUser.telegramId);
        const sections = [];

        for (const portfolio of portfolios) {
          try {
            const plan = await generateWarRoomPlan(portfolio.id);

            // Format condensed battle plan
            const target = plan.dailyTarget || {};
            const thesis = plan.marketThesis || {};
            const edge = plan.eliteEdge || {};

            // Holdings actions
            const holdingsLines = (plan.holdings || []).map(h => {
              let line = `${h.action} ${h.symbol}`;
              if (h.stopLoss) line += ` | SL: ₹${h.stopLoss}`;
              if (h.intradayTarget) line += ` | Target: ₹${h.intradayTarget}`;
              if (h.notes) line += ` — ${h.notes}`;
              return line;
            }).join('\n');

            // Opening plays
            const playsLines = (plan.openingPlays || []).map(p =>
              `${p.action} ${p.quantity}x ${p.symbol} @ ₹${p.price} (${p.orderType}) — ${p.rationale}`
            ).join('\n');

            // Elite edge
            const edgeLines = [];
            if (edge.fiiFunding) edgeLines.push(`FII/DII: ${edge.fiiFunding}`);
            if (edge.optionChain) edgeLines.push(`OI: ${edge.optionChain}`);
            if (edge.deliveryWatch) edgeLines.push(`Delivery: ${edge.deliveryWatch}`);
            if (edge.bulkDeals) edgeLines.push(`Bulk: ${edge.bulkDeals}`);

            const section = `📁 *${portfolioLabel(portfolio)}*
🎯 Target: ₹${(target.amount || 0).toFixed(0)} (confidence ${target.confidence || 0}%)
${target.rationale || ''}

📊 HOLDINGS ORDERS:
${holdingsLines || 'No specific actions'}

${playsLines ? `⚡ OPENING PLAYS:\n${playsLines}` : ''}

${edgeLines.length > 0 ? `🔍 ELITE EDGE:\n${edgeLines.join('\n')}` : ''}

Thesis: ${thesis.summary || 'N/A'}
Invalidation: ${thesis.invalidation || 'N/A'}`;

            sections.push(section);

            await saveAnalysis(telegramUser.user.id, 'WAR_ROOM', JSON.stringify(plan), { time: 'morning', portfolioId: portfolio.id });
          } catch (planErr) {
            logger.error(`War room failed for portfolio ${portfolio.id}:`, planErr.message);
            sections.push(`📁 *${portfolioLabel(portfolio)}*\n⚠️ War room generation failed. Using fallback monitoring.`);
          }
        }

        const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
        const morningMsg = `☀️ *WAR ROOM — ${dateStr}*
━━━━━━━━━━━━━━━━━━━

${sections.join('\n\n━━━━━━━━━━━━━━━━━━━\n\n')}

━━━━━━━━━━━━━━━━━━━
Execute opening plays NOW. I'm monitoring all day.`;

        await sendTelegramMessage(chatId, morningMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info(`Morning War Room sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`Morning War Room failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`Morning War Room complete for ${users.length} users`);
  } catch (error) {
    logger.error('Morning War Room error:', error);
  }
}

// ============================================
// HOURLY SMART PULSE (10AM-3PM) — 0 AI calls (unless deviation)
// ============================================

async function runHourlySmartPulse() {
  if (!isTradingDay(new Date())) return;

  try {
    logger.info('Running Hourly Smart Pulse...');

    const users = await prisma.telegramUser.findMany({
      where: { isActive: true, isMuted: false },
      include: { user: true }
    });

    for (const telegramUser of users) {
      try {
        const portfolios = await getUserPortfolios(telegramUser.user.id);
        if (portfolios.length === 0) continue;

        const chatId = parseInt(telegramUser.telegramId);

        for (const portfolio of portfolios) {
          try {
            // Check deviations (fetches live prices)
            const deviationResult = await checkDeviations(portfolio.id);

            // If deviated, try recalibration
            if (deviationResult.deviated) {
              logger.info(`Deviation detected for portfolio ${portfolio.id}: ${deviationResult.reason}`);

              const recalibrated = await triggerRecalibration(portfolio.id, deviationResult.reason);
              if (recalibrated) {
                await sendTelegramMessage(chatId,
                  `🔄 *RECALIBRATION*\n━━━━━━━━━━━━━━━━━━━\n📁 ${portfolioLabel(portfolio)}\n\nDeviation: ${deviationResult.reason}\n\nPlan updated. New target: ₹${(recalibrated.dailyTarget?.amount || 0).toFixed(0)}\n${(recalibrated.holdings || []).filter(h => h.action !== 'HOLD').map(h => `${h.action} ${h.symbol} — ${h.notes || ''}`).join('\n') || 'Holdings unchanged'}`,
                  { parse_mode: 'Markdown' }
                );
              }
            }

            // Build and send pulse message
            const pulseMsg = await buildHourlyPulseMessage(portfolio.id, deviationResult);
            if (pulseMsg) {
              await sendTelegramMessage(chatId, pulseMsg, { parse_mode: 'Markdown' });
            }

            // Update earnedActual
            if (deviationResult.intradayPL !== undefined) {
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              try {
                await prisma.dailyTarget.updateMany({
                  where: { portfolioId: portfolio.id, date: today },
                  data: {
                    earnedActual: deviationResult.intradayPL,
                    earnedUpdatedAt: new Date()
                  }
                });
              } catch (e) {
                // Ignore if no target exists yet
              }
            }
          } catch (portfolioErr) {
            logger.error(`Smart pulse failed for portfolio ${portfolio.id}:`, portfolioErr.message);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (userErr) {
        logger.error(`Smart pulse failed for user ${telegramUser.telegramId}:`, userErr);
      }
    }

    logger.info('Hourly Smart Pulse complete');
  } catch (error) {
    logger.error('Hourly Smart Pulse error:', error);
  }
}

// ============================================
// END-OF-DAY SNAPSHOT (3:35 PM) — 0 AI calls
// ============================================

async function runEndOfDaySnapshot() {
  if (!isTradingDay(new Date())) return;

  try {
    logger.info('Running End-of-Day Snapshot...');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const targets = await prisma.dailyTarget.findMany({
      where: { date: today },
      include: {
        portfolio: {
          include: {
            holdings: true,
            user: { include: { telegramUser: true } }
          }
        }
      }
    });

    if (targets.length === 0) {
      logger.info('No daily targets for EOD snapshot');
      return;
    }

    for (const target of targets) {
      const portfolio = target.portfolio;
      if (!portfolio?.user?.telegramUser?.isActive || portfolio.user.telegramUser.isMuted) continue;
      if (portfolio.isPaused) continue; // Skip paused portfolios

      try {
        // Final price fetch
        const sortedHoldings = [...(portfolio.holdings || [])]
          .sort((a, b) => (b.quantity * parseFloat(b.avgPrice)) - (a.quantity * parseFloat(a.avgPrice)))
          .slice(0, 8);

        let finalPL = 0;
        const holdingResults = [];

        for (const h of sortedHoldings) {
          try {
            const priceData = await getCurrentPrice(h.symbol, h.exchange || 'NSE');
            if (priceData?.price) {
              const storedPrice = parseFloat(h.currentPrice || h.avgPrice);
              const pl = (priceData.price - storedPrice) * h.quantity;
              finalPL += pl;
              holdingResults.push({
                symbol: h.symbol,
                pl,
                pctMove: storedPrice > 0 ? ((priceData.price - storedPrice) / storedPrice * 100) : 0
              });
            }
            await new Promise(r => setTimeout(r, 12000));
          } catch (e) {
            logger.warn(`EOD price fetch failed for ${h.symbol}:`, e.message);
          }
        }

        // Update final earned amount
        await prisma.dailyTarget.update({
          where: { id: target.id },
          data: { earnedActual: finalPL, earnedUpdatedAt: new Date() }
        });

        const effectiveTarget = parseFloat(target.userTarget || target.aiTarget || 0);
        const gap = effectiveTarget - finalPL;
        const chatId = parseInt(portfolio.user.telegramUser.telegramId);
        const pName = portfolioLabel(portfolio);
        const recalibrations = target.recalibrationCount || 0;

        holdingResults.sort((a, b) => b.pl - a.pl);
        const winners = holdingResults.filter(h => h.pl > 0);
        const losers = holdingResults.filter(h => h.pl < 0);

        const winnersText = winners.length > 0
          ? winners.map(h => `✅ ${h.symbol}: +₹${h.pl.toFixed(0)} (${h.pctMove >= 0 ? '+' : ''}${h.pctMove.toFixed(1)}%)`).join('\n')
          : 'No winners today';
        const losersText = losers.length > 0
          ? losers.map(h => `❌ ${h.symbol}: ₹${h.pl.toFixed(0)} (${h.pctMove.toFixed(1)}%)`).join('\n')
          : 'No losers today';

        // Compare against war room plan
        let planComparison = '';
        const plan = target.warRoomPlan ? (typeof target.warRoomPlan === 'string' ? JSON.parse(target.warRoomPlan) : target.warRoomPlan) : null;
        if (plan?.holdings) {
          const planLines = [];
          for (const ph of plan.holdings) {
            const actual = holdingResults.find(h => h.symbol === ph.symbol);
            if (actual) {
              const targetPL = (plan.dailyTarget?.breakdown || []).find(b => b.symbol === ph.symbol)?.expectedContribution;
              if (targetPL) {
                planLines.push(`${ph.symbol}: Expected ₹${targetPL.toFixed(0)} → Actual ${actual.pl >= 0 ? '+' : ''}₹${actual.pl.toFixed(0)}`);
              }
            }
          }
          if (planLines.length > 0) {
            planComparison = '\n*Plan vs Actual:*\n' + planLines.join('\n');
          }
        }

        const achievedEmoji = gap <= 0 ? '🏆' : '📉';
        const achievedText = gap <= 0
          ? `TARGET ACHIEVED${Math.abs(gap) > 0 ? ` (+₹${Math.abs(gap).toFixed(0)} surplus)` : ''}`
          : `MISSED by ₹${gap.toFixed(0)}`;

        const msg = `${achievedEmoji} *END OF DAY*
━━━━━━━━━━━━━━━━━━━
📁 *${pName}*

🎯 Target: ₹${effectiveTarget.toFixed(0)} | Actual: ${finalPL >= 0 ? '+' : ''}₹${finalPL.toFixed(0)}
*${achievedText}*

*Winners:*
${winnersText}

*Losers:*
${losersText}
${planComparison}

Recalibrations today: ${recalibrations}
${gap <= 0 ? 'I delivered today. Tomorrow\'s war room will build on this momentum.' : `I own this miss. The ₹${gap.toFixed(0)} deficit carries into tomorrow's recovery plan.`}
━━━━━━━━━━━━━━━━━━━`;

        await sendTelegramMessage(chatId, msg, { parse_mode: 'Markdown' });
        logger.info(`EOD snapshot sent for portfolio ${portfolio.id}: ${gap <= 0 ? 'TARGET MET' : `missed by ₹${gap.toFixed(0)}`}`);
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.error(`EOD snapshot failed for portfolio ${portfolio.id}:`, err.message);
      }
    }

    logger.info(`End-of-Day Snapshot complete (${targets.length} targets)`);
  } catch (error) {
    logger.error('End-of-Day Snapshot error:', error);
  }
}

// ============================================
// EVENING PLAYBOOK (7:30 PM) — 1 AI call per portfolio
// Replaces both evening review (6 PM) and game plan (9 PM)
// ============================================

async function runEveningPlaybook() {
  if (!isTradingDay(new Date())) {
    const holiday = isMarketHoliday(new Date());
    logger.info(`Market holiday${holiday.name ? ' (' + holiday.name + ')' : ''} — skipping evening playbook`);
    return;
  }

  try {
    logger.info('Running Evening Playbook...');

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false
      },
      include: { user: true }
    });

    for (const telegramUser of users) {
      try {
        const portfolios = await getUserPortfolios(telegramUser.user.id);
        if (portfolios.length === 0) continue;

        const chatId = parseInt(telegramUser.telegramId);
        const sections = [];

        for (const portfolio of portfolios) {
          try {
            const playbook = await generateEveningPlaybook(portfolio.id);

            const review = playbook.todayReview || {};
            const verdicts = (playbook.holdingVerdicts || []).map(v =>
              `${v.verdict} ${v.symbol} — ${v.reason}`
            ).join('\n');

            const plays = (playbook.tomorrowPlays || []).map(p =>
              `${p.action} ${p.quantity}x ${p.symbol} @ ₹${p.price} (${p.orderType}) — ${p.rationale}`
            ).join('\n');

            const section = `📁 *${portfolioLabel(portfolio)}*

TODAY'S GRADE: *${review.grade || '?'}*
${review.whatWorked ? `✅ ${review.whatWorked}` : ''}
${review.whatFailed ? `❌ ${review.whatFailed}` : ''}
${review.accountability || ''}

${verdicts ? `HOLDING VERDICTS:\n${verdicts}` : ''}

${plays ? `TOMORROW'S ORDERS:\n${plays}` : ''}

🌍 MACRO: ${playbook.macroThesis || 'N/A'}
📈 WEEKLY: ${playbook.weeklyProgress || 'N/A'}`;

            sections.push(section);

            await saveAnalysis(telegramUser.user.id, 'EVENING_PLAYBOOK', JSON.stringify(playbook), { time: 'evening', portfolioId: portfolio.id });
          } catch (playbookErr) {
            logger.error(`Evening playbook failed for portfolio ${portfolio.id}:`, playbookErr.message);
            sections.push(`📁 *${portfolioLabel(portfolio)}*\n⚠️ Playbook generation failed.`);
          }
        }

        const eveningMsg = `🌙 *EVENING PLAYBOOK*
━━━━━━━━━━━━━━━━━━━

${sections.join('\n\n━━━━━━━━━━━━━━━━━━━\n\n')}

━━━━━━━━━━━━━━━━━━━
Tomorrow's plan is locked. Execute at open.`;

        await sendTelegramMessage(chatId, eveningMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info(`Evening Playbook sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`Evening Playbook failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`Evening Playbook complete for ${users.length} users`);
  } catch (error) {
    logger.error('Evening Playbook error:', error);
  }
}

// ============================================
// CRON JOB SETUP
// ============================================

export function initTelegramAlerts() {
  logger.info('Initializing Telegram War Room Alert System...');

  // Morning War Room at 9:00 AM (1 AI call per portfolio)
  cron.schedule('0 9 * * 1-5', async () => {
    await runMorningWarRoom();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Hourly Smart Pulse: 10AM, 11AM, 12PM, 1PM, 2PM, 3PM (0 AI calls unless deviation)
  cron.schedule('0 10,11,12,13,14,15 * * 1-5', async () => {
    await runHourlySmartPulse();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // End-of-Day Snapshot at 3:35 PM (0 AI calls)
  cron.schedule('35 15 * * 1-5', async () => {
    await runEndOfDaySnapshot();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Evening Playbook at 7:30 PM (1 AI call per portfolio)
  cron.schedule('30 19 * * 1-5', async () => {
    await runEveningPlaybook();
  }, {
    timezone: 'Asia/Kolkata'
  });

  logger.info('Telegram War Room Alert System initialized');
  logger.info('Schedule:');
  logger.info('  9:00 AM  - Morning War Room (1 AI call/portfolio)');
  logger.info('  10-3 PM  - Hourly Smart Pulse (0 AI calls, deviation → recalibration max 2)');
  logger.info('  3:35 PM  - End-of-Day Snapshot (0 AI calls)');
  logger.info('  7:30 PM  - Evening Playbook (1 AI call/portfolio)');
  logger.info('  Skips NSE market holidays automatically');
}

export default {
  runMorningWarRoom,
  runHourlySmartPulse,
  runEndOfDaySnapshot,
  runEveningPlaybook,
  initTelegramAlerts
};

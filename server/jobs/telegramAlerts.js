import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { getCurrentPrice } from '../services/marketData.js';
import { scanMarketForOpportunities, buildProfileBrief } from '../services/advancedScreener.js';
import { sendAlert, broadcastMessage } from '../services/telegramBot.js';
import bot from '../services/telegramBot.js';
import logger from '../services/logger.js';
import { isTradingDay, isMarketHoliday } from '../utils/marketHolidays.js';

const prisma = new PrismaClient();

// Initialize Claude
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Telegram Alert System with Per-Portfolio AI Analyses
 * Schedule: 3 times daily with deep insights, skips market holidays
 */

// ============================================
// HELPER: Get User Portfolios with Holdings
// ============================================

async function getUserPortfolios(userId) {
  return prisma.portfolio.findMany({
    where: { userId, isActive: true },
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
// HELPER: Get AI Analysis
// ============================================

async function getAIAnalysis(prompt, maxTokens = 1500) {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });

    return message.content[0].text;
  } catch (error) {
    logger.error('Claude API error:', error.message);
    return 'AI analysis unavailable. Please try again later.';
  }
}

// ============================================
// HELPER: Save Analysis to Database
// ============================================

async function saveAnalysis(userId, category, analysis, metadata = {}) {
  try {
    await prisma.aiAnalysis.create({
      data: {
        userId,
        category,
        analysis,
        confidence: 0.85,
        metadata
      }
    });
    logger.info(`Saved analysis: ${category} for user ${userId}`);
  } catch (error) {
    logger.error(`Failed to save analysis ${category}:`, error.message);
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
// MORNING DEEP DIVE (9:00 AM)
// Per-portfolio: Market Analysis + Diversification + Risk Management
// ============================================

async function sendMorningDeepDive() {
  if (!isTradingDay(new Date())) {
    const holiday = isMarketHoliday(new Date());
    logger.info(`Market holiday${holiday.name ? ' (' + holiday.name + ')' : ''} — skipping morning alerts`);
    return;
  }

  try {
    logger.info('Generating Morning Deep Dive...');

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false,
        preferences: { path: ['dailyDigest'], equals: true }
      },
      include: { user: true }
    });

    // Shared market overview (1 API call for all users)
    const marketOverview = await getAIAnalysis(
      `Give a brief Indian stock market overview for today:
1. Nifty/Sensex trend and key levels
2. Strong/weak sectors
3. ONE key thing investors should watch today

Under 120 words. Be specific with numbers.`, 500
    );

    for (const telegramUser of users) {
      try {
        const portfolios = await getUserPortfolios(telegramUser.user.id);
        if (portfolios.length === 0) continue;

        const chatId = parseInt(telegramUser.telegramId);
        const sections = [];

        for (const portfolio of portfolios) {
          const profileBrief = buildProfileBrief(portfolio);
          const { totalValue, totalPL, totalPLPercent } = getPortfolioValueSummary(portfolio);
          const holdingsText = (portfolio.holdings || [])
            .map(h => `${h.symbol}: ${h.quantity} @ ${parseFloat(h.avgPrice).toFixed(0)} (${((h.quantity * parseFloat(h.currentPrice || h.avgPrice) - h.quantity * parseFloat(h.avgPrice)) / (h.quantity * parseFloat(h.avgPrice)) * 100).toFixed(1)}%)`)
            .join(', ');

          // Per-portfolio analysis (diversification + risk, profile-aware)
          const analysisPrompt = `${profileBrief}

Based on this investor profile and the market today, provide:

1. DIVERSIFICATION CHECK: Am I too concentrated? Name 2 stocks to add for this risk profile.
2. RISK MANAGEMENT: Stop-loss levels for top holdings, highest-risk stock, ONE protective action.

Keep it practical, specific with numbers. Under 250 words.`;

          const analysis = await getAIAnalysis(analysisPrompt, 800);
          await saveAnalysis(telegramUser.user.id, 'MORNING_ANALYSIS', analysis, { time: 'morning', portfolioId: portfolio.id });

          const header = portfolios.length > 1 ? `\n📁 *${portfolioLabel(portfolio)}*\n` : '';
          const snapshot = `Value: ${formatINR(totalValue)} | P&L: ${totalPL >= 0 ? '📈' : '📉'} ${formatINR(Math.abs(totalPL))} (${totalPLPercent.toFixed(1)}%)`;

          sections.push(`${header}${snapshot}\n\n${analysis}`);
        }

        const morningMsg = `☀️ *MORNING DEEP DIVE*
━━━━━━━━━━━━━━━━━━━

*🎯 MARKET OVERVIEW*

${marketOverview}

━━━━━━━━━━━━━━━━━━━
*📊 PORTFOLIO ANALYSIS*

${sections.join('\n\n━━━━━━━━━━━━━━━━━━━\n\n')}

━━━━━━━━━━━━━━━━━━━
Have a profitable day! 💰`;

        await bot.sendMessage(chatId, morningMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info(`Morning Deep Dive sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`Morning digest failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`Morning Deep Dive sent to ${users.length} users`);
  } catch (error) {
    logger.error('Morning Deep Dive error:', error);
  }
}

// ============================================
// EVENING PORTFOLIO REVIEW (6:00 PM)
// Per-portfolio: Technical + Economic + Value + Sentiment
// ============================================

async function sendEveningReview() {
  if (!isTradingDay(new Date())) {
    const holiday = isMarketHoliday(new Date());
    logger.info(`Market holiday${holiday.name ? ' (' + holiday.name + ')' : ''} — skipping evening alerts`);
    return;
  }

  try {
    logger.info('Generating Evening Portfolio Review...');

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false,
        preferences: { path: ['eveningSummary'], equals: true }
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
          const profileBrief = buildProfileBrief(portfolio);
          const { totalValue, totalPL, totalPLPercent } = getPortfolioValueSummary(portfolio);
          const top3 = (portfolio.holdings || []).slice(0, 3);
          const top3Text = top3.map(h => `${h.symbol} (${h.quantity} @ ${parseFloat(h.currentPrice || h.avgPrice).toFixed(0)})`).join(', ');

          const analysisPrompt = `${profileBrief}

Evening review for this portfolio. Top holdings: ${top3Text}.

Provide:
1. TECHNICAL: Price action today (bullish/bearish), key support/resistance for tomorrow, buy/hold/sell for each.
2. VALUE CHECK: Undervalued/overvalued for each? Fair value estimate.
3. SENTIMENT: Bullish/bearish sentiment, recent news, institutional activity.

Be specific with price levels. Under 300 words.`;

          const analysis = await getAIAnalysis(analysisPrompt, 1000);
          await saveAnalysis(telegramUser.user.id, 'EVENING_REVIEW', analysis, { time: 'evening', portfolioId: portfolio.id });

          const header = portfolios.length > 1 ? `\n📁 *${portfolioLabel(portfolio)}*\n` : '';
          const snapshot = `Value: ${formatINR(totalValue)} | P&L: ${totalPL >= 0 ? '📈' : '📉'} ${formatINR(Math.abs(totalPL))} (${totalPLPercent.toFixed(1)}%)`;

          sections.push(`${header}${snapshot}\n\n${analysis}`);
        }

        const eveningMsg = `🌙 *EVENING PORTFOLIO REVIEW*
━━━━━━━━━━━━━━━━━━━

${sections.join('\n\n━━━━━━━━━━━━━━━━━━━\n\n')}

━━━━━━━━━━━━━━━━━━━
Rest well! 😴`;

        await bot.sendMessage(chatId, eveningMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info(`Evening Review sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`Evening review failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`Evening Review sent to ${users.length} users`);
  } catch (error) {
    logger.error('Evening Review error:', error);
  }
}

// ============================================
// TOMORROW'S GAME PLAN (9:00 PM)
// Per-portfolio: Earnings + Strategy + Global + Personalized Watchlist
// ============================================

async function sendTomorrowGamePlan() {
  if (!isTradingDay(new Date())) {
    const holiday = isMarketHoliday(new Date());
    logger.info(`Market holiday${holiday.name ? ' (' + holiday.name + ')' : ''} — skipping game plan alerts`);
    return;
  }

  try {
    logger.info('Generating Tomorrow\'s Game Plan...');

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false
      },
      include: { user: true }
    });

    // Shared global overview
    const globalOverview = await getAIAnalysis(
      `Brief global events check for Indian market investors:
1. Major global news affecting markets
2. US Fed, oil prices, geopolitical impact
3. ONE key global trend for tomorrow

Under 100 words.`, 400
    );

    for (const telegramUser of users) {
      try {
        const portfolios = await getUserPortfolios(telegramUser.user.id);
        if (portfolios.length === 0) continue;

        const chatId = parseInt(telegramUser.telegramId);
        const sections = [];

        for (const portfolio of portfolios) {
          const profileBrief = buildProfileBrief(portfolio);
          const holdingSymbols = (portfolio.holdings || []).map(h => h.symbol).join(', ');

          // Per-portfolio strategy analysis
          const strategyPrompt = `${profileBrief}

Tomorrow's game plan for this portfolio. Holdings: ${holdingSymbols || 'None yet'}.

1. EARNINGS WATCH: Any upcoming earnings for these stocks? Hold or book profit?
2. STRATEGY: Too heavy on growth or dividend? Should strategy shift given risk profile?
3. ONE specific action for tomorrow.

Under 200 words.`;

          const strategyAnalysis = await getAIAnalysis(strategyPrompt, 700);
          await saveAnalysis(telegramUser.user.id, 'GAME_PLAN', strategyAnalysis, { time: 'night', portfolioId: portfolio.id });

          // Per-portfolio watchlist scan (personalized to risk profile)
          let watchlistText = '';
          try {
            const opportunities = await scanMarketForOpportunities({
              portfolio,
              targetCount: { high: 2, medium: 2, low: 2 },
              baseAmount: parseFloat(portfolio.availableCash || 10000)
            });
            const topPicks = [...(opportunities.high || []), ...(opportunities.medium || []), ...(opportunities.low || [])].slice(0, 3);
            if (topPicks.length > 0) {
              watchlistText = '\n\n*Watchlist:*\n' + topPicks.map(s => `• ${s.symbol} - ₹${s.price?.toFixed(0) || '?'} (${s.riskCategory})`).join('\n');
            }
          } catch (e) {
            logger.error(`Watchlist scan failed for portfolio ${portfolio.id}:`, e.message);
          }

          const header = portfolios.length > 1 ? `\n📁 *${portfolioLabel(portfolio)}*\n` : '';
          sections.push(`${header}${strategyAnalysis}${watchlistText}`);
        }

        const gameplanMsg = `🎯 *TOMORROW'S GAME PLAN*
━━━━━━━━━━━━━━━━━━━

*🌍 GLOBAL OVERVIEW*

${globalOverview}

━━━━━━━━━━━━━━━━━━━
*📊 PORTFOLIO STRATEGIES*

${sections.join('\n\n━━━━━━━━━━━━━━━━━━━\n\n')}

━━━━━━━━━━━━━━━━━━━
Sweet dreams! Tomorrow's another opportunity 🚀`;

        await bot.sendMessage(chatId, gameplanMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info(`Tomorrow's Game Plan sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`Game plan failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`Tomorrow's Game Plan sent to ${users.length} users`);
  } catch (error) {
    logger.error(`Tomorrow's Game Plan error:`, error);
  }
}

// ============================================
// PRICE MONITORING (during market hours)
// ============================================

async function checkPriceAlerts() {
  if (!isTradingDay(new Date())) {
    logger.info('Market holiday — skipping price alerts');
    return;
  }

  try {
    const holdings = await prisma.holding.findMany({
      include: {
        portfolio: {
          include: {
            user: {
              include: { telegramUser: true }
            }
          }
        }
      }
    });

    for (const holding of holdings) {
      if (!holding.portfolio?.user?.telegramUser) continue;

      try {
        const currentPrice = await getCurrentPrice(holding.symbol, holding.exchange);

        await prisma.holding.update({
          where: { id: holding.id },
          data: { currentPrice: currentPrice.price }
        });

        // Target hit
        if (holding.targetPrice && currentPrice.price >= holding.targetPrice * 0.98) {
          const alertMsg = `🎯 *TARGET ALERT*

*${holding.symbol}* hit target!
Current: ₹${currentPrice.price.toFixed(2)}
Target: ₹${holding.targetPrice}

Consider booking profit! 💰`;

          const chatId = parseInt(holding.portfolio.user.telegramUser.telegramId);
          await bot.sendMessage(chatId, alertMsg, { parse_mode: 'Markdown' });
        }

        // Stop loss
        if (holding.stopLoss && currentPrice.price <= holding.stopLoss) {
          const alertMsg = `🛑 *STOP LOSS TRIGGERED*

*${holding.symbol}* hit stop loss!
Current: ₹${currentPrice.price.toFixed(2)}
Stop Loss: ₹${holding.stopLoss}

Exit now to limit losses! ⚠️`;

          const chatId = parseInt(holding.portfolio.user.telegramUser.telegramId);
          await bot.sendMessage(chatId, alertMsg, { parse_mode: 'Markdown' });
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error(`Price check failed for ${holding.symbol}:`, error.message);
      }
    }

    logger.info('Price alerts check completed');
  } catch (error) {
    logger.error('Price monitoring error:', error);
  }
}

// ============================================
// HELPER: Format INR
// ============================================

function formatINR(amount) {
  return `₹${parseFloat(amount).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// ============================================
// CRON JOB SETUP
// ============================================

export function initTelegramAlerts() {
  logger.info('Initializing Telegram AI Alert System...');

  // Price alerts every few hours during market hours (9:00 AM - 3:30 PM IST, Mon-Fri)
  cron.schedule('0 9,11,13,15 * * 1-5', async () => {
    await checkPriceAlerts();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Morning Deep Dive at 9:00 AM (Mon-Fri, skips holidays)
  cron.schedule('0 9 * * 1-5', async () => {
    await sendMorningDeepDive();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Evening Portfolio Review at 6:00 PM (Mon-Fri, skips holidays)
  cron.schedule('0 18 * * 1-5', async () => {
    await sendEveningReview();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Tomorrow's Game Plan at 9:00 PM (Mon-Fri, skips holidays)
  cron.schedule('0 21 * * 1-5', async () => {
    await sendTomorrowGamePlan();
  }, {
    timezone: 'Asia/Kolkata'
  });

  logger.info('Telegram AI Alert System initialized');
  logger.info('Schedule:');
  logger.info('  9:00 AM - Morning Deep Dive (per-portfolio market + diversification + risk)');
  logger.info('  6:00 PM - Evening Review (per-portfolio technical + value + sentiment)');
  logger.info('  9:00 PM - Game Plan (per-portfolio strategy + personalized watchlist)');
  logger.info('  Skips NSE market holidays automatically');
}

export default {
  checkPriceAlerts,
  sendMorningDeepDive,
  sendEveningReview,
  sendTomorrowGamePlan,
  initTelegramAlerts
};

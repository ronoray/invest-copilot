import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { getCurrentPrice } from '../services/marketData.js';
import { scanMarketForOpportunities } from '../services/advancedScreener.js';
import { sendAlert, broadcastMessage } from '../services/telegramBot.js';
import bot from '../services/telegramBot.js';
import logger from '../services/logger.js';

const prisma = new PrismaClient();

// Initialize Claude
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Telegram Alert System with 10 Comprehensive AI Analyses
 * Schedule: Option B - 3 times daily with deep insights
 */

// ============================================
// HELPER: Get Portfolio Summary
// ============================================

async function getPortfolioSummary(userId) {
  const holdings = await prisma.holding.findMany({
    where: { userId }
  });

  let totalValue = 0;
  let totalInvested = 0;

  const summary = holdings.map(h => {
    const invested = h.quantity * h.avgPrice;
    const current = h.quantity * (h.currentPrice || h.avgPrice);
    const pl = current - invested;
    const plPercent = (pl / invested) * 100;

    totalValue += current;
    totalInvested += invested;

    return {
      symbol: h.symbol,
      quantity: h.quantity,
      avgPrice: h.avgPrice,
      currentPrice: h.currentPrice || h.avgPrice,
      pl: pl.toFixed(2),
      plPercent: plPercent.toFixed(2)
    };
  });

  const totalPL = totalValue - totalInvested;
  const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

  return {
    holdings: summary,
    totalValue,
    totalInvested,
    totalPL,
    totalPLPercent
  };
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
    logger.error('❌ Claude API error:', error.message);
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
    logger.info(`✅ Saved analysis: ${category} for user ${userId}`);
  } catch (error) {
    logger.error(`❌ Failed to save analysis ${category}:`, error.message);
  }
}

// ============================================
// MORNING DEEP DIVE (9:00 AM)
// Prompts 1-3: Market Analysis + Diversification + Risk Management
// ============================================

async function sendMorningDeepDive() {
  try {
    logger.info('☀️ Generating Morning Deep Dive...');

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
        const portfolio = await getPortfolioSummary(telegramUser.user.id);
        const portfolioText = portfolio.holdings
          .map(h => `${h.symbol}: ${h.quantity} @ ₹${h.avgPrice} (${h.plPercent}%)`)
          .join(', ');

        // PROMPT 1: Market Analysis
        const marketPrompt = `You're analyzing the Indian stock market for today. My portfolio: ${portfolioText}. 

Analyze:
1. Current Nifty/Sensex trends and what they mean
2. Key support/resistance levels TODAY
3. Sectoral performance and which sectors look strong/weak
4. Specific impact on MY holdings
5. ONE key action I should take today

Be conversational but specific. Use ₹ for prices. Keep it under 200 words.`;

        const marketAnalysis = await getAIAnalysis(marketPrompt, 800);
        await saveAnalysis(telegramUser.user.id, 'MARKET_ANALYSIS', marketAnalysis, { time: 'morning' });

        // PROMPT 2: Diversification Check
        const diversificationPrompt = `My portfolio: ${portfolioText}. 

Quick diversification check:
1. Am I too concentrated in any sector?
2. Name 2-3 specific stocks I should add to reduce risk
3. Why those stocks help diversification
4. Rough allocation (e.g., "add ₹5K to each")

Keep it practical and under 150 words.`;

        const diversificationAnalysis = await getAIAnalysis(diversificationPrompt, 600);
        await saveAnalysis(telegramUser.user.id, 'DIVERSIFICATION', diversificationAnalysis, { time: 'morning' });

        // PROMPT 3: Risk Management
        const riskPrompt = `My portfolio: ${portfolioText}.

Give me TODAY's risk management plan:
1. Stop-loss levels for top 3 holdings (specific ₹ levels)
2. Which stock is highest risk right now?
3. ONE action to reduce risk today
4. Emergency exit strategy if market crashes

Be specific with numbers. Under 150 words.`;

        const riskAnalysis = await getAIAnalysis(riskPrompt, 600);
        await saveAnalysis(telegramUser.user.id, 'RISK_MANAGEMENT', riskAnalysis, { time: 'morning' });

        // Combine and send
        const morningMsg = `☀️ *MORNING DEEP DIVE*
━━━━━━━━━━━━━━━━━━━

*📊 Portfolio Snapshot:*
Value: ₹${portfolio.totalValue.toLocaleString('en-IN')}
P&L: ${portfolio.totalPL >= 0 ? '📈' : '📉'} ₹${Math.abs(portfolio.totalPL).toLocaleString('en-IN')} (${portfolio.totalPLPercent.toFixed(2)}%)

━━━━━━━━━━━━━━━━━━━
*🎯 MARKET ANALYSIS*

${marketAnalysis}

━━━━━━━━━━━━━━━━━━━
*🔄 DIVERSIFICATION CHECK*

${diversificationAnalysis}

━━━━━━━━━━━━━━━━━━━
*🛡️ RISK MANAGEMENT*

${riskAnalysis}

━━━━━━━━━━━━━━━━━━━
Have a profitable day! 💰`;

        const chatId = parseInt(telegramUser.telegramId);
        await bot.sendMessage(chatId, morningMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500)); // Rate limiting

        logger.info(`✅ Morning Deep Dive sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`❌ Morning digest failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`✅ Morning Deep Dive sent to ${users.length} users`);
  } catch (error) {
    logger.error('❌ Morning Deep Dive error:', error);
  }
}

// ============================================
// EVENING PORTFOLIO REVIEW (6:00 PM)
// Prompts 4-7: Technical + Economic + Value + Sentiment
// ============================================

async function sendEveningReview() {
  try {
    logger.info('🌙 Generating Evening Portfolio Review...');

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
        const portfolio = await getPortfolioSummary(telegramUser.user.id);
        const top3Holdings = portfolio.holdings.slice(0, 3);
        const top3Text = top3Holdings
          .map(h => `${h.symbol} (${h.quantity} @ ₹${h.currentPrice})`)
          .join(', ');

        // PROMPT 4: Technical Analysis
        const technicalPrompt = `Technical check for my top holdings: ${top3Text}.

For each stock:
1. Today's price action (bullish/bearish/sideways)
2. Key support/resistance for tomorrow
3. Buy/Hold/Sell recommendation
4. ONE technical signal I should watch tomorrow

Be specific with ₹ levels. Under 200 words.`;

        const technicalAnalysis = await getAIAnalysis(technicalPrompt, 800);
        await saveAnalysis(telegramUser.user.id, 'TECHNICAL_ANALYSIS', technicalAnalysis, { time: 'evening' });

        // PROMPT 5: Economic Indicators
        const economicPrompt = `How are current economic factors affecting my portfolio: ${top3Text}?

Quick check:
1. RBI policy impact on my sectors
2. Inflation effect on my stocks
3. Any economic news I should worry about
4. ONE economic trend to watch this week

Keep it practical, under 150 words.`;

        const economicAnalysis = await getAIAnalysis(economicPrompt, 600);
        await saveAnalysis(telegramUser.user.id, 'ECONOMIC_INDICATORS', economicAnalysis, { time: 'evening' });

        // PROMPT 6: Value Check
        const valuePrompt = `Value check on my top 3: ${top3Text}.

For each:
1. Currently undervalued/fairly valued/overvalued?
2. Fair value estimate (₹)
3. Should I buy more, hold, or book profit?

Be direct. Under 150 words.`;

        const valueAnalysis = await getAIAnalysis(valuePrompt, 600);
        await saveAnalysis(telegramUser.user.id, 'VALUE_INVESTING', valueAnalysis, { time: 'evening' });

        // PROMPT 7: Market Sentiment
        const sentimentPrompt = `What's the sentiment around my holdings: ${top3Text}?

Quick sentiment check:
1. Bullish/Bearish sentiment for each
2. Any recent news affecting them
3. Institutional buying/selling activity
4. Overall sentiment score (1-10)

Under 150 words.`;

        const sentimentAnalysis = await getAIAnalysis(sentimentPrompt, 600);
        await saveAnalysis(telegramUser.user.id, 'MARKET_SENTIMENT', sentimentAnalysis, { time: 'evening' });

        // Combine and send
        const eveningMsg = `🌙 *EVENING PORTFOLIO REVIEW*
━━━━━━━━━━━━━━━━━━━

*📊 Today's Performance:*
Portfolio: ₹${portfolio.totalValue.toLocaleString('en-IN')}
Day's P&L: ${portfolio.totalPL >= 0 ? '📈' : '📉'} ₹${Math.abs(portfolio.totalPL).toLocaleString('en-IN')} (${portfolio.totalPLPercent.toFixed(2)}%)

━━━━━━━━━━━━━━━━━━━
*📈 TECHNICAL ANALYSIS*

${technicalAnalysis}

━━━━━━━━━━━━━━━━━━━
*💹 ECONOMIC IMPACT*

${economicAnalysis}

━━━━━━━━━━━━━━━━━━━
*💎 VALUE CHECK*

${valueAnalysis}

━━━━━━━━━━━━━━━━━━━
*📊 MARKET SENTIMENT*

${sentimentAnalysis}

━━━━━━━━━━━━━━━━━━━
Rest well! 😴`;

        const chatId = parseInt(telegramUser.telegramId);
        await bot.sendMessage(chatId, eveningMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info(`✅ Evening Review sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`❌ Evening review failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`✅ Evening Review sent to ${users.length} users`);
  } catch (error) {
    logger.error('❌ Evening Review error:', error);
  }
}

// ============================================
// TOMORROW'S GAME PLAN (9:00 PM)
// Prompts 8-10: Earnings + Growth/Dividend + Global Events
// ============================================

async function sendTomorrowGamePlan() {
  try {
    logger.info('🎯 Generating Tomorrow\'s Game Plan...');

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false
      },
      include: { user: true }
    });

    for (const telegramUser of users) {
      try {
        const portfolio = await getPortfolioSummary(telegramUser.user.id);
        const portfolioText = portfolio.holdings
          .map(h => `${h.symbol}`)
          .join(', ');

        // PROMPT 8: Earnings Check
        const earningsPrompt = `Any upcoming earnings for my holdings: ${portfolioText}?

Check:
1. Which stocks have earnings this week/month
2. What to expect (beat/miss estimates)
3. How it might affect stock price
4. Should I hold through earnings or book profit?

Be specific. Under 150 words.`;

        const earningsAnalysis = await getAIAnalysis(earningsPrompt, 600);
        await saveAnalysis(telegramUser.user.id, 'EARNINGS_REPORTS', earningsAnalysis, { time: 'night' });

        // PROMPT 9: Growth vs Dividend Strategy
        const strategyPrompt = `My portfolio: ${portfolioText}.

Strategy check:
1. Am I too heavy on growth or dividend stocks?
2. Given current market, should I shift strategy?
3. Name 1-2 dividend stocks OR 1-2 growth stocks to add
4. Why this mix is better now

Keep it actionable. Under 150 words.`;

        const strategyAnalysis = await getAIAnalysis(strategyPrompt, 600);
        await saveAnalysis(telegramUser.user.id, 'GROWTH_VS_DIVIDEND', strategyAnalysis, { time: 'night' });

        // PROMPT 10: Global Events Impact
        const globalPrompt = `How are global events affecting my portfolio: ${portfolioText}?

Check:
1. Any major global news affecting Indian markets
2. US Fed impact, geopolitical tensions, oil prices
3. How it affects MY specific stocks
4. ONE hedge or protection strategy for tomorrow

Be specific. Under 150 words.`;

        const globalAnalysis = await getAIAnalysis(globalPrompt, 600);
        await saveAnalysis(telegramUser.user.id, 'GLOBAL_EVENTS', globalAnalysis, { time: 'night' });

        // Get tomorrow's opportunities
        const opportunities = await scanMarketForOpportunities({
          targetCount: { high: 2, medium: 2, low: 2 },
          baseAmount: 10000
        });

        const topPicks = [...opportunities.high, ...opportunities.medium, ...opportunities.low].slice(0, 3);

        // Combine and send
        const gameplanMsg = `🎯 *TOMORROW'S GAME PLAN*
━━━━━━━━━━━━━━━━━━━

*📅 EARNINGS WATCH*

${earningsAnalysis}

━━━━━━━━━━━━━━━━━━━
*⚖️ STRATEGY CHECK*

${strategyAnalysis}

━━━━━━━━━━━━━━━━━━━
*🌍 GLOBAL IMPACT*

${globalAnalysis}

━━━━━━━━━━━━━━━━━━━
*🔍 TOMORROW'S WATCHLIST*

${topPicks.map(s => `• ${s.symbol} - ₹${s.price.toFixed(0)} (${s.riskCategory})`).join('\n')}

━━━━━━━━━━━━━━━━━━━
Sweet dreams! Tomorrow's another opportunity 🚀`;

        const chatId = parseInt(telegramUser.telegramId);
        await bot.sendMessage(chatId, gameplanMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 500));

        logger.info(`✅ Tomorrow's Game Plan sent to ${telegramUser.telegramId}`);
      } catch (error) {
        logger.error(`❌ Game plan failed for ${telegramUser.telegramId}:`, error);
      }
    }

    logger.info(`✅ Tomorrow's Game Plan sent to ${users.length} users`);
  } catch (error) {
    logger.error(`❌ Tomorrow's Game Plan error:`, error);
  }
}

// ============================================
// PRICE MONITORING (every 5 min during market hours)
// ============================================

async function checkPriceAlerts() {
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

          const chatId = parseInt(holding.user.telegramUser.telegramId);
          await bot.sendMessage(chatId, alertMsg, { parse_mode: 'Markdown' });
        }

        // Stop loss
        if (holding.stopLoss && currentPrice.price <= holding.stopLoss) {
          const alertMsg = `🛑 *STOP LOSS TRIGGERED*

*${holding.symbol}* hit stop loss!
Current: ₹${currentPrice.price.toFixed(2)}
Stop Loss: ₹${holding.stopLoss}

Exit now to limit losses! ⚠️`;

          const chatId = parseInt(holding.user.telegramUser.telegramId);
          await bot.sendMessage(chatId, alertMsg, { parse_mode: 'Markdown' });
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error(`❌ Price check failed for ${holding.symbol}:`, error.message);
      }
    }

    logger.info('✅ Price alerts check completed');
  } catch (error) {
    logger.error('❌ Price monitoring error:', error);
  }
}

// ============================================
// CRON JOB SETUP - OPTION B
// ============================================

export function initTelegramAlerts() {
  logger.info('🚀 Initializing Telegram AI Alert System (Option B)...');

  // Price alerts every 5 minutes during market hours (9:00 AM - 3:30 PM IST)
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    await checkPriceAlerts();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Morning Deep Dive at 9:00 AM (Mon-Fri)
  cron.schedule('0 9 * * 1-5', async () => {
    await sendMorningDeepDive();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Evening Portfolio Review at 6:00 PM (Mon-Fri)
  cron.schedule('0 18 * * 1-5', async () => {
    await sendEveningReview();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Tomorrow's Game Plan at 9:00 PM (Mon-Fri)
  cron.schedule('0 21 * * 1-5', async () => {
    await sendTomorrowGamePlan();
  }, {
    timezone: 'Asia/Kolkata'
  });

  logger.info('✅ Telegram AI Alert System initialized');
  logger.info('📅 Schedule:');
  logger.info('  ☀️  9:00 AM - Morning Deep Dive (Market + Diversification + Risk)');
  logger.info('  🌙 6:00 PM - Evening Review (Technical + Economic + Value + Sentiment)');
  logger.info('  🎯 9:00 PM - Tomorrow\'s Game Plan (Earnings + Strategy + Global)');
}

export default {
  checkPriceAlerts,
  sendMorningDeepDive,
  sendEveningReview,
  sendTomorrowGamePlan,
  initTelegramAlerts
};
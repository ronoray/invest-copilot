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
 * Telegram Alert System with Claude AI
 */

// ============================================
// PRICE MONITORING
// ============================================

async function checkPriceAlerts() {
  try {
    const holdings = await prisma.holding.findMany({
      include: { user: { include: { telegramUser: true } } }
    });

    for (const holding of holdings) {
      if (!holding.user?.telegramUser) continue;

      try {
        const currentPrice = await getCurrentPrice(holding.symbol, holding.exchange);
        
        await prisma.holding.update({
          where: { id: holding.id },
          data: { currentPrice: currentPrice.price }
        });

        // Target hit
        if (holding.targetPrice && currentPrice.price >= holding.targetPrice * 0.98) {
          await sendAlert(holding.user.telegramUser.id, 'SELL_SIGNAL', {
            holding,
            currentPrice: currentPrice.price,
            reason: 'Target price reached! 🎯'
          });
        }

        // Stop loss
        if (holding.stopLoss && currentPrice.price <= holding.stopLoss) {
          await sendAlert(holding.user.telegramUser.id, 'SELL_SIGNAL', {
            holding,
            currentPrice: currentPrice.price,
            reason: 'Stop loss triggered! 🛑 Exit now to limit losses.'
          });
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
// AI-POWERED MORNING DIGEST
// ============================================

async function sendMorningDigest() {
  try {
    logger.info('📨 Sending AI-powered morning digest...');

    const opportunities = await scanMarketForOpportunities({
      targetCount: { high: 3, medium: 3, low: 3 },
      baseAmount: 10000
    });

    const allStocks = [...opportunities.high, ...opportunities.medium, ...opportunities.low];
    const topPicks = allStocks.slice(0, 3);

    // Get Claude AI insights
    let aiInsight = 'Market is open! Review opportunities and make informed decisions.';
    let actionItem = 'Check top picks and consider adding to portfolio.';
    
    try {
      const prompt = `You're a friendly investment advisor. Give a brief morning market insight for these stocks: ${topPicks.map(s => `${s.symbol} (₹${s.price})`).join(', ')}.

Return ONLY JSON:
{
  "insight": "1-2 friendly sentences about market opportunities today",
  "actionItem": "One specific action to take today"
}`;
      
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      });
      
      const responseText = message.content[0].text;
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const ai = JSON.parse(jsonMatch[0]);
        aiInsight = ai.insight;
        actionItem = ai.actionItem;
        logger.info('✅ Claude AI morning insight generated');
      }
    } catch (aiError) {
      logger.warn('Claude AI unavailable, using fallback:', aiError.message);
    }

    const digestMsg = `☀️ *GOOD MORNING!*
━━━━━━━━━━━━━━━━━━━

💡 *AI Insight:*
${aiInsight}

*Today's Top Picks:*
${topPicks.map((s, i) => `${i + 1}. *${s.symbol}* (${s.riskCategory}) - ₹${s.price.toFixed(0)}`).join('\n')}

Total: ${allStocks.length} opportunities
🔥 High: ${opportunities.high.length} | ⚡ Medium: ${opportunities.medium.length} | 🛡️ Low: ${opportunities.low.length}

*🎯 Action:* ${actionItem}

Use /scan for full list!`;

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false,
        preferences: { path: ['dailyDigest'], equals: true }
      }
    });

    for (const user of users) {
      try {
        const chatId = parseInt(user.telegramId);
        await bot.sendMessage(chatId, digestMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.error(`Morning digest failed for ${user.telegramId}:`, error);
      }
    }

    logger.info(`✅ AI morning digest sent to ${users.length} users`);
  } catch (error) {
    logger.error('Morning digest error:', error);
  }
}

// ============================================
// AI-POWERED EVENING SUMMARY
// ============================================

async function sendEveningSummary() {
  try {
    logger.info('📨 Sending AI-powered evening summary...');

    const holdings = await prisma.holding.findMany();
    
    let totalValue = 0;
    let totalInvested = 0;

    holdings.forEach(h => {
      totalValue += h.quantity * (h.currentPrice || h.avgPrice);
      totalInvested += h.quantity * h.avgPrice;
    });

    const dailyPL = totalValue - totalInvested;
    const dailyPLPercent = totalInvested > 0 ? (dailyPL / totalInvested) * 100 : 0;

    // Get tomorrow's opportunities
    const opportunities = await scanMarketForOpportunities({
      targetCount: { high: 2, medium: 2, low: 2 },
      baseAmount: 10000
    });

    const allStocks = [...opportunities.high, ...opportunities.medium, ...opportunities.low];

    // Get Claude AI insights
    let aiInsight = 'Market closed. Review your portfolio and plan for tomorrow.';
    let actionItems = ['Review watchlist', 'Set price alerts', 'Check news for holdings'];
    
    try {
      const prompt = `Evening market summary. Portfolio P&L: ${dailyPLPercent.toFixed(2)}%. Tomorrow's stocks: ${allStocks.slice(0, 3).map(s => s.symbol).join(', ')}.

Return ONLY JSON:
{
  "insight": "1-2 sentences summarizing the day",
  "actionItems": ["action 1", "action 2", "action 3"]
}`;
      
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      });
      
      const responseText = message.content[0].text;
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const ai = JSON.parse(jsonMatch[0]);
        aiInsight = ai.insight;
        actionItems = ai.actionItems;
        logger.info('✅ Claude AI evening insight generated');
      }
    } catch (aiError) {
      logger.warn('Claude AI unavailable, using fallback:', aiError.message);
    }

    const summaryMsg = `🌙 *MARKET CLOSED*
━━━━━━━━━━━━━━━━━━━

*Your Performance:*
Portfolio: ₹${totalValue.toLocaleString('en-IN')}
P&L: ${dailyPL >= 0 ? '📈' : '📉'} ₹${Math.abs(dailyPL).toLocaleString('en-IN')} (${dailyPLPercent.toFixed(2)}%)

💡 *AI Insight:*
${aiInsight}

*📋 Tomorrow's Action Items:*
${actionItems.map((item, i) => `${i + 1}. ${item}`).join('\n')}

*🔍 Tomorrow's Watchlist:*
${allStocks.slice(0, 3).map(s => `• ${s.symbol} - ₹${s.price.toFixed(0)}`).join('\n')}

Rest well! 😴`;

    const users = await prisma.telegramUser.findMany({
      where: {
        isActive: true,
        isMuted: false,
        preferences: { path: ['eveningSummary'], equals: true }
      }
    });

    for (const user of users) {
      try {
        const chatId = parseInt(user.telegramId);
        await bot.sendMessage(chatId, summaryMsg, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.error(`Evening summary failed for ${user.telegramId}:`, error);
      }
    }

    logger.info(`✅ AI evening summary sent to ${users.length} users`);
  } catch (error) {
    logger.error('Evening summary error:', error);
  }
}

// ============================================
// BUY SIGNAL SCANNER
// ============================================

async function scanForBuySignals() {
  try {
    logger.info('Scanning for buy signals...');

    const opportunities = await scanMarketForOpportunities({
      targetCount: { high: 2, medium: 2, low: 2 },
      baseAmount: 10000
    });

    const allStocks = [...opportunities.high, ...opportunities.medium, ...opportunities.low];

    const users = await prisma.telegramUser.findMany({
      where: { isActive: true, isMuted: false }
    });

    for (const user of users) {
      const prefs = user.preferences || {};
      
      for (const stock of allStocks) {
        if (
          (stock.riskCategory === 'high' && prefs.buySignalsHigh) ||
          (stock.riskCategory === 'medium' && prefs.buySignalsMedium) ||
          (stock.riskCategory === 'low' && prefs.buySignalsLow)
        ) {
          const recentAlert = await prisma.alertHistory.findFirst({
            where: {
              userId: user.id,
              symbol: stock.symbol,
              alertType: 'BUY_SIGNAL',
              createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
            }
          });

          if (!recentAlert) {
            await sendAlert(user.id, 'BUY_SIGNAL', stock);
            
            await prisma.alertHistory.create({
              data: {
                userId: user.id,
                symbol: stock.symbol,
                alertType: 'BUY_SIGNAL',
                price: stock.price
              }
            });

            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
    }

    logger.info('Buy signals scan completed');
  } catch (error) {
    logger.error('Buy signals error:', error);
  }
}

// ============================================
// CRON JOB SETUP
// ============================================

export function initTelegramAlerts() {
  logger.info('🚀 Initializing Telegram AI alert system...');

  // Price alerts every 5 minutes during market hours
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    await checkPriceAlerts();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Buy signals every hour
  cron.schedule('0 9-15 * * 1-5', async () => {
    await scanForBuySignals();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // AI morning digest at 9:00 AM
  cron.schedule('0 9 * * 1-5', async () => {
    await sendMorningDigest();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // AI evening summary at 6:00 PM
  cron.schedule('0 18 * * 1-5', async () => {
    await sendEveningSummary();
  }, {
    timezone: 'Asia/Kolkata'
  });

  logger.info('✅ Telegram AI alert cron jobs initialized');
  logger.info('📅 Morning digest: 9:00 AM IST (Mon-Fri)');
  logger.info('📅 Evening summary: 6:00 PM IST (Mon-Fri)');
}

export default {
  checkPriceAlerts,
  scanForBuySignals,
  sendMorningDigest,
  sendEveningSummary,
  initTelegramAlerts
};
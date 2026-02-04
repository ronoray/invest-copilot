import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { getCurrentPrice } from '../services/marketData.js';
import { scanMarketForOpportunities } from '../services/advancedScreener.js';
import { sendAlert, broadcastMessage } from '../services/telegramBot.js';
import logger from '../services/logger.js';

const prisma = new PrismaClient();

/**
 * Telegram Alert System
 * Monitors prices, triggers alerts, sends daily digests
 */

// ============================================
// PRICE MONITORING
// ============================================

/**
 * Check for target hits and stop losses
 */
async function checkPriceAlerts() {
  try {
    const holdings = await prisma.holding.findMany({
      include: { user: { include: { telegramUser: true } } }
    });

    for (const holding of holdings) {
      if (!holding.user?.telegramUser) continue;

      try {
        const currentPrice = await getCurrentPrice(holding.symbol, holding.exchange);
        
        // Update current price in database
        await prisma.holding.update({
          where: { id: holding.id },
          data: { currentPrice: currentPrice.price }
        });

        // Check target hit (within 2% of target)
        if (holding.targetPrice && currentPrice.price >= holding.targetPrice * 0.98) {
          await sendAlert(holding.user.telegramUser.id, 'SELL_SIGNAL', {
            holding,
            currentPrice: currentPrice.price,
            reason: 'Target price reached! 🎯'
          });
        }

        // Check stop loss triggered
        if (holding.stopLoss && currentPrice.price <= holding.stopLoss) {
          await sendAlert(holding.user.telegramUser.id, 'SELL_SIGNAL', {
            holding,
            currentPrice: currentPrice.price,
            reason: 'Stop loss triggered! 🛑 Exit now to limit losses.'
          });
        }

        // Small delay to avoid API rate limits
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
// BUY SIGNAL SCANNER
// ============================================

/**
 * Scan market for new buy opportunities
 */
async function scanForBuySignals() {
  try {
    logger.info('Scanning for buy signals...');

    const opportunities = await scanMarketForOpportunities({
      targetCount: { high: 2, medium: 2, low: 2 },
      baseAmount: 10000
    });

    const allStocks = [...opportunities.high, ...opportunities.medium, ...opportunities.low];

    // Get users who want buy signals
    const users = await prisma.telegramUser.findMany({
      where: { isActive: true, isMuted: false }
    });

    for (const user of users) {
      const prefs = user.preferences || {};
      
      for (const stock of allStocks) {
        // Check user's risk preferences
        if (
          (stock.riskCategory === 'high' && prefs.buySignalsHigh) ||
          (stock.riskCategory === 'medium' && prefs.buySignalsMedium) ||
          (stock.riskCategory === 'low' && prefs.buySignalsLow)
        ) {
          // Check if we already alerted about this stock recently
          const recentAlert = await prisma.alertHistory.findFirst({
            where: {
              userId: user.id,
              symbol: stock.symbol,
              alertType: 'BUY_SIGNAL',
              createdAt: {
                gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
              }
            }
          });

          if (!recentAlert) {
            await sendAlert(user.id, 'BUY_SIGNAL', stock);
            
            // Record alert
            await prisma.alertHistory.create({
              data: {
                userId: user.id,
                symbol: stock.symbol,
                alertType: 'BUY_SIGNAL',
                price: stock.price
              }
            });

            // Rate limiting
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
// DAILY DIGEST
// ============================================

/**
 * Morning briefing (9 AM)
 */
async function sendMorningDigest() {
  try {
    logger.info('Sending morning digest...');

    const opportunities = await scanMarketForOpportunities({
      targetCount: { high: 3, medium: 3, low: 3 },
      baseAmount: 10000
    });

    const allStocks = [...opportunities.high, ...opportunities.medium, ...opportunities.low];
    const topPicks = allStocks.slice(0, 3);

    const digestMsg = `☀️ *GOOD MORNING!*
━━━━━━━━━━━━━━━━━━━

*Today's Top Picks:*
${topPicks.map((s, i) => `${i + 1}. ${s.symbol} (${s.riskCategory}) - ₹${s.price.toFixed(0)}`).join('\n')}

Total Opportunities: ${allStocks.length}
🔥 High: ${opportunities.high.length}
⚡ Medium: ${opportunities.medium.length}
🛡️ Low: ${opportunities.low.length}

Use /scan for full list!

Good luck today! 💰`;

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

    logger.info(`Morning digest sent to ${users.length} users`);
  } catch (error) {
    logger.error('Morning digest error:', error);
  }
}

/**
 * Evening summary (6 PM)
 */
async function sendEveningSummary() {
  try {
    logger.info('Sending evening summary...');

    // Calculate daily P&L
    const holdings = await prisma.holding.findMany();
    
    let totalValue = 0;
    let totalInvested = 0;

    holdings.forEach(h => {
      totalValue += h.quantity * (h.currentPrice || h.avgPrice);
      totalInvested += h.quantity * h.avgPrice;
    });

    const dailyPL = totalValue - totalInvested;
    const dailyPLPercent = totalInvested > 0 ? (dailyPL / totalInvested) * 100 : 0;

    const summaryMsg = `🌙 *MARKET CLOSED*
━━━━━━━━━━━━━━━━━━━

*Your Performance Today:*
Portfolio Value: ₹${totalValue.toLocaleString('en-IN')}
Day's P&L: ${dailyPL >= 0 ? '📈' : '📉'} ₹${Math.abs(dailyPL).toLocaleString('en-IN')} (${dailyPLPercent.toFixed(2)}%)

${dailyPL > 0 ? '🎉 Great day!' : dailyPL < 0 ? '💪 Tomorrow is another day!' : '😌 Stable day!'}

Use /portfolio for details
Use /plan for tomorrow's strategy`;

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

    logger.info(`Evening summary sent to ${users.length} users`);
  } catch (error) {
    logger.error('Evening summary error:', error);
  }
}

// ============================================
// CRON JOB SETUP
// ============================================

export function initTelegramAlerts() {
  logger.info('Initializing Telegram alert system...');

  // Check prices every 5 minutes during market hours (9:15 AM - 3:30 PM IST)
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    await checkPriceAlerts();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Scan for buy signals every hour during market hours
  cron.schedule('0 9-15 * * 1-5', async () => {
    await scanForBuySignals();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Morning digest at 9:00 AM
  cron.schedule('0 9 * * 1-5', async () => {
    await sendMorningDigest();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Evening summary at 6:00 PM
  cron.schedule('0 18 * * 1-5', async () => {
    await sendEveningSummary();
  }, {
    timezone: 'Asia/Kolkata'
  });

  logger.info('Telegram alert cron jobs initialized');
}

export default {
  checkPriceAlerts,
  scanForBuySignals,
  sendMorningDigest,
  sendEveningSummary,
  initTelegramAlerts
};
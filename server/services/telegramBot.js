import TelegramBot from 'node-telegram-bot-api';
import { PrismaClient } from '@prisma/client';
import logger from './logger.js';
import { getCurrentPrice } from './marketData.js';
import { scanMarketForOpportunities } from './advancedScreener.js';

const prisma = new PrismaClient();

// Create bot instance ONLY ONCE
let bot = null;

function getBot() {
  if (!bot) {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
      polling: {
        interval: 1000,
        autoStart: true,
        params: {
          timeout: 10
        }
      }
    });
    
    // Handle polling errors
    bot.on('polling_error', (error) => {
      logger.error('Telegram polling error:', error);
    });
  }
  return bot;
}

/**
 * Investment Co-Pilot Telegram Bot
 * Fixed version - prevents command loops
 */

// ============================================
// UTILITIES & FORMATTING
// ============================================

function formatPrice(price) {
  return `₹${price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPercent(percent) {
  const sign = percent >= 0 ? '+' : '';
  return `${sign}${percent.toFixed(2)}%`;
}

function getRiskEmoji(category) {
  return category === 'high' ? '🔥' : category === 'medium' ? '⚡' : '🛡️';
}

async function getOrCreateUser(telegramId, username, firstName) {
  let user = await prisma.telegramUser.findUnique({
    where: { telegramId: telegramId.toString() }
  });

  if (!user) {
    user = await prisma.telegramUser.create({
      data: {
        telegramId: telegramId.toString(),
        username,
        firstName,
        isActive: true,
        preferences: {
          buySignalsHigh: true,
          buySignalsMedium: true,
          buySignalsLow: true,
          sellSignals: true,
          dailyDigest: true,
          eveningSummary: true
        }
      }
    });
    logger.info(`New Telegram user: ${firstName}`);
  }

  return user;
}

// ============================================
// ALERT MESSAGE FORMATTERS
// ============================================

function formatBuyAlert(stock) {
  return `${getRiskEmoji(stock.riskCategory)} *BUY ALERT - ${stock.symbol}*
━━━━━━━━━━━━━━━━━━━
Price: ${formatPrice(stock.price)}
Risk: ${stock.riskCategory.toUpperCase()} (${stock.riskScore}/10)

*Why Buy?*
${stock.simpleWhy.map(r => `✓ ${r}`).join('\n')}

*Investment:* ${formatPrice(stock.suggestedAmount)}
*Target:* ${formatPrice(stock.targetPrice)} (${formatPercent(((stock.targetPrice - stock.price) / stock.price) * 100)})
*Stop Loss:* ${formatPrice(stock.stopLoss)} (${formatPercent(((stock.stopLoss - stock.price) / stock.price) * 100)})

*Expected Returns:*
🚀 Best: ${stock.expectedReturns.best}
📊 Likely: ${stock.expectedReturns.likely}
📉 Worst: ${stock.expectedReturns.worst}`;
}

function formatSellAlert(holding, currentPrice, reason) {
  const profit = (currentPrice - holding.avgPrice) * holding.quantity;
  const profitPercent = ((currentPrice - holding.avgPrice) / holding.avgPrice) * 100;
  
  return `💰 *SELL ALERT - ${holding.symbol}*
━━━━━━━━━━━━━━━━━━━
Current: ${formatPrice(currentPrice)}
Your Buy: ${formatPrice(holding.avgPrice)}
Profit: ${formatPrice(profit)} (${formatPercent(profitPercent)})

*Reason:* ${reason}

${profitPercent > 0 ? '✅ Book profit now!' : '🛑 Cut losses!'}`;
}

// ============================================
// BOT COMMANDS - REGISTERED ONLY ONCE
// ============================================

export function initTelegramBot() {
  const botInstance = getBot();
  
  logger.info('Initializing Telegram bot commands...');

  // Remove all previous listeners to prevent duplicates
  botInstance.removeAllListeners('message');
  botInstance.removeAllListeners('text');

  // /start
  botInstance.onText(/^\/start$/, async (msg) => {
    try {
      await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);

      const welcomeMsg = `👋 *Welcome to Investment Co-Pilot!*

I'm your AI investment assistant.

*Features:*
✅ AI stock recommendations
✅ Real-time buy/sell alerts
✅ Portfolio tracking
✅ Tax optimization

*Quick Start:*
/scan - Find opportunities
/portfolio - View holdings
/help - All commands

Let's build wealth! 💰`;

      await botInstance.sendMessage(msg.chat.id, welcomeMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Start command error:', error);
      await botInstance.sendMessage(msg.chat.id, '❌ Error starting bot');
    }
  });

  // /help
  botInstance.onText(/^\/help$/, async (msg) => {
    try {
      const helpMsg = `📚 *Commands*

*Portfolio:*
/portfolio - View holdings
/pnl - Profit & loss
/plan - Investment plan

*Market:*
/scan - AI market scan
/opportunities - Top 5 picks
/price [SYMBOL] - Get price
/why [SYMBOL] - Analysis

*Actions:*
/buy [SYMBOL] [QTY] - Add stock
/sell [SYMBOL] [QTY] - Remove stock

*Settings:*
/settings - Preferences
/mute - Disable alerts
/unmute - Enable alerts`;

      await botInstance.sendMessage(msg.chat.id, helpMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Help command error:', error);
      await botInstance.sendMessage(msg.chat.id, '❌ Error showing help');
    }
  });

  // /scan
  botInstance.onText(/^\/scan$/, async (msg) => {
    try {
      await botInstance.sendMessage(msg.chat.id, '🔍 Scanning market...');

      const opportunities = await scanMarketForOpportunities({
        targetCount: { high: 3, medium: 3, low: 3 },
        baseAmount: 10000
      });

      const scanMsg = `✅ *Scan Complete!*

🔥 *High Risk (${opportunities.high.length}):*
${opportunities.high.map(s => `• ${s.symbol} - ${formatPrice(s.price)}`).join('\n')}

⚡ *Medium Risk (${opportunities.medium.length}):*
${opportunities.medium.map(s => `• ${s.symbol} - ${formatPrice(s.price)}`).join('\n')}

🛡️ *Low Risk (${opportunities.low.length}):*
${opportunities.low.map(s => `• ${s.symbol} - ${formatPrice(s.price)}`).join('\n')}

Type /why [SYMBOL] to learn more!`;

      await botInstance.sendMessage(msg.chat.id, scanMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Scan error:', error);
      await botInstance.sendMessage(msg.chat.id, '❌ Scan failed');
    }
  });

  // /why [SYMBOL]
  botInstance.onText(/^\/why (.+)$/, async (msg, match) => {
    try {
      const symbol = match[1].toUpperCase();
      await botInstance.sendMessage(msg.chat.id, `🔍 Analyzing ${symbol}...`);

      const opportunities = await scanMarketForOpportunities({
        targetCount: { high: 5, medium: 5, low: 5 },
        baseAmount: 10000
      });

      const allStocks = [...opportunities.high, ...opportunities.medium, ...opportunities.low];
      const stock = allStocks.find(s => s.symbol === symbol);

      if (!stock) {
        await botInstance.sendMessage(msg.chat.id, `❌ ${symbol} not in current opportunities`);
        return;
      }

      await botInstance.sendMessage(msg.chat.id, formatBuyAlert(stock), { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Why error:', error);
      await botInstance.sendMessage(msg.chat.id, '❌ Analysis failed');
    }
  });

  // /price [SYMBOL]
  botInstance.onText(/^\/price (.+)$/, async (msg, match) => {
    try {
      const symbol = match[1].toUpperCase();

      const priceData = await getCurrentPrice(symbol, 'NSE');
      
      const priceMsg = `📊 *${symbol}*

*Price:* ${formatPrice(priceData.price)}
*Change:* ${priceData.changePercent >= 0 ? '📈' : '📉'} ${formatPercent(priceData.changePercent)}

Type /why ${symbol} for analysis`;

      await botInstance.sendMessage(msg.chat.id, priceMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Price error:', error);
      await botInstance.sendMessage(msg.chat.id, `❌ Failed to get price for ${symbol}`);
    }
  });

  // /portfolio
  botInstance.onText(/^\/portfolio$/, async (msg) => {
    try {
      const holdings = await prisma.holding.findMany();
      
      if (holdings.length === 0) {
        await botInstance.sendMessage(msg.chat.id, '🔭 Portfolio empty. Use /scan!');
        return;
      }

      let totalValue = 0;
      let totalInvested = 0;

      const lines = holdings.map(h => {
        const invested = h.quantity * h.avgPrice;
        const current = h.quantity * (h.currentPrice || h.avgPrice);
        const pl = current - invested;
        const plPercent = (pl / invested) * 100;

        totalValue += current;
        totalInvested += invested;

        return `*${h.symbol}*: ${h.quantity} @ ${formatPrice(h.avgPrice)}\nP&L: ${formatPrice(pl)} (${formatPercent(plPercent)})`;
      }).join('\n\n');

      const totalPL = totalValue - totalInvested;
      const totalPLPercent = (totalPL / totalInvested) * 100;

      const portfolioMsg = `💼 *PORTFOLIO*
━━━━━━━━━━━━━━━━━━━
Value: ${formatPrice(totalValue)}
Invested: ${formatPrice(totalInvested)}
P&L: ${formatPrice(totalPL)} (${formatPercent(totalPLPercent)})

━━━━━━━━━━━━━━━━━━━
${lines}`;

      await botInstance.sendMessage(msg.chat.id, portfolioMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Portfolio error:', error);
      await botInstance.sendMessage(msg.chat.id, '❌ Failed to fetch portfolio');
    }
  });

  // /buy [SYMBOL] [QTY]
  botInstance.onText(/^\/buy (\w+) (\d+)$/, async (msg, match) => {
    try {
      const symbol = match[1].toUpperCase();
      const quantity = parseInt(match[2]);

      const priceData = await getCurrentPrice(symbol, 'NSE');
      
      await prisma.holding.upsert({
        where: { symbol },
        update: { quantity: { increment: quantity } },
        create: {
          symbol,
          exchange: 'NSE',
          quantity,
          avgPrice: priceData.price,
          currentPrice: priceData.price
        }
      });

      const totalCost = quantity * priceData.price;

      await botInstance.sendMessage(msg.chat.id, `✅ *ADDED*

${symbol}: ${quantity} shares
Price: ${formatPrice(priceData.price)}
Total: ${formatPrice(totalCost)}`, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Buy error:', error);
      await botInstance.sendMessage(msg.chat.id, '❌ Purchase failed');
    }
  });

  // /settings
  botInstance.onText(/^\/settings$/, async (msg) => {
    try {
      const user = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
      const prefs = user.preferences || {};

      const settingsMsg = `⚙️ *Settings*

*Alerts:*
${prefs.buySignalsHigh ? '✅' : '❌'} Buy (High risk)
${prefs.buySignalsMedium ? '✅' : '❌'} Buy (Medium risk)
${prefs.buySignalsLow ? '✅' : '❌'} Buy (Low risk)
${prefs.sellSignals ? '✅' : '❌'} Sell signals
${prefs.dailyDigest ? '✅' : '❌'} Daily digest
${prefs.eveningSummary ? '✅' : '❌'} Evening summary

Use /mute to disable all alerts`;

      await botInstance.sendMessage(msg.chat.id, settingsMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Settings error:', error);
      await botInstance.sendMessage(msg.chat.id, '❌ Failed to show settings');
    }
  });

  // /mute
  botInstance.onText(/^\/mute$/, async (msg) => {
    try {
      await prisma.telegramUser.update({
        where: { telegramId: msg.from.id.toString() },
        data: { isMuted: true }
      });

      await botInstance.sendMessage(msg.chat.id, '🔇 Alerts muted for 24h. Use /unmute to re-enable.');
    } catch (error) {
      logger.error('Mute error:', error);
      await botInstance.sendMessage(msg.chat.id, '❌ Failed to mute');
    }
  });

  // /unmute
  botInstance.onText(/^\/unmute$/, async (msg) => {
    try {
      await prisma.telegramUser.update({
        where: { telegramId: msg.from.id.toString() },
        data: { isMuted: false }
      });

      await botInstance.sendMessage(msg.chat.id, '🔔 Alerts enabled!');
    } catch (error) {
      logger.error('Unmute error:', error);
      await botInstance.sendMessage(msg.chat.id, '❌ Failed to unmute');
    }
  });

  logger.info('Telegram bot commands registered successfully');
}

// ============================================
// ALERT FUNCTIONS (Called by cron jobs)
// ============================================

export async function sendAlert(userId, type, data) {
  try {
    const user = await prisma.telegramUser.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || user.isMuted) return;

    const chatId = parseInt(user.telegramId);
    let message;

    switch(type) {
      case 'BUY_SIGNAL':
        message = formatBuyAlert(data);
        break;
      case 'SELL_SIGNAL':
        message = formatSellAlert(data.holding, data.currentPrice, data.reason);
        break;
      default:
        message = data.message;
    }

    const botInstance = getBot();
    await botInstance.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    logger.info(`Alert sent: ${type} to user ${userId}`);
  } catch (error) {
    logger.error(`Alert error for user ${userId}:`, error);
  }
}

export async function broadcastMessage(message) {
  try {
    const users = await prisma.telegramUser.findMany({
      where: { isActive: true, isMuted: false }
    });

    const botInstance = getBot();
    for (const user of users) {
      try {
        await botInstance.sendMessage(parseInt(user.telegramId), message, { parse_mode: 'Markdown' });
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.error(`Broadcast error for ${user.telegramId}:`, error);
      }
    }

    logger.info(`Broadcast sent to ${users.length} users`);
  } catch (error) {
    logger.error('Broadcast error:', error);
  }
}

export default getBot();
import TelegramBot from 'node-telegram-bot-api';
import { PrismaClient } from '@prisma/client';
import logger from './logger.js';
import { getCurrentPrice } from './marketData.js';
import { scanMarketForOpportunities } from './advancedScreener.js';

const prisma = new PrismaClient();

// Create bot instance ONLY ONCE
let bot = null;

function getBot() {
  if (!bot && process.env.TELEGRAM_BOT_TOKEN) {
    try {
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
        logger.error('Telegram polling error:', error.message);
      });

      bot.on('error', (error) => {
        logger.error('Telegram error:', error.message);
      });
    } catch (error) {
      logger.error('Failed to initialize Telegram bot:', error.message);
    }
  }
  return bot;
}

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
  try {
    let telegramUser = await prisma.telegramUser.findUnique({
      where: { telegramId: telegramId.toString() }
    });

    if (!telegramUser) {
      // First, check if there's an existing User (there should be from admin login)
      const existingUser = await prisma.user.findFirst();
      
      if (!existingUser) {
        throw new Error('No user found in database. Please login via web first.');
      }

      // Create TelegramUser linked to existing User
      telegramUser = await prisma.telegramUser.create({
        data: {
          telegramId: telegramId.toString(),
          username: username || null,
          firstName: firstName || 'User',
          isActive: true,
          preferences: {
            buySignalsHigh: true,
            buySignalsMedium: true,
            buySignalsLow: true,
            sellSignals: true,
            dailyDigest: true,
            eveningSummary: true
          },
          user: {
            connect: { id: existingUser.id }
          }
        }
      });
      logger.info(`New Telegram user created: ${firstName} (${telegramId}) linked to User ID ${existingUser.id}`);
    }

    return telegramUser;
  } catch (error) {
    logger.error('Failed to get/create Telegram user:', error);
    throw error;
  }
}

// ============================================
// BOT COMMANDS
// ============================================

export function initTelegramBot() {
  try {
    const botInstance = getBot();
    
    if (!botInstance) {
      logger.warn('Telegram bot not initialized - missing TELEGRAM_BOT_TOKEN');
      return;
    }

    logger.info('Initializing Telegram bot commands...');

    // Remove all previous listeners
    botInstance.removeAllListeners('message');
    botInstance.removeAllListeners('text');

    // /start
    botInstance.onText(/^\/start$/, async (msg) => {
      try {
        logger.info(`/start command from ${msg.from.id}`);
        
        await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);

        const welcomeMsg = `👋 *Welcome to Investment Co-Pilot!*

I'm your AI investment assistant.

*Features:*
✅ AI stock recommendations
✅ Real-time buy/sell alerts
✅ Portfolio tracking
✅ Market analysis

*Quick Start:*
/scan - Find opportunities
/portfolio - View holdings
/help - All commands

Let's build wealth! 💰`;

        await botInstance.sendMessage(msg.chat.id, welcomeMsg, { parse_mode: 'Markdown' });
        logger.info(`Welcome message sent to ${msg.from.id}`);
      } catch (error) {
        logger.error('Start command error:', error);
        try {
          await botInstance.sendMessage(msg.chat.id, '⚠️ Error starting bot. Please try again.');
        } catch (sendError) {
          logger.error('Failed to send error message:', sendError);
        }
      }
    });

    // /help
    botInstance.onText(/^\/help$/, async (msg) => {
      try {
        const helpMsg = `📚 *Commands*

*Market:*
/scan - AI market scan
/price [SYMBOL] - Get price

*Portfolio:*
/portfolio - View holdings

*Settings:*
/settings - Preferences
/mute - Disable alerts
/unmute - Enable alerts`;

        await botInstance.sendMessage(msg.chat.id, helpMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Help command error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Error showing help').catch(() => {});
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

Use /price [SYMBOL] for details!`;

        await botInstance.sendMessage(msg.chat.id, scanMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Scan error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Scan failed').catch(() => {});
      }
    });

    // /price [SYMBOL]
    botInstance.onText(/^\/price (.+)$/, async (msg, match) => {
      try {
        const symbol = match[1].toUpperCase();

        const priceData = await getCurrentPrice(symbol, 'NSE');
        
        const priceMsg = `📊 *${symbol}*

*Price:* ${formatPrice(priceData.price)}
*Change:* ${priceData.changePercent >= 0 ? '📈' : '📉'} ${formatPercent(priceData.changePercent)}`;

        await botInstance.sendMessage(msg.chat.id, priceMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Price error:', error);
        await botInstance.sendMessage(msg.chat.id, `❌ Failed to get price for ${match[1]}`).catch(() => {});
      }
    });

    // /portfolio
    botInstance.onText(/^\/portfolio$/, async (msg) => {
      try {
        const holdings = await prisma.holding.findMany();
        
        if (holdings.length === 0) {
          await botInstance.sendMessage(msg.chat.id, '📭 Portfolio empty. Add some holdings first!');
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
        await botInstance.sendMessage(msg.chat.id, '❌ Failed to fetch portfolio').catch(() => {});
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
        await botInstance.sendMessage(msg.chat.id, '❌ Failed to show settings').catch(() => {});
      }
    });

    // /mute
    botInstance.onText(/^\/mute$/, async (msg) => {
      try {
        await prisma.telegramUser.update({
          where: { telegramId: msg.from.id.toString() },
          data: { isMuted: true }
        });

        await botInstance.sendMessage(msg.chat.id, '🔇 Alerts muted. Use /unmute to re-enable.');
      } catch (error) {
        logger.error('Mute error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Failed to mute').catch(() => {});
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
        await botInstance.sendMessage(msg.chat.id, '❌ Failed to unmute').catch(() => {});
      }
    });

    logger.info('✅ Telegram bot commands registered successfully');
  } catch (error) {
    logger.error('Failed to initialize Telegram bot:', error);
  }
}

// ============================================
// ALERT FUNCTIONS
// ============================================

export async function sendAlert(userId, type, data) {
  try {
    const botInstance = getBot();
    if (!botInstance) return;

    const user = await prisma.telegramUser.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || user.isMuted) return;

    const chatId = parseInt(user.telegramId);
    let message = data.message || 'Alert notification';

    await botInstance.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    logger.info(`Alert sent: ${type} to user ${userId}`);
  } catch (error) {
    logger.error(`Alert error for user ${userId}:`, error);
  }
}

export async function broadcastMessage(message) {
  try {
    const botInstance = getBot();
    if (!botInstance) return;

    const users = await prisma.telegramUser.findMany({
      where: { isActive: true, isMuted: false }
    });

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
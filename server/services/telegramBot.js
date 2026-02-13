import TelegramBot from 'node-telegram-bot-api';
import { PrismaClient } from '@prisma/client';
import logger from './logger.js';
import { getCurrentPrice } from './marketData.js';
import { scanMarketForOpportunities, buildProfileBrief } from './advancedScreener.js';
import { generateMultiAssetRecommendations } from './multiAssetRecommendations.js';
import { placeOrder, getOrderStatus, getAuthorizationUrl, isTokenValid } from './upstoxService.js';
import { preOrderCapitalCheck, updateCashOnExecution } from './capitalGuard.js';

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
  return `₹${parseFloat(price).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatINR(amount) {
  return `₹${parseFloat(amount).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
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
      where: { telegramId: telegramId.toString() },
      include: { user: true }
    });

    if (!telegramUser) {
      const existingUser = await prisma.user.findFirst();

      if (!existingUser) {
        throw new Error('No user found in database. Please login via web first.');
      }

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
        },
        include: { user: true }
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
// HELPER: Get user's portfolios (numbered)
// ============================================

async function getUserPortfolios(userId) {
  return prisma.portfolio.findMany({
    where: { userId, isActive: true },
    include: { holdings: true },
    orderBy: { createdAt: 'asc' }
  });
}

async function getPortfolioByIndex(userId, index) {
  const portfolios = await getUserPortfolios(userId);
  if (index < 1 || index > portfolios.length) return null;
  return portfolios[index - 1];
}

function portfolioLabel(p) {
  const risk = p.riskProfile ? ` (${p.riskProfile})` : '';
  return `${p.ownerName || p.name} - ${(p.broker || 'Unknown').replace(/_/g, ' ')}${risk}`;
}

// ============================================
// ORDER POLLING AFTER PLACEMENT
// ============================================

const TERMINAL_STATUSES = ['complete', 'traded', 'rejected', 'cancelled'];
const SETTLED_SUCCESS = ['complete', 'traded'];
const SETTLED_FAILURE = ['rejected', 'cancelled'];

async function pollOrderUntilSettled(botInstance, chatId, userId, signalId, signal, orderId, dbOrderId) {
  const maxAttempts = 5;
  const intervalMs = 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    try {
      const status = await getOrderStatus(userId, orderId);
      const orderStatus = (status.status || '').toLowerCase();

      logger.info(`Poll attempt ${attempt}/${maxAttempts} for order ${orderId}: ${orderStatus}`);

      if (SETTLED_SUCCESS.includes(orderStatus)) {
        // Order confirmed — mark signal EXECUTED
        await prisma.tradeSignal.update({
          where: { id: signalId },
          data: { status: 'EXECUTED' }
        });

        // Sync portfolio cash
        await updateCashOnExecution(dbOrderId);

        const avgPrice = status.averagePrice ? ` @ ${formatPrice(status.averagePrice)}` : '';
        const successMsg = `✅ *ORDER CONFIRMED*\n\n${signal.side} ${signal.quantity}x *${signal.symbol}*${avgPrice}\nOrder ID: \`${orderId}\`\n\n_Exchange confirmed. Position is live._`;

        try {
          await botInstance.editMessageReplyMarkup(
            { inline_keyboard: [[{ text: `✅ Confirmed — ${orderId}`, callback_data: 'noop' }]] },
            { chat_id: chatId, message_id: signal._messageId }
          );
        } catch (e) { /* message may be old */ }

        await botInstance.sendMessage(chatId, successMsg, { parse_mode: 'Markdown' });
        logger.info(`Signal #${signalId} confirmed: order ${orderId} = ${orderStatus}`);
        return;
      }

      if (SETTLED_FAILURE.includes(orderStatus)) {
        // Order rejected — roll back signal
        await prisma.tradeSignal.update({
          where: { id: signalId },
          data: { status: 'PENDING', upstoxOrderId: null, lastNotifiedAt: null }
        });

        const reason = status.message || 'Unknown reason';
        const failureMsg = `🔴 *ORDER FAILED — THIS IS MY FAILURE*\n\n${signal.side} ${signal.symbol} @ ${formatPrice(signal.triggerPrice || signal.triggerLow || 0)} was *${orderStatus.toUpperCase()}*\nReason: _${reason}_\n\nI recommended a price the exchange rejected. I own this mistake.\nSignal reset — choose how to proceed:`;

        try {
          await botInstance.editMessageReplyMarkup(
            { inline_keyboard: [[{ text: `🔴 ${orderStatus.toUpperCase()} — reset`, callback_data: 'noop' }]] },
            { chat_id: chatId, message_id: signal._messageId }
          );
        } catch (e) { /* message may be old */ }

        await botInstance.sendMessage(chatId, failureMsg, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🔄 Retry as MARKET', callback_data: `sig_mkt_${signalId}` },
              { text: '⏰ Snooze 1hr', callback_data: `sig_snooze_${signalId}` },
              { text: '🚫 Dismiss', callback_data: `sig_dismiss_${signalId}` }
            ]]
          }
        });
        logger.warn(`Signal #${signalId} rolled back: order ${orderId} = ${orderStatus} — ${reason}`);
        return;
      }
    } catch (pollErr) {
      logger.warn(`Poll attempt ${attempt} failed for order ${orderId}: ${pollErr.message}`);
    }
  }

  // Timeout — still pending after all attempts
  await botInstance.sendMessage(chatId,
    `⏳ *Order Pending*\n\n${signal.side} ${signal.quantity}x *${signal.symbol}*\nOrder ID: \`${orderId}\`\n\n_Exchange hasn't confirmed yet. I'll keep monitoring and alert you when it settles._`,
    { parse_mode: 'Markdown' }
  );
  logger.info(`Signal #${signalId} order ${orderId} still pending after ${maxAttempts} polls — cron will follow up`);
}

// ============================================
// EXECUTE SIGNAL VIA UPSTOX
// ============================================

async function handleExecuteSignal(botInstance, query, signalId) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    // Load signal with portfolio and user's Upstox integration
    const signal = await prisma.tradeSignal.findUnique({
      where: { id: signalId },
      include: {
        portfolio: {
          include: {
            user: {
              include: { upstoxIntegration: true }
            }
          }
        }
      }
    });

    if (!signal) {
      await botInstance.answerCallbackQuery(query.id, { text: 'Signal not found' }).catch(() => {});
      return;
    }

    if (signal.status === 'EXECUTED' || signal.status === 'PLACING') {
      await botInstance.answerCallbackQuery(query.id, { text: signal.status === 'PLACING' ? 'Order is being verified...' : 'Already executed' }).catch(() => {});
      return;
    }

    if (signal.status === 'DISMISSED' || signal.status === 'EXPIRED') {
      await botInstance.answerCallbackQuery(query.id, { text: `Signal is ${signal.status.toLowerCase()}` }).catch(() => {});
      return;
    }

    const userId = signal.portfolio?.user?.id;
    const upstox = signal.portfolio?.user?.upstoxIntegration;

    if (!upstox || !upstox.isConnected || !upstox.accessToken) {
      await botInstance.answerCallbackQuery(query.id, { text: 'Upstox not connected' }).catch(() => {});
      return;
    }

    // Show processing state — catch stale callback errors (Telegram expires queries after ~30s)
    await botInstance.answerCallbackQuery(query.id, { text: 'Placing order...' }).catch(() => {});
    await botInstance.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: '⏳ Placing order...', callback_data: 'noop' }]] },
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});

    // Map signal trigger type to Upstox order params
    let orderType = 'MARKET';
    let price = 0;
    let triggerPrice = 0;

    if (signal.triggerType === 'LIMIT' && signal.triggerPrice) {
      orderType = 'LIMIT';
      price = parseFloat(signal.triggerPrice);
    } else if (signal.triggerType === 'ZONE' && signal.triggerLow) {
      // ZONE → LIMIT at lower bound
      orderType = 'LIMIT';
      price = parseFloat(signal.triggerLow);
    }

    // Validate LIMIT price against live market price (reject if >20% deviation)
    if (orderType === 'LIMIT' && price > 0) {
      try {
        const liveData = await getCurrentPrice(signal.symbol, signal.exchange);
        const currentPrice = liveData?.price || liveData?.lastPrice;
        if (currentPrice && currentPrice > 0) {
          const deviation = Math.abs(price - currentPrice) / currentPrice;
          if (deviation > 0.20) {
            logger.warn(`Signal #${signalId} price validation failed: signal=${price}, market=${currentPrice}, deviation=${(deviation * 100).toFixed(1)}%`);
            await botInstance.editMessageReplyMarkup(
              { inline_keyboard: [
                [{ text: '📊 Place as MARKET order', callback_data: `sig_mkt_${signalId}` }],
                [{ text: '🚫 Dismiss', callback_data: `sig_dismiss_${signalId}` }]
              ] },
              { chat_id: chatId, message_id: messageId }
            ).catch(() => {});
            await botInstance.sendMessage(chatId,
              `⚠️ *Price Validation Failed*\n\nSignal price: ${formatPrice(price)}\nCurrent market price: ${formatPrice(currentPrice)}\nDeviation: ${(deviation * 100).toFixed(1)}%\n\n_The signal price is too far from the current market price. This could lead to order rejection by the exchange._`,
              { parse_mode: 'Markdown' }
            );
            return;
          }
        }
      } catch (priceErr) {
        logger.warn(`Could not validate price for signal #${signalId}: ${priceErr.message}`);
        // Continue with order — better to try than to block on price fetch failure
      }
    }

    // Capital check for BUY orders
    if (signal.side === 'BUY') {
      let estimatedPrice = price; // LIMIT price
      if (orderType === 'MARKET') {
        // For MARKET orders, fetch live price for capital check
        try {
          const priceData = await getCurrentPrice(signal.symbol, signal.exchange);
          estimatedPrice = priceData?.price || priceData?.lastPrice || parseFloat(signal.triggerPrice || signal.triggerLow || 0);
        } catch (e) {
          estimatedPrice = parseFloat(signal.triggerPrice || signal.triggerLow || 0);
        }
      }

      if (estimatedPrice > 0) {
        const capitalCheck = await preOrderCapitalCheck(signal.portfolioId, 'BUY', signal.quantity, estimatedPrice);
        if (!capitalCheck.allowed) {
          logger.warn(`Signal #${signalId} capital check failed: ${capitalCheck.reason}`);
          await botInstance.editMessageReplyMarkup(
            { inline_keyboard: [
              [{ text: '🚫 Dismiss', callback_data: `sig_dismiss_${signalId}` }]
            ] },
            { chat_id: chatId, message_id: messageId }
          ).catch(() => {});
          await botInstance.sendMessage(chatId,
            `💰 *Capital Check Failed*\n\nOrder cost: ₹${capitalCheck.orderCost.toLocaleString('en-IN')}\nAvailable cash: ₹${capitalCheck.effectiveCash.toLocaleString('en-IN')}\n\n_${capitalCheck.reason}_`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
      }
    }

    const orderParams = {
      symbol: signal.symbol,
      exchange: `${signal.exchange}_EQ`,
      transactionType: signal.side, // BUY or SELL
      orderType,
      quantity: signal.quantity,
      price,
      triggerPrice,
      portfolioId: signal.portfolioId
    };

    logger.info(`Executing signal #${signalId} via Upstox:`, orderParams);

    const result = await placeOrder(userId, orderParams);

    // Mark as PLACING (not EXECUTED yet — wait for exchange confirmation)
    await prisma.tradeSignal.update({
      where: { id: signalId },
      data: {
        status: 'PLACING',
        upstoxOrderId: result.dbOrderId
      }
    });

    // Create ack record
    await prisma.signalAck.create({
      data: {
        signalId,
        action: 'EXECUTE',
        note: `Upstox order ${result.orderId} placed via Telegram by ${query.from.first_name || query.from.id}`
      }
    });

    // Update message to show order is being verified
    try {
      await botInstance.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: `⏳ Verifying order ${result.orderId}...`, callback_data: 'noop' }]] },
        { chat_id: chatId, message_id: messageId }
      );
    } catch (editErr) {
      logger.warn('Could not edit signal message after execute:', editErr.message);
    }

    await botInstance.sendMessage(chatId,
      `📡 *Order Sent*\n${signal.side} ${signal.quantity}x ${signal.symbol}\nOrder ID: \`${result.orderId}\`\n_Verifying with exchange..._`,
      { parse_mode: 'Markdown' }
    );

    logger.info(`Signal #${signalId} order placed: ${result.orderId} — starting polling`);

    // Poll for settlement (async, non-blocking for the callback response)
    signal._messageId = messageId;
    pollOrderUntilSettled(botInstance, chatId, userId, signalId, signal, result.orderId, result.dbOrderId)
      .catch(err => logger.error(`Polling failed for signal #${signalId}:`, err));
  } catch (error) {
    logger.error(`Failed to execute signal #${signalId}:`, error);

    // Show error on the button
    try {
      await botInstance.editMessageReplyMarkup(
        { inline_keyboard: [[
          { text: '❌ Order Failed — Retry?', callback_data: `sig_exec_${signalId}` },
          { text: '🚫 Dismiss', callback_data: `sig_dismiss_${signalId}` }
        ]] },
        { chat_id: chatId, message_id: messageId }
      );
    } catch (editErr) {
      logger.warn('Could not edit message after execute failure:', editErr.message);
    }

    const errorMsg = error.message || 'Unknown error';
    await botInstance.sendMessage(chatId, `❌ *Order Failed*\nSignal #${signalId}: ${errorMsg}`, { parse_mode: 'Markdown' });
  }
}

// Handle "Place as MARKET order" fallback after price validation failure
async function handleExecuteMarketFallback(botInstance, query, signalId) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    const signal = await prisma.tradeSignal.findUnique({
      where: { id: signalId },
      include: {
        portfolio: {
          include: {
            user: {
              include: { upstoxIntegration: true }
            }
          }
        }
      }
    });

    if (!signal || signal.status === 'EXECUTED' || signal.status === 'PLACING' || signal.status === 'DISMISSED' || signal.status === 'EXPIRED') {
      await botInstance.answerCallbackQuery(query.id, { text: 'Signal no longer available' }).catch(() => {});
      return;
    }

    const userId = signal.portfolio?.user?.id;
    const upstox = signal.portfolio?.user?.upstoxIntegration;

    if (!upstox || !upstox.isConnected || !upstox.accessToken) {
      await botInstance.answerCallbackQuery(query.id, { text: 'Upstox not connected' }).catch(() => {});
      return;
    }

    await botInstance.answerCallbackQuery(query.id, { text: 'Placing MARKET order...' }).catch(() => {});
    await botInstance.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: '⏳ Placing MARKET order...', callback_data: 'noop' }]] },
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});

    // Capital check for BUY orders
    if (signal.side === 'BUY') {
      let estimatedPrice = 0;
      try {
        const priceData = await getCurrentPrice(signal.symbol, signal.exchange);
        estimatedPrice = priceData?.price || priceData?.lastPrice || parseFloat(signal.triggerPrice || signal.triggerLow || 0);
      } catch (e) {
        estimatedPrice = parseFloat(signal.triggerPrice || signal.triggerLow || 0);
      }

      if (estimatedPrice > 0) {
        const capitalCheck = await preOrderCapitalCheck(signal.portfolioId, 'BUY', signal.quantity, estimatedPrice);
        if (!capitalCheck.allowed) {
          logger.warn(`Signal #${signalId} MARKET fallback capital check failed: ${capitalCheck.reason}`);
          await botInstance.editMessageReplyMarkup(
            { inline_keyboard: [
              [{ text: '🚫 Dismiss', callback_data: `sig_dismiss_${signalId}` }]
            ] },
            { chat_id: chatId, message_id: messageId }
          ).catch(() => {});
          await botInstance.sendMessage(chatId,
            `💰 *Capital Check Failed*\n\nOrder cost: ₹${capitalCheck.orderCost.toLocaleString('en-IN')}\nAvailable cash: ₹${capitalCheck.effectiveCash.toLocaleString('en-IN')}\n\n_${capitalCheck.reason}_`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
      }
    }

    const orderParams = {
      symbol: signal.symbol,
      exchange: `${signal.exchange}_EQ`,
      transactionType: signal.side,
      orderType: 'MARKET',
      quantity: signal.quantity,
      price: 0,
      triggerPrice: 0,
      portfolioId: signal.portfolioId
    };

    logger.info(`Executing signal #${signalId} as MARKET order (fallback):`, orderParams);

    const result = await placeOrder(userId, orderParams);

    // Mark as PLACING (not EXECUTED yet)
    await prisma.tradeSignal.update({
      where: { id: signalId },
      data: { status: 'PLACING', upstoxOrderId: result.dbOrderId }
    });

    await prisma.signalAck.create({
      data: {
        signalId,
        action: 'EXECUTE',
        note: `MARKET order (price fallback) ${result.orderId} placed via Telegram by ${query.from.first_name || query.from.id}`
      }
    });

    try {
      await botInstance.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: `⏳ Verifying MARKET order ${result.orderId}...`, callback_data: 'noop' }]] },
        { chat_id: chatId, message_id: messageId }
      );
    } catch (editErr) {
      logger.warn('Could not edit signal message after market execute:', editErr.message);
    }

    await botInstance.sendMessage(chatId,
      `📡 *MARKET Order Sent*\n${signal.side} ${signal.quantity}x ${signal.symbol}\nOrder ID: \`${result.orderId}\`\n_Verifying with exchange..._`,
      { parse_mode: 'Markdown' }
    );

    // Poll for settlement
    signal._messageId = messageId;
    pollOrderUntilSettled(botInstance, chatId, userId, signalId, signal, result.orderId, result.dbOrderId)
      .catch(err => logger.error(`Polling failed for MARKET fallback signal #${signalId}:`, err));
  } catch (error) {
    logger.error(`Failed to execute MARKET fallback for signal #${signalId}:`, error);
    const errorMsg = error.message || 'Unknown error';
    await botInstance.sendMessage(chatId, `❌ *MARKET Order Failed*\nSignal #${signalId}: ${errorMsg}`, { parse_mode: 'Markdown' });
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
✅ Per-portfolio AI recommendations
✅ Real-time buy/sell alerts
✅ Multi-asset allocation advice
✅ Market analysis

*Quick Start:*
/portfolios - View all portfolios
/scan - Find opportunities
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
/scan - Generic market scan
/scan [N] - Scan tuned to portfolio #N
/price [SYMBOL] - Get stock price

*Portfolio:*
/portfolios - List all portfolios
/portfolio [N] - View portfolio #N details
/portfolio - View all holdings (legacy)

*AI Analysis:*
/recommend [N] - AI stock picks for portfolio #N
/multi [N] - Multi-asset allocation for portfolio #N

*Trading:*
/auth - Login to Upstox (daily refresh)

*Settings:*
/settings - Alert preferences
/mute - Disable alerts
/unmute - Enable alerts`;

        await botInstance.sendMessage(msg.chat.id, helpMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Help command error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Error showing help').catch(() => {});
      }
    });

    // /portfolios — List all portfolios
    botInstance.onText(/^\/portfolios$/, async (msg) => {
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const portfolios = await getUserPortfolios(telegramUser.user.id);

        if (portfolios.length === 0) {
          await botInstance.sendMessage(msg.chat.id, '📭 No portfolios found. Create one on the web app first!');
          return;
        }

        const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

        const lines = portfolios.map((p, i) => {
          const emoji = numberEmojis[i] || `${i + 1}.`;
          const risk = p.riskProfile || 'Not set';
          const capital = formatINR(parseFloat(p.startingCapital || 0));
          const cash = formatINR(parseFloat(p.availableCash || 0));
          const holdingCount = (p.holdings || []).length;
          return `${emoji} *${p.ownerName || p.name}* - ${(p.broker || 'Unknown').replace(/_/g, ' ')}
   ${risk} | Capital: ${capital} | Cash: ${cash}
   ${holdingCount} holding${holdingCount !== 1 ? 's' : ''}`;
        }).join('\n\n');

        const portfoliosMsg = `💼 *YOUR PORTFOLIOS*
━━━━━━━━━━━━━━━━━━━

${lines}

━━━━━━━━━━━━━━━━━━━
Use /portfolio [N] for details
Use /recommend [N] for AI picks`;

        await botInstance.sendMessage(msg.chat.id, portfoliosMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Portfolios command error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Failed to fetch portfolios').catch(() => {});
      }
    });

    // /portfolio [N] — View specific portfolio details
    botInstance.onText(/^\/portfolio (\d+)$/, async (msg, match) => {
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const index = parseInt(match[1]);
        const portfolio = await getPortfolioByIndex(telegramUser.user.id, index);

        if (!portfolio) {
          await botInstance.sendMessage(msg.chat.id, `❌ Portfolio #${index} not found. Use /portfolios to see your list.`);
          return;
        }

        const risk = portfolio.riskProfile || 'Not set';
        const goal = (portfolio.investmentGoal || 'Not set').replace(/_/g, ' ');
        const experience = portfolio.investmentExperience || 'Not set';
        const capital = formatINR(parseFloat(portfolio.startingCapital || 0));
        const cash = formatINR(parseFloat(portfolio.availableCash || 0));

        let totalValue = 0;
        let totalInvested = 0;

        const holdingLines = (portfolio.holdings || []).map(h => {
          const invested = h.quantity * parseFloat(h.avgPrice);
          const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
          const pl = current - invested;
          const plPercent = invested > 0 ? (pl / invested) * 100 : 0;

          totalValue += current;
          totalInvested += invested;

          return `*${h.symbol}*: ${h.quantity} @ ${formatPrice(h.avgPrice)}
P&L: ${formatPrice(pl)} (${formatPercent(plPercent)})`;
        }).join('\n\n');

        const totalPL = totalValue - totalInvested;
        const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

        // Profile completeness check
        const missingFields = [];
        if (!portfolio.riskProfile) missingFields.push('risk profile');
        if (!portfolio.investmentGoal) missingFields.push('investment goal');
        if (!portfolio.investmentExperience) missingFields.push('experience level');
        if (!portfolio.age) missingFields.push('age');
        const completenessNote = missingFields.length > 0
          ? `\n⚠️ _Missing: ${missingFields.join(', ')}. Update on web for better AI picks._`
          : '';

        const detailMsg = `💼 *${portfolio.ownerName || portfolio.name}* - ${(portfolio.broker || 'Unknown').replace(/_/g, ' ')}
━━━━━━━━━━━━━━━━━━━
Risk: ${risk} | Goal: ${goal}
Experience: ${experience}
Capital: ${capital} | Cash: ${cash}
Value: ${formatPrice(totalValue)}
P&L: ${formatPrice(totalPL)} (${formatPercent(totalPLPercent)})${completenessNote}

━━━━━━━━━━━━━━━━━━━
*Holdings (${(portfolio.holdings || []).length}):*

${holdingLines || '(No holdings yet)'}`;

        await botInstance.sendMessage(msg.chat.id, detailMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Portfolio detail error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Failed to fetch portfolio details').catch(() => {});
      }
    });

    // /portfolio (legacy — all holdings)
    botInstance.onText(/^\/portfolio$/, async (msg) => {
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const portfolios = await getUserPortfolios(telegramUser.user.id);
        const allHoldings = portfolios.flatMap(p =>
          (p.holdings || []).map(h => ({ ...h, portfolioName: p.ownerName || p.name }))
        );

        if (allHoldings.length === 0) {
          await botInstance.sendMessage(msg.chat.id, '📭 Portfolio empty. Add some holdings first!');
          return;
        }

        let totalValue = 0;
        let totalInvested = 0;

        const lines = allHoldings.map(h => {
          const invested = h.quantity * parseFloat(h.avgPrice);
          const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
          const pl = current - invested;
          const plPercent = (pl / invested) * 100;

          totalValue += current;
          totalInvested += invested;

          return `*${h.symbol}*: ${h.quantity} @ ${formatPrice(h.avgPrice)}\nP&L: ${formatPrice(pl)} (${formatPercent(plPercent)})`;
        }).join('\n\n');

        const totalPL = totalValue - totalInvested;
        const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

        const portfolioMsg = `💼 *ALL HOLDINGS*
━━━━━━━━━━━━━━━━━━━
Value: ${formatPrice(totalValue)}
Invested: ${formatPrice(totalInvested)}
P&L: ${formatPrice(totalPL)} (${formatPercent(totalPLPercent)})

━━━━━━━━━━━━━━━━━━━
${lines}

━━━━━━━━━━━━━━━━━━━
Use /portfolios for per-portfolio view`;

        await botInstance.sendMessage(msg.chat.id, portfolioMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Portfolio error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Failed to fetch portfolio').catch(() => {});
      }
    });

    // /recommend [N] — AI recommendations for specific portfolio
    botInstance.onText(/^\/recommend(?:\s+(\d+))?$/, async (msg, match) => {
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const index = match[1] ? parseInt(match[1]) : null;

        let portfolio = null;
        if (index) {
          portfolio = await getPortfolioByIndex(telegramUser.user.id, index);
          if (!portfolio) {
            await botInstance.sendMessage(msg.chat.id, `❌ Portfolio #${index} not found. Use /portfolios to see your list.`);
            return;
          }
        }

        const label = portfolio ? portfolioLabel(portfolio) : 'generic';
        await botInstance.sendMessage(msg.chat.id, `🔍 Getting AI recommendations${portfolio ? ' for ' + (portfolio.ownerName || portfolio.name) : ''}...`);

        const opportunities = await scanMarketForOpportunities({
          portfolio: portfolio || undefined,
          targetCount: { high: 3, medium: 3, low: 3 },
          baseAmount: portfolio ? parseFloat(portfolio.availableCash || 10000) : 10000
        });

        const scanMsg = `✅ *AI Recommendations*${portfolio ? '\n📁 ' + label : ''}

🔥 *High Risk (${(opportunities.high || []).length}):*
${(opportunities.high || []).map(s => `• ${s.symbol} - ${formatPrice(s.price)} ${s.reason ? '— ' + s.reason : ''}`).join('\n') || '(none)'}

⚡ *Medium Risk (${(opportunities.medium || []).length}):*
${(opportunities.medium || []).map(s => `• ${s.symbol} - ${formatPrice(s.price)} ${s.reason ? '— ' + s.reason : ''}`).join('\n') || '(none)'}

🛡️ *Low Risk (${(opportunities.low || []).length}):*
${(opportunities.low || []).map(s => `• ${s.symbol} - ${formatPrice(s.price)} ${s.reason ? '— ' + s.reason : ''}`).join('\n') || '(none)'}

Use /price [SYMBOL] for details!`;

        await botInstance.sendMessage(msg.chat.id, scanMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Recommend error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Recommendation failed').catch(() => {});
      }
    });

    // /multi [N] — Multi-asset recommendations for a portfolio
    botInstance.onText(/^\/multi(?:\s+(\d+))?$/, async (msg, match) => {
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const index = match[1] ? parseInt(match[1]) : null;

        let portfolio = null;
        if (index) {
          portfolio = await getPortfolioByIndex(telegramUser.user.id, index);
          if (!portfolio) {
            await botInstance.sendMessage(msg.chat.id, `❌ Portfolio #${index} not found. Use /portfolios to see your list.`);
            return;
          }
        }

        await botInstance.sendMessage(msg.chat.id, `📊 Generating multi-asset allocation${portfolio ? ' for ' + (portfolio.ownerName || portfolio.name) : ''}...`);

        const result = await generateMultiAssetRecommendations({
          portfolio: portfolio || undefined,
          capital: portfolio ? parseFloat(portfolio.availableCash || 100000) : 100000,
          riskProfile: portfolio?.riskProfile || 'BALANCED',
          timeHorizon: 'MEDIUM'
        });

        // Format the multi-asset response
        let responseMsg = `📊 *Multi-Asset Allocation*${portfolio ? '\n📁 ' + portfolioLabel(portfolio) : ''}\n`;

        if (result.recommendations) {
          // result.recommendations is the AI text
          responseMsg += `\n${result.recommendations}`;
        } else if (result.allocation) {
          responseMsg += `\n${JSON.stringify(result.allocation, null, 2)}`;
        } else {
          responseMsg += `\n${typeof result === 'string' ? result : JSON.stringify(result)}`;
        }

        // Telegram has a 4096 char limit
        if (responseMsg.length > 4000) {
          responseMsg = responseMsg.substring(0, 3997) + '...';
        }

        await botInstance.sendMessage(msg.chat.id, responseMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Multi-asset error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Multi-asset analysis failed').catch(() => {});
      }
    });

    // /scan [N] — Market scan (optionally personalized to portfolio)
    botInstance.onText(/^\/scan(?:\s+(\d+))?$/, async (msg, match) => {
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const index = match[1] ? parseInt(match[1]) : null;

        let portfolio = null;
        if (index) {
          portfolio = await getPortfolioByIndex(telegramUser.user.id, index);
          if (!portfolio) {
            await botInstance.sendMessage(msg.chat.id, `❌ Portfolio #${index} not found. Use /portfolios to see your list.`);
            return;
          }
        }

        await botInstance.sendMessage(msg.chat.id, `🔍 Scanning market${portfolio ? ' for ' + (portfolio.ownerName || portfolio.name) : ''}...`);

        const opportunities = await scanMarketForOpportunities({
          portfolio: portfolio || undefined,
          targetCount: { high: 3, medium: 3, low: 3 },
          baseAmount: portfolio ? parseFloat(portfolio.availableCash || 10000) : 10000
        });

        const scanMsg = `✅ *Scan Complete!*${portfolio ? '\n📁 ' + portfolioLabel(portfolio) : ''}

🔥 *High Risk (${(opportunities.high || []).length}):*
${(opportunities.high || []).map(s => `• ${s.symbol} - ${formatPrice(s.price)}`).join('\n') || '(none)'}

⚡ *Medium Risk (${(opportunities.medium || []).length}):*
${(opportunities.medium || []).map(s => `• ${s.symbol} - ${formatPrice(s.price)}`).join('\n') || '(none)'}

🛡️ *Low Risk (${(opportunities.low || []).length}):*
${(opportunities.low || []).map(s => `• ${s.symbol} - ${formatPrice(s.price)}`).join('\n') || '(none)'}

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

    // /auth — Get Upstox login link to refresh token
    botInstance.onText(/^\/auth$/, async (msg) => {
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const userId = telegramUser.user.id;

        // Check if user has Upstox integration
        const integration = await prisma.upstoxIntegration.findUnique({
          where: { userId }
        });

        if (!integration || !integration.apiKey) {
          await botInstance.sendMessage(msg.chat.id,
            '❌ No Upstox API key configured. Set it up in the web app first.',
            { parse_mode: 'Markdown' });
          return;
        }

        // Check if token is still valid
        const valid = await isTokenValid(userId);
        if (valid) {
          await botInstance.sendMessage(msg.chat.id,
            '✅ Upstox token is still valid! No need to re-authenticate.',
            { parse_mode: 'Markdown' });
          return;
        }

        const authUrl = await getAuthorizationUrl(userId);
        await botInstance.sendMessage(msg.chat.id,
          `🔐 *Upstox Authentication Required*\n\nYour token has expired. Click below to login:\n\n[Login to Upstox](${authUrl})\n\nAfter login, you'll be redirected back and your token will be refreshed automatically.`,
          { parse_mode: 'Markdown', disable_web_page_preview: true });
      } catch (error) {
        logger.error('Auth command error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Failed to generate auth link').catch(() => {});
      }
    });

    // ============================================
    // CALLBACK QUERIES (Inline Button Handlers)
    // Signal ACK/SNOOZE/DISMISS buttons
    // ============================================

    botInstance.on('callback_query', async (query) => {
      try {
        const data = query.data;
        if (!data || !data.startsWith('sig_')) return;

        const parts = data.split('_');
        // Format: sig_ack_123, sig_snooze_123, sig_dismiss_123, sig_exec_123
        if (parts.length < 3) return;

        const action = parts[1]; // ack, snooze, dismiss, exec
        const signalId = parseInt(parts[2]);
        if (!signalId) return;

        // Handle Execute action separately (places Upstox order)
        if (action === 'exec') {
          await handleExecuteSignal(botInstance, query, signalId);
          return;
        }

        // Handle "Place as MARKET order" (after price validation failure)
        if (action === 'mkt') {
          await handleExecuteMarketFallback(botInstance, query, signalId);
          return;
        }

        const actionMap = {
          'ack': { status: 'ACKED', dbAction: 'ACK', label: 'Acknowledged' },
          'snooze': { status: 'SNOOZED', dbAction: 'SNOOZE_30M', label: 'Snoozed 30m' },
          'dismiss': { status: 'DISMISSED', dbAction: 'DISMISS', label: 'Dismissed' }
        };

        const mapped = actionMap[action];
        if (!mapped) return;

        // Update signal status
        await prisma.tradeSignal.update({
          where: { id: signalId },
          data: { status: mapped.status }
        });

        // Create ack record
        await prisma.signalAck.create({
          data: {
            signalId,
            action: mapped.dbAction,
            note: `Via Telegram by ${query.from.first_name || query.from.id}`
          }
        });

        // Answer the callback (removes loading spinner on button)
        await botInstance.answerCallbackQuery(query.id, {
          text: `Signal ${mapped.label}`
        });

        // Edit the original message to show it's been handled
        const emoji = action === 'ack' ? '✅' : action === 'snooze' ? '⏰' : '❌';
        try {
          await botInstance.editMessageReplyMarkup(
            { inline_keyboard: [[{ text: `${emoji} ${mapped.label}`, callback_data: 'noop' }]] },
            { chat_id: query.message.chat.id, message_id: query.message.message_id }
          );
        } catch (editErr) {
          // Message might be too old to edit, that's OK
          logger.warn('Could not edit signal message:', editErr.message);
        }
      } catch (error) {
        logger.error('Callback query error:', error);
        try {
          await botInstance.answerCallbackQuery(query.id, { text: 'Error processing action' });
        } catch (e) {
          // ignore
        }
      }
    });

    logger.info('Telegram bot commands registered successfully');
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

export { getBot };
export default getBot();

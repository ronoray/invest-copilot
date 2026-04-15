import TelegramBot from 'node-telegram-bot-api';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import logger from './logger.js';
import { getCurrentPrice } from './marketData.js';
import { getUpstoxLTP } from './upstoxMarketData.js';
import { scanMarketForOpportunities, buildProfileBrief } from './advancedScreener.js';
import { generateMultiAssetRecommendations } from './multiAssetRecommendations.js';
import { placeOrder, getAuthorizationUrl, isTokenValid, getFunds, getHoldings, getPositions, getOrderBook } from './upstoxService.js';
import { preOrderCapitalCheck, syncUpstoxFunds, syncUpstoxHoldings, getEffectiveCash, pollOrderUntilSettled } from './capitalGuard.js';
import { generateTradeSignals } from './signalGenerator.js';
import { getSystemPauseState, setPauseState, clearPauseState } from './pauseState.js';

const prisma = new PrismaClient();

// NSE equity tick size = ₹0.05. Round sell limits DOWN, buy limits UP.
function roundToTick(price, direction = 'down', tick = 0.05) {
  if (direction === 'down') return Math.floor(Math.round(price / tick * 1e9) / 1e9) * tick;
  return Math.ceil(Math.round(price / tick * 1e9) / 1e9) * tick;
}

// Create bot instance ONLY ONCE
let bot = null;
let _pollingRestartTimer = null;
let _pollingStabilityTimer = null;
let _pollingWatchdog = null;
let _pollingRestartDelay = 5000; // start at 5s, backs off to 60s max
let _consecutivePollingErrors = 0;
let _lastPollActivityAt = null; // updated on any incoming message or callback

function _markPollActivity() {
  _lastPollActivityAt = Date.now();
}

function _startPolling(delayMs = 0) {
  if (!bot) return;
  clearTimeout(_pollingRestartTimer);
  clearTimeout(_pollingStabilityTimer);
  _pollingRestartTimer = setTimeout(async () => {
    try {
      if (bot.isPolling()) {
        await bot.stopPolling().catch(() => {});
      }
    } catch (_) {}
    try {
      if (typeof bot.deleteWebHook === 'function') {
        await bot.deleteWebHook().catch(() => {});
      }
    } catch (_) {}
    try {
      bot.startPolling({
        interval: 1000,
        params: { timeout: 10, allowed_updates: ['message', 'callback_query'] }
      });
      logger.info('Telegram bot polling started');
      _lastPollActivityAt = Date.now();
      // Only reset backoff after 30s of stable polling — not on the start() call itself
      _pollingStabilityTimer = setTimeout(() => {
        _pollingRestartDelay = 5000;
        _consecutivePollingErrors = 0;
        logger.info('[Telegram] Polling stable — backoff reset');
      }, 30000);
    } catch (e) {
      logger.error('Failed to start Telegram polling:', e.message);
      _consecutivePollingErrors++;
      _pollingRestartDelay = Math.min(_pollingRestartDelay * 2, 60000);
      _startPolling(_pollingRestartDelay);
    }
  }, delayMs);
}

function _startPollingWatchdog() {
  clearInterval(_pollingWatchdog);
  _pollingWatchdog = setInterval(async () => {
    if (!bot) return;
    if (!bot.isPolling()) {
      logger.warn('[Telegram] Polling watchdog: polling stopped — restarting');
      _pollingRestartDelay = 5000;
      _consecutivePollingErrors = 0;
      _startPolling(1000);
      return;
    }
    // Active health check: getMe() proves the bot can reach Telegram API
    // If this fails while isPolling() is true, polling has silently died
    try {
      await bot.getMe();
      _markPollActivity();
    } catch (e) {
      logger.warn(`[Telegram] Polling watchdog: getMe() failed (${e.message}) — restarting`);
      _pollingRestartDelay = 5000;
      _consecutivePollingErrors = 0;
      _startPolling(1000);
    }
  }, 2 * 60 * 1000); // check every 2 minutes
}

function getBot() {
  if (!bot && process.env.TELEGRAM_BOT_TOKEN) {
    try {
      // Init without polling first so we can send messages immediately
      bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

      // Self-healing polling error handler — restarts polling with exponential backoff
      bot.on('polling_error', (error) => {
        const msg = error?.message || String(error) || 'unknown';
        // 409 = previous instance still polling; resolves automatically
        if (msg.includes('409')) return;
        _consecutivePollingErrors++;
        logger.error(`Telegram polling error #${_consecutivePollingErrors} — will restart:`, msg);
        // If we've failed 15+ times in a row, exit and let Docker restart clean
        if (_consecutivePollingErrors >= 15) {
          logger.error('[Telegram] Too many consecutive polling errors — exiting for clean Docker restart');
          process.exit(1);
        }
        clearTimeout(_pollingStabilityTimer);
        _pollingRestartDelay = Math.min(_pollingRestartDelay * 2, 60000);
        _startPolling(_pollingRestartDelay);
      });

      bot.on('error', (error) => {
        logger.error('Telegram error:', error?.message || String(error));
      });

      // Delay initial polling start by 15s — gives previous container's 10s long-poll time to expire
      // This eliminates the 409 Conflict on every restart/deploy.
      _startPolling(15000);

      // Watchdog: restart polling if it silently dies
      _startPollingWatchdog();
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
// ORDER POLLING AFTER PLACEMENT (Telegram wrapper)
// ============================================

function pollOrderViaTelegram(botInstance, chatId, userId, signalId, signal, orderId, dbOrderId) {
  return pollOrderUntilSettled({
    userId, orderId, dbOrderId, signalId, signal,
    onSuccess: async ({ averagePrice }) => {
      const avgPrice = averagePrice ? ` @ ${formatPrice(averagePrice)}` : '';
      const successMsg = `✅ *ORDER CONFIRMED*\n\n${signal.side} ${signal.quantity}x *${signal.symbol}*${avgPrice}\nOrder ID: \`${orderId}\`\n\n_Exchange confirmed. Position is live._`;

      try {
        await botInstance.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: `✅ Confirmed — ${orderId}`, callback_data: 'noop' }]] },
          { chat_id: chatId, message_id: signal._messageId }
        );
      } catch (e) { /* message may be old */ }

      await botInstance.sendMessage(chatId, successMsg, { parse_mode: 'Markdown' });
    },
    onFailure: async ({ status, reason }) => {
      const failureMsg = `🔴 *Order ${status.toUpperCase()}*\n\n${signal.side} ${signal.symbol} @ ${formatPrice(signal.triggerPrice || signal.triggerLow || 0)}\nReason: _${reason}_\n\nSignal reset — choose how to proceed:`;

      try {
        await botInstance.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: `🔴 ${status.toUpperCase()} — reset`, callback_data: 'noop' }]] },
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
    },
    onTimeout: async () => {
      // Sync capital from Upstox so DB availableCash reflects the blocked margin
      // for this PLACING order. Without this, getEffectiveCash() sees stale cash
      // and can generate duplicate signals for the same stock with no real capital.
      syncUpstoxFunds(userId).catch(e => logger.warn(`[onTimeout] Fund sync failed for signal #${signalId}:`, e.message));

      await botInstance.sendMessage(chatId,
        `⏳ *Order Pending*\n\n${signal.side} ${signal.quantity}x *${signal.symbol}*\nOrder ID: \`${orderId}\`\n\n_Exchange hasn't confirmed yet. I'll keep monitoring and alert you when it settles._`,
        { parse_mode: 'Markdown' }
      );
    }
  });
}

// ============================================
// EXECUTE SIGNAL VIA UPSTOX
// ============================================

// Release atomic lock — reset PLACING → PENDING. Called before any early return inside
// handleExecuteSignal / handleExecuteMarketFallback after the lock was taken.
async function releaseLock(signalId) {
  await prisma.tradeSignal.updateMany({
    where: { id: signalId, status: 'PLACING' },
    data: { status: 'PENDING', upstoxOrderId: null }
  }).catch(e => logger.error(`releaseLock failed for signal #${signalId}:`, e.message));
}

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

    if (signal.status === 'EXECUTED') {
      await botInstance.answerCallbackQuery(query.id, { text: 'Already executed' }).catch(() => {});
      return;
    }
    if (signal.status === 'PLACING') {
      await botInstance.answerCallbackQuery(query.id, { text: 'Order already placed — waiting to fill' }).catch(() => {});
      const orderRef = signal.upstoxOrderId ? ` (Upstox order #${signal.upstoxOrderId})` : '';
      const limitNote = signal.triggerPrice
        ? `\n\nThis is a *LIMIT order at ₹${signal.triggerPrice}*. It will fill automatically when the market price drops to that level. No action needed — Upstox is watching it.\n\nTo cancel: dismiss this signal, then cancel the order in your Upstox app.`
        : '';
      await botInstance.sendMessage(chatId,
        `⏳ *${signal.symbol} Order Already Open*${orderRef}\n\nYour ${signal.side} order for ${signal.quantity}× ${signal.symbol} is sitting open on Upstox — it was placed earlier and is waiting to fill.${limitNote}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
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

    // ATOMIC LOCK: set status to PLACING only if still in an actionable state.
    // This prevents race conditions from double-taps or concurrent callbacks placing two orders.
    // If count === 0, another request already locked it — abort.
    const locked = await prisma.tradeSignal.updateMany({
      where: { id: signalId, status: { in: ['PENDING', 'ACKED', 'SNOOZED'] } },
      data: { status: 'PLACING' }
    });
    if (locked.count === 0) {
      await botInstance.answerCallbackQuery(query.id, { text: 'Already processing — please wait' }).catch(() => {});
      return;
    }

    // From this point we own the signal exclusively. Any error must reset it to PENDING.
    // Show processing state
    await botInstance.answerCallbackQuery(query.id, { text: 'Placing order...' }).catch(() => {})
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

    // Validate LIMIT price against live Upstox market price
    if (orderType === 'LIMIT' && price > 0) {
      try {
        let currentPrice = null;
        // Prefer Upstox LTP (real-time); fall back to Alpha Vantage / NSE scraper
        try {
          const ltpMap = await getUpstoxLTP([signal.symbol]);
          const ltpData = ltpMap.get(signal.symbol);
          if (ltpData?.price > 0) currentPrice = ltpData.price;
        } catch (_) { /* fall through */ }
        if (!currentPrice) {
          const liveData = await getCurrentPrice(signal.symbol, signal.exchange);
          currentPrice = liveData?.price || liveData?.lastPrice || null;
        }

        if (currentPrice && currentPrice > 0) {
          const deviation = Math.abs(price - currentPrice) / currentPrice;
          if (deviation > 0.40) {
            logger.warn(`Signal #${signalId} price validation: signal=₹${price}, market=₹${currentPrice}, deviation=${(deviation * 100).toFixed(1)}% — offering live-price LIMIT`);
            // Signal price is stale/hallucinated. Offer to execute at live price instead.
            const liveLimit = roundToTick(currentPrice * 0.999, 'down'); // 0.1% below LTP, tick-aligned
            // Store live price in DB for the Force LIMIT handler
            await prisma.tradeSignal.update({
              where: { id: signalId },
              data: { triggerHigh: liveLimit } // reuse triggerHigh as live-price anchor
            });
            await botInstance.editMessageReplyMarkup(
              { inline_keyboard: [
                [{ text: `✅ Execute @ ₹${liveLimit.toFixed(2)} (live price)`, callback_data: `sig_mkt_${signalId}` }],
                [{ text: '🚫 Dismiss', callback_data: `sig_dismiss_${signalId}` }]
              ] },
              { chat_id: chatId, message_id: messageId }
            ).catch(() => {});
            await botInstance.sendMessage(chatId,
              `⚠️ *Stale Signal Price Corrected*\n\nAI signal price: ₹${price.toFixed(2)}\nLive price (Upstox): ₹${currentPrice.toFixed(2)}\nDeviation: ${(deviation * 100).toFixed(1)}%\n\n_The AI used outdated training data for this price. Tap above to execute a LIMIT order at the current live price (₹${liveLimit.toFixed(2)}). It will fill immediately at market or better._`,
              { parse_mode: 'Markdown' }
            );
            // Release lock so sig_mkt_ can re-acquire it
            await releaseLock(signalId);
            return;
          }
        }
      } catch (priceErr) {
        logger.warn(`Could not validate price for signal #${signalId}: ${priceErr.message}`);
        // Continue with order — better to try than to block on price fetch failure
      }
    }

    // Sync Upstox funds before capital check (ensures real-time cash)
    try {
      await syncUpstoxFunds(userId);
    } catch (syncErr) {
      logger.warn(`Pre-execution fund sync failed for signal #${signalId}: ${syncErr.message}`);
    }

    // DDPI: For SELL orders, do a live holdings sync to catch mid-day sells
    if (signal.side === 'SELL') {
      try {
        await syncUpstoxHoldings(userId);
        logger.info(`Pre-SELL holdings sync completed for signal #${signalId}`);
      } catch (syncErr) {
        logger.warn(`Pre-SELL holdings sync failed (non-blocking) for signal #${signalId}: ${syncErr.message}`);
      }

      // Re-verify holding from freshly synced DB
      const freshHolding = await prisma.holding.findFirst({
        where: { portfolioId: signal.portfolioId, symbol: signal.symbol }
      });
      if (!freshHolding || freshHolding.quantity <= 0) {
        await prisma.tradeSignal.update({ where: { id: signalId }, data: { status: 'EXPIRED' } });
        await botInstance.editMessageReplyMarkup(
          { inline_keyboard: [[{ text: '⚠️ Already Sold', callback_data: 'noop' }]] },
          { chat_id: chatId, message_id: messageId }
        ).catch(() => {});
        await botInstance.sendMessage(chatId,
          `⚠️ *Signal Expired*\n\n${signal.symbol} is no longer in your holdings — it may have already been sold. Signal has been expired.`,
          { parse_mode: 'Markdown' }
        );
        return;
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
        const capitalCheck = await preOrderCapitalCheck(signal.portfolioId, 'BUY', signal.quantity, estimatedPrice, signalId);
        if (!capitalCheck.allowed) {
          // Try to reduce quantity to what we can actually afford
          const affordableQty = estimatedPrice > 0 ? Math.floor(capitalCheck.effectiveCash / estimatedPrice) : 0;
          if (affordableQty >= 1) {
            logger.info(`Signal #${signalId} qty reduced at execution: ${signal.quantity}→${affordableQty} (effective=₹${capitalCheck.effectiveCash.toFixed(0)}, price=₹${estimatedPrice.toFixed(0)})`);
            signal.quantity = affordableQty;
            // Persist so future checks and the order use the same qty
            await prisma.tradeSignal.update({ where: { id: signalId }, data: { quantity: affordableQty } });
          } else {
            // Can't afford even 1 share — reset lock and block
            await prisma.tradeSignal.updateMany({
              where: { id: signalId, status: 'PLACING' },
              data: { status: 'PENDING', upstoxOrderId: null }
            }).catch(() => {});
            logger.warn(`Signal #${signalId} blocked — cannot afford even 1 share at ₹${estimatedPrice.toFixed(0)} with ₹${capitalCheck.effectiveCash.toFixed(0)} available`);
            await botInstance.editMessageReplyMarkup(
              { inline_keyboard: [[{ text: '🚫 Dismiss', callback_data: `sig_dismiss_${signalId}` }]] },
              { chat_id: chatId, message_id: messageId }
            ).catch(() => {});
            await botInstance.sendMessage(chatId,
              `💰 *Insufficient Capital*\n\n${signal.symbol} @ ₹${estimatedPrice.toFixed(0)}/share\nAvailable: ₹${capitalCheck.effectiveCash.toLocaleString('en-IN')}\n\n_Not enough capital to buy even 1 share. Free up capital by dismissing other pending signals._`,
              { parse_mode: 'Markdown' }
            );
            return;
          }
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

    // Record the Upstox order ID (already PLACING from the atomic lock above)
    await prisma.tradeSignal.update({
      where: { id: signalId },
      data: { upstoxOrderId: result.dbOrderId }
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
    pollOrderViaTelegram(botInstance, chatId, userId, signalId, signal, result.orderId, result.dbOrderId)
      .catch(err => logger.error(`Polling failed for signal #${signalId}:`, err));
  } catch (error) {
    logger.error(`Failed to execute signal #${signalId}:`, error);

    // We took ownership via atomic lock — must reset to PENDING so the user can retry
    await prisma.tradeSignal.updateMany({
      where: { id: signalId, status: 'PLACING' },
      data: { status: 'PENDING', upstoxOrderId: null }
    }).catch(e => logger.error(`Could not reset signal #${signalId} after failure:`, e.message));

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

// Handle "Execute at live price" after large price deviation warning
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

    // ATOMIC LOCK — same as handleExecuteSignal to prevent double-tap race conditions
    const locked = await prisma.tradeSignal.updateMany({
      where: { id: signalId, status: { in: ['PENDING', 'ACKED', 'SNOOZED'] } },
      data: { status: 'PLACING' }
    });
    if (locked.count === 0) {
      await botInstance.answerCallbackQuery(query.id, { text: 'Already processing — please wait' }).catch(() => {});
      return;
    }

    await botInstance.answerCallbackQuery(query.id, { text: 'Placing order at live price...' }).catch(() => {});
    await botInstance.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: '⏳ Placing order at live price...', callback_data: 'noop' }]] },
      { chat_id: chatId, message_id: messageId }
    ).catch(() => {});

    // Sync Upstox funds before capital check (ensures real-time cash)
    try {
      await syncUpstoxFunds(userId);
    } catch (syncErr) {
      logger.warn(`Pre-execution fund sync failed for live-price signal #${signalId}: ${syncErr.message}`);
    }

    // Resolve execution price:
    // triggerHigh was set by handleExecuteSignal as the live-price anchor when deviation > 40%.
    // If not set (e.g. old signal), fall back to fresh Upstox LTP.
    let execPrice = signal.triggerHigh ? parseFloat(signal.triggerHigh) : 0;
    if (!execPrice || execPrice <= 0) {
      try {
        const ltpMap = await getUpstoxLTP([signal.symbol]);
        const ltp = ltpMap.get(signal.symbol);
        if (ltp?.price > 0) execPrice = roundToTick(ltp.price * 0.999, 'down'); // tick-aligned
      } catch (_) {}
    }
    if (!execPrice || execPrice <= 0) {
      await releaseLock(signalId);
      await botInstance.sendMessage(chatId, `❌ Cannot determine live price for ${signal.symbol}. Please dismiss and re-generate signals.`, { parse_mode: 'Markdown' });
      return;
    }

    // Capital check for BUY orders using live price
    if (signal.side === 'BUY') {
      const capitalCheck = await preOrderCapitalCheck(signal.portfolioId, 'BUY', signal.quantity, execPrice, signalId);
      if (!capitalCheck.allowed) {
        const affordableQty = execPrice > 0 ? Math.floor(capitalCheck.effectiveCash / execPrice) : 0;
        if (affordableQty >= 1) {
          logger.info(`Signal #${signalId} qty reduced at execution (market fallback): ${signal.quantity}→${affordableQty}`);
          signal.quantity = affordableQty;
          await prisma.tradeSignal.update({ where: { id: signalId }, data: { quantity: affordableQty } });
        } else {
          await prisma.tradeSignal.updateMany({
            where: { id: signalId, status: 'PLACING' },
            data: { status: 'PENDING', upstoxOrderId: null }
          }).catch(() => {});
          logger.warn(`Signal #${signalId} blocked (market fallback) — cannot afford 1 share at ₹${execPrice.toFixed(0)}`);
          await botInstance.editMessageReplyMarkup(
            { inline_keyboard: [[{ text: '🚫 Dismiss', callback_data: `sig_dismiss_${signalId}` }]] },
            { chat_id: chatId, message_id: messageId }
          ).catch(() => {});
          await botInstance.sendMessage(chatId,
            `💰 *Insufficient Capital*\n\n${signal.symbol} @ ₹${execPrice.toFixed(0)}/share\nAvailable: ₹${capitalCheck.effectiveCash.toLocaleString('en-IN')}\n\n_Not enough for even 1 share._`,
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
      orderType: 'LIMIT',
      quantity: signal.quantity,
      price: execPrice,
      triggerPrice: 0,
      portfolioId: signal.portfolioId
    };

    logger.info(`Executing signal #${signalId} at live price ₹${execPrice}:`, orderParams);

    const result = await placeOrder(userId, orderParams);

    // Record order ID (already PLACING from atomic lock above)
    await prisma.tradeSignal.update({
      where: { id: signalId },
      data: { upstoxOrderId: result.dbOrderId }
    });

    await prisma.signalAck.create({
      data: {
        signalId,
        action: 'EXECUTE',
        note: `Live-price LIMIT @ ₹${execPrice} (stale signal price corrected) ${result.orderId} placed via Telegram by ${query.from.first_name || query.from.id}`
      }
    });

    try {
      await botInstance.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: `⏳ Verifying LIMIT order ${result.orderId}...`, callback_data: 'noop' }]] },
        { chat_id: chatId, message_id: messageId }
      );
    } catch (editErr) {
      logger.warn('Could not edit signal message after live-price execute:', editErr.message);
    }

    await botInstance.sendMessage(chatId,
      `📡 *Order Placed at Live Price*\n${signal.side} ${signal.quantity}x ${signal.symbol} @ ₹${execPrice.toFixed(2)}\nOrder ID: \`${result.orderId}\`\n_LIMIT order at current market price — should fill immediately. Verifying with exchange..._`,
      { parse_mode: 'Markdown' }
    );

    // Poll for settlement
    signal._messageId = messageId;
    pollOrderViaTelegram(botInstance, chatId, userId, signalId, signal, result.orderId, result.dbOrderId)
      .catch(err => logger.error(`Polling failed for live-price signal #${signalId}:`, err));
  } catch (error) {
    logger.error(`Failed to execute live-price order for signal #${signalId}:`, error);

    // We took ownership via atomic lock — must reset to PENDING so the user can retry
    await prisma.tradeSignal.updateMany({
      where: { id: signalId, status: 'PLACING' },
      data: { status: 'PENDING', upstoxOrderId: null }
    }).catch(e => logger.error(`Could not reset signal #${signalId} after failure:`, e.message));

    const errorMsg = error.message || 'Unknown error';
    await botInstance.sendMessage(chatId, `❌ *Order Failed*\nSignal #${signalId}: ${errorMsg}`, { parse_mode: 'Markdown' });
  }
}

// ============================================
// PAUSE / RESUME BRIEFING
// ============================================

async function generateResumeBriefing(pauseState) {
  const pausedAt = new Date(pauseState.pausedAt);
  const durationMin = Math.round((Date.now() - pausedAt.getTime()) / 60000);
  const durationText = durationMin < 60
    ? `${durationMin} min`
    : `${Math.round(durationMin / 60)}h ${durationMin % 60}m`;

  // Gather data generated during the pause
  const pendingSignals = await prisma.tradeSignal.findMany({
    where: {
      status: { in: ['PENDING', 'SNOOZED'] },
      createdAt: { gte: pausedAt }
    },
    include: { portfolio: { select: { ownerName: true, name: true } } }
  });

  const expiredDuringPause = await prisma.tradeSignal.findMany({
    where: {
      status: 'EXPIRED',
      updatedAt: { gte: pausedAt }
    },
    select: { symbol: true, side: true, confidence: true, triggerPrice: true }
  });

  const pendingList = pendingSignals.map(s => {
    const px = s.triggerPrice ? ` @ ₹${parseFloat(s.triggerPrice).toFixed(0)}` : '';
    return `${s.side} ${s.quantity}x ${s.symbol}${px} (${s.confidence}% conf) — ${s.portfolio?.ownerName || s.portfolio?.name}`;
  }).join('\n');

  const expiredList = expiredDuringPause.map(s =>
    `${s.side} ${s.symbol} (${s.confidence}% conf)`
  ).join('\n');

  try {
    const anthropic = new Anthropic({
      apiKey: process.env.CLAUDE_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      defaultHeaders: { 'x-caller-id': 'invest-copilot', 'x-feature-name': 'telegram_bot' },
    });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are an investment assistant. The user just resumed their Invest Co-Pilot system after being away.

Pause details:
- Duration: ${durationText}
- Reason: ${pauseState.reason}
- Paused at: ${pausedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

Signals generated while paused (still actionable):
${pendingList || '(none)'}

Signals that expired while paused (missed opportunities):
${expiredList || '(none)'}

Write a concise, friendly resume briefing (max 200 words) in Telegram Markdown format.
- Acknowledge the pause reason intelligently
- Summarize what was missed and what's actionable now
- Prioritize any high-confidence signals
- End with a motivating note
- Use *bold* and _italic_ but avoid headers
- No bullet symbols — use inline text`
      }]
    });
    return response.content[0].text;
  } catch (aiErr) {
    logger.warn('Resume AI briefing failed, using fallback:', aiErr.message);
    // Fallback: structured text briefing
    let msg = `▶️ *Welcome back!* Paused for *${durationText}* (_${pauseState.reason}_)\n\n`;
    if (pendingSignals.length > 0) {
      msg += `📊 *${pendingSignals.length} signal(s) ready to act on:*\n`;
      pendingSignals.forEach(s => {
        const px = s.triggerPrice ? ` @ ₹${parseFloat(s.triggerPrice).toFixed(0)}` : '';
        msg += `${s.side === 'BUY' ? '🟢' : '🔴'} ${s.side} ${s.quantity}x *${s.symbol}*${px} (${s.confidence}% conf)\n`;
      });
      msg += '\n';
    }
    if (expiredDuringPause.length > 0) {
      msg += `⌛ *${expiredDuringPause.length} signal(s) expired* while paused\n\n`;
    }
    if (pendingSignals.length === 0 && expiredDuringPause.length === 0) {
      msg += `_No signals were generated while you were away._\n\n`;
    }
    msg += `_Signal notifications are now active._`;
    return msg;
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

    // Track polling liveness — any incoming update proves polling is alive
    botInstance.on('message', () => _markPollActivity());
    botInstance.on('callback_query', () => _markPollActivity());

    // /start
    botInstance.onText(/^\/start$/, async (msg) => {
      try {
        logger.info(`/start command from ${msg.from.id}`);

        await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);

        const welcomeMsg = `👋 *Investment Co-Pilot*
━━━━━━━━━━━━━━━━━━━

*Portfolio:*
/portfolios — List all portfolios
/portfolio N — View portfolio #N details

*Market & AI:*
/scan N — Market scan for portfolio #N
/recommend N — AI stock picks for portfolio #N
/multi N — Multi-asset allocation for portfolio #N
/price SYMBOL — Live stock price

*Upstox Trading:*
/upstox — Live snapshot (cash, holdings, P&L)
/upstox sync — Reset P&L baseline to current value
/upstox capital N — Set starting capital to ₹N
/upstox withdraw N — Record ₹N sent to bank
/upstox target N — Set profit-taking threshold to N%
/auth — Login to Upstox (refresh daily)

*Signals:*
/signals — Re-send pending signals (viability check)
/regen — Expire stale signals + generate fresh now
/report — Full daily report: P&L, signals, next scans

*System:*
/pause reason — Pause signal generation
/resume — Resume + AI briefing of missed signals
/mute — Disable all alerts
/unmute — Enable alerts
/settings — Alert preferences`;

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
        const helpMsg = `📚 *Invest Co-Pilot — Quick Guide*

━━━━━━━━━━━━━━━━━━━
*🔔 SIGNALS — what the buttons mean*

When you get a signal card, you'll see 3 buttons:

*🚀 Execute* — Places the order on Upstox right now.
  • LIMIT order: sits on the exchange, fills automatically when price reaches the target. Walk away — nothing else to do.
  • MARKET order: executes immediately at current price.

*⏰ Snooze 30m* — Dismiss for 30 minutes, then reminds you again. Use when you want to think about it.

*❌ Dismiss* — Cancel this signal. No order is placed. The system moves on.

━━━━━━━━━━━━━━━━━━━
*📊 WHAT SIGNALS MEAN*

🟢 *BUY signal* — System sees a buy opportunity.
  LIMIT = "buy if price drops to ₹X" (safer, waits for dip)
  MARKET = "buy right now at current price"

🔴 *SELL signal* — System says take profit or cut loss.
  LIMIT = "sell when price rises to ₹X" (locks in gains)
  MARKET = stop-loss triggered — exit immediately

*Confidence bar* ████████░░ 82% — how strongly the system believes in this trade. Below 70% = lower conviction.

━━━━━━━━━━━━━━━━━━━
*💼 KEY COMMANDS*

/upstox — Your live portfolio: total value, cash, open orders, P&L
/portfolio — All holdings with live prices and stop levels
/portfolio 3 — Detailed view of portfolio #3
/regen — Generate fresh signals right now
/signals — Re-send any pending signal cards
/report — Today's summary: trades, P&L, what's next

/auth — Reconnect Upstox (needed daily, done automatically at 9:15 AM)
/upstox sync — Reset your P&L baseline after adding funds
/upstox target N — Set your profit goal (default: 10%)

━━━━━━━━━━━━━━━━━━━
*📡 WHEN TO EXPECT MESSAGES*

• 8:30 AM — Pre-market brief (VIX, FII/DII, gold direction)
• 9:30 AM — Morning signals (buy/sell opportunities)
• 11:00 AM — Midday check (new setups, stop adjustments)
• 1:00 PM — Afternoon signals
• 2:30 PM — Pre-close signals
• Hourly (10 AM–3 PM) — Quick pulse (portfolio P&L update)
• Every 5 min (market hours) — Stop-loss/profit monitoring
• 7:30 PM — Evening playbook (plan for tomorrow)

━━━━━━━━━━━━━━━━━━━
/mute · /unmute · /settings`;

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
          const pausedLabel = p.isPaused ? ' ⏸ *ON HOLD*' : '';
          return `${emoji} *${p.ownerName || p.name}* - ${(p.broker || 'Unknown').replace(/_/g, ' ')}${pausedLabel}
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
        const availCash = parseFloat(portfolio.availableCash || 0);

        // Fetch live LTP for held symbols (Upstox real-time; fallback to DB currentPrice)
        const heldSymbols = (portfolio.holdings || []).map(h => h.symbol).filter(Boolean);
        let liveLTPMap = new Map();
        try {
          if (heldSymbols.length > 0) {
            liveLTPMap = await getUpstoxLTP(heldSymbols);
          }
        } catch (e) {
          logger.warn(`[/portfolio] LTP fetch failed: ${e.message}`);
        }

        // Fetch open LIMIT orders for this portfolio from DB (PLACING = in-flight on Upstox)
        const openSignals = await prisma.tradeSignal.findMany({
          where: { portfolioId: portfolio.id, side: 'BUY', status: 'PLACING' },
          select: { symbol: true, quantity: true, triggerPrice: true }
        });
        const blockedCapital = openSignals.reduce((sum, s) => sum + parseFloat(s.triggerPrice || 0) * s.quantity, 0);

        let totalValue = 0;
        let totalInvested = 0;

        const holdingLines = (portfolio.holdings || []).map(h => {
          const liveEntry = liveLTPMap.get(h.symbol);
          const livePrice = liveEntry?.price || parseFloat(h.currentPrice || h.avgPrice);
          const invested = h.quantity * parseFloat(h.avgPrice);
          const current = h.quantity * livePrice;
          const pl = current - invested;
          const plPercent = invested > 0 ? (pl / invested) * 100 : 0;
          const stopNote = h.stopLoss ? `  Stop: ₹${parseFloat(h.stopLoss).toFixed(2)}` : '';
          const src = liveEntry ? '' : ' _(stale)_';

          totalValue += current;
          totalInvested += invested;

          return `*${h.symbol}*: ${h.quantity} @ ${formatPrice(h.avgPrice)}  →  ₹${livePrice.toFixed(2)}${src}\nP&L: ${formatPrice(pl)} (${formatPercent(plPercent)})${stopNote}`;
        }).join('\n\n');

        const totalPL = totalValue - totalInvested;
        const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;
        const totalPortfolioValue = availCash + blockedCapital + totalValue;

        // Profile completeness check
        const missingFields = [];
        if (!portfolio.riskProfile) missingFields.push('risk profile');
        if (!portfolio.investmentGoal) missingFields.push('investment goal');
        if (!portfolio.investmentExperience) missingFields.push('experience level');
        if (!portfolio.age) missingFields.push('age');
        const completenessNote = missingFields.length > 0
          ? `\n⚠️ _Missing: ${missingFields.join(', ')}. Update on web for better AI picks._`
          : '';

        const pausedNote = portfolio.isPaused ? '\n\n⏸ *ON HOLD* — Signals and alerts disabled for this portfolio.' : '';

        let blockedLine = '';
        if (openSignals.length > 0) {
          const orderDescs = openSignals.map(s => `${s.quantity}×${s.symbol}@₹${parseFloat(s.triggerPrice || 0).toFixed(0)}`).join(', ');
          blockedLine = `\n⏳ *In open orders:* ₹${blockedCapital.toFixed(0)} _(${orderDescs})_`;
        }

        const detailMsg = `💼 *${portfolio.ownerName || portfolio.name}* - ${(portfolio.broker || 'Unknown').replace(/_/g, ' ')}
━━━━━━━━━━━━━━━━━━━
Risk: ${risk} | Goal: ${goal}
Experience: ${experience}
Capital: ${capital} | Cash: ${formatPrice(availCash)}${blockedLine}
*Portfolio Value: ${formatPrice(totalPortfolioValue)}*
Holdings P&L: ${formatPrice(totalPL)} (${formatPercent(totalPLPercent)})${completenessNote}${pausedNote}

━━━━━━━━━━━━━━━━━━━
*Holdings (${(portfolio.holdings || []).length}):*

${holdingLines || '(No holdings yet)'}`;

        await botInstance.sendMessage(msg.chat.id, detailMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error('Portfolio detail error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Failed to fetch portfolio details').catch(() => {});
      }
    });

    // /portfolio — complete picture across all active portfolios
    botInstance.onText(/^\/portfolio$/, async (msg) => {
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const portfolios = await getUserPortfolios(telegramUser.user.id);

        const activePortfolios = portfolios.filter(p => !p.isPaused);
        if (activePortfolios.length === 0) {
          await botInstance.sendMessage(msg.chat.id, '⏸ All portfolios are on hold. Use /portfolios to see status.');
          return;
        }

        // Batch-fetch live LTP for all held symbols across all active portfolios
        const allSymbols = [...new Set(
          activePortfolios.flatMap(p => (p.holdings || []).map(h => h.symbol)).filter(Boolean)
        )];
        let ltpMap = new Map();
        try {
          if (allSymbols.length > 0) ltpMap = await getUpstoxLTP(allSymbols);
        } catch (e) {
          logger.warn(`[/portfolio] LTP fetch failed: ${e.message}`);
        }

        // Fetch open PLACING signals for all active portfolios (blocked capital)
        const portfolioIds = activePortfolios.map(p => p.id);
        const openSignals = await prisma.tradeSignal.findMany({
          where: { portfolioId: { in: portfolioIds }, side: 'BUY', status: 'PLACING' },
          select: { portfolioId: true, symbol: true, quantity: true, triggerPrice: true }
        });
        const blockedByPortfolio = {};
        for (const s of openSignals) {
          blockedByPortfolio[s.portfolioId] = (blockedByPortfolio[s.portfolioId] || 0) +
            parseFloat(s.triggerPrice || 0) * s.quantity;
        }

        const ts = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
        let grandTotal = 0;
        let grandInvested = 0;
        let grandCash = 0;
        let grandBlocked = 0;
        const sections = [];

        for (const p of activePortfolios) {
          const cash      = parseFloat(p.availableCash || 0);
          const blocked   = blockedByPortfolio[p.id] || 0;
          let holdValue   = 0;
          let holdInvested = 0;

          const holdLines = (p.holdings || []).map(h => {
            const liveEntry  = ltpMap.get(h.symbol);
            const livePrice  = liveEntry?.price || parseFloat(h.currentPrice || h.avgPrice);
            const avg        = parseFloat(h.avgPrice);
            const invested   = h.quantity * avg;
            const value      = h.quantity * livePrice;
            const pl         = value - invested;
            const plPct      = invested > 0 ? (pl / invested) * 100 : 0;
            const plSign     = pl >= 0 ? '+' : '';
            const stopNote   = h.stopLoss ? `  🛡 ₹${parseFloat(h.stopLoss).toFixed(2)}` : '';
            const staleMark  = liveEntry ? '' : ' _(stale)_';

            holdValue    += value;
            holdInvested += invested;

            return `  *${h.symbol}* ${h.quantity}×  Avg ₹${avg.toFixed(0)} → ₹${livePrice.toFixed(0)}${staleMark}\n` +
                   `  P&L: ${plSign}₹${Math.abs(pl).toFixed(0)} (${plSign}${plPct.toFixed(1)}%)${stopNote}`;
          }).join('\n');

          const portfolioTotal = cash + blocked + holdValue;
          grandTotal   += portfolioTotal;
          grandInvested += holdInvested;
          grandCash    += cash;
          grandBlocked += blocked;

          const totalPL  = holdValue - holdInvested;
          const totalPct = holdInvested > 0 ? (totalPL / holdInvested) * 100 : 0;
          const plSign   = totalPL >= 0 ? '+' : '';

          let section = `💼 *${p.ownerName || p.name}* (${(p.broker || '').replace(/_/g, ' ')})\n`;
          section += `   Total: *₹${portfolioTotal.toFixed(0)}*  |  Cash: ₹${cash.toFixed(0)}`;
          if (blocked > 0) section += `  |  Orders: ₹${blocked.toFixed(0)}`;
          section += `\n`;
          if (p.holdings?.length > 0) {
            section += `   Holdings P&L: ${plSign}₹${Math.abs(totalPL).toFixed(0)} (${plSign}${totalPct.toFixed(1)}%)\n`;
            section += holdLines;
          } else {
            section += `   _(No holdings)_`;
          }
          sections.push(section);
        }

        const pausedCount = portfolios.length - activePortfolios.length;
        const pausedNote  = pausedCount > 0 ? `\n_${pausedCount} portfolio(s) on hold — use /portfolios_` : '';

        const grandPL    = grandTotal - grandCash - grandBlocked - grandInvested + (grandInvested);
        // Unrealised P&L = holdValue - holdInvested (across all)
        const grandUnreal = grandTotal - grandCash - grandBlocked - grandInvested;
        const unrSign    = grandUnreal >= 0 ? '+' : '';

        let out = `💼 *PORTFOLIO SNAPSHOT*  _${ts} IST_\n`;
        out += `━━━━━━━━━━━━━━━━━━━\n`;
        out += `*Total Value: ₹${grandTotal.toFixed(0)}*\n`;
        out += `Cash: ₹${grandCash.toFixed(0)}`;
        if (grandBlocked > 0) out += `  |  In orders: ₹${grandBlocked.toFixed(0)}`;
        out += `\n`;
        out += `Unrealised P&L: ${unrSign}₹${Math.abs(grandUnreal).toFixed(0)}\n`;
        out += `━━━━━━━━━━━━━━━━━━━\n`;
        out += sections.join('\n━━━━━━━━━━━━━━━━━━━\n');
        out += `\n━━━━━━━━━━━━━━━━━━━\n`;
        out += `_🛡 = trailing stop level_${pausedNote}\n`;
        out += `_/upstox for full live Upstox snapshot_`;

        await botInstance.sendMessage(msg.chat.id, out, { parse_mode: 'Markdown' });
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

        if (portfolio?.isPaused) {
          await botInstance.sendMessage(msg.chat.id, `⏸ Portfolio #${index} (${portfolio.ownerName || portfolio.name}) is on hold.\n\nAll signals and AI analysis are paused for this portfolio. Currently focusing on Upstox only.`);
          return;
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

        if (portfolio?.isPaused) {
          await botInstance.sendMessage(msg.chat.id, `⏸ Portfolio #${index} (${portfolio.ownerName || portfolio.name}) is on hold.\n\nAll signals and AI analysis are paused for this portfolio. Currently focusing on Upstox only.`);
          return;
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

        if (portfolio?.isPaused) {
          await botInstance.sendMessage(msg.chat.id, `⏸ Portfolio #${index} (${portfolio.ownerName || portfolio.name}) is on hold.\n\nAll signals and AI analysis are paused for this portfolio. Currently focusing on Upstox only.`);
          return;
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

    // /pause [reason] — Pause signal generation and notifications
    botInstance.onText(/^\/pause(?:\s+(.+))?$/, async (msg) => {
      const reason = msg.text.replace(/^\/pause\s*/i, '').trim() || 'unspecified reason';
      const chatId = msg.chat.id;
      try {
        const existing = await getSystemPauseState();
        if (existing) {
          const pausedAt = new Date(existing.pausedAt);
          const mins = Math.round((Date.now() - pausedAt.getTime()) / 60000);
          await botInstance.sendMessage(chatId,
            `⏸ Already paused for *${mins} min* (reason: _${existing.reason}_)\n\nUse /resume to restart.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        await setPauseState({ reason, pausedByTelegramId: msg.from.id.toString() });
        await botInstance.sendMessage(chatId,
          `⏸ *Invest Co-Pilot Paused*\n\nReason: _${reason}_\n\nSignal generation and notifications are stopped. Holdings and funds will continue to sync in the background.\n\nUse /resume when you're ready.`,
          { parse_mode: 'Markdown' }
        );
        logger.info(`System paused by Telegram user ${msg.from.id}: ${reason}`);
      } catch (err) {
        logger.error('Pause command error:', err);
        await botInstance.sendMessage(chatId, '❌ Failed to pause. Please try again.').catch(() => {});
      }
    });

    // /resume — Resume signal generation with AI briefing of missed signals
    botInstance.onText(/^\/resume$/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const pauseState = await getSystemPauseState();
        if (!pauseState) {
          await botInstance.sendMessage(chatId, '✅ System is already active. Signals are running normally.');
          return;
        }

        await botInstance.sendMessage(chatId, '▶️ Resuming... generating your briefing...');
        await clearPauseState();

        // If paused > 18 hours (crossed a trading day), expire stale signals
        const pauseDurationMs = Date.now() - new Date(pauseState.pausedAt).getTime();
        let freshGenNeeded = false;
        if (pauseDurationMs > 18 * 60 * 60 * 1000) {
          const expiredCount = await prisma.tradeSignal.updateMany({
            where: { status: { in: ['PENDING', 'SNOOZED'] } },
            data: { status: 'EXPIRED' }
          });
          if (expiredCount.count > 0) {
            freshGenNeeded = true;
            logger.info(`Resume: expired ${expiredCount.count} stale signals (paused > 18h)`);
          }
        }

        const briefing = await generateResumeBriefing(pauseState);
        await botInstance.sendMessage(chatId, briefing, { parse_mode: 'Markdown' }).catch(async () => {
          // Fallback if Markdown parse fails
          await botInstance.sendMessage(chatId, briefing.replace(/[*_`]/g, '')).catch(() => {});
        });

        if (freshGenNeeded) {
          await botInstance.sendMessage(chatId, '🔄 Old signals expired. Fresh signals will be generated at the next market cycle.');
        } else {
          await botInstance.sendMessage(chatId, '📡 Signal notifications will resume within 5 minutes.');
        }

        logger.info(`System resumed by Telegram user ${msg.from.id}`);
      } catch (err) {
        logger.error('Resume command error:', err);
        await botInstance.sendMessage(chatId, '❌ Failed to resume. Please try again.').catch(() => {});
      }
    });

    // /upstox — live snapshot | /upstox sync — auto-set capital | /upstox capital 8000 — manual set
    botInstance.onText(/^\/upstox(?:\s+(.+))?$/, async (msg) => {
      const chatId = msg.chat.id;
      const args = msg.text.trim().split(/\s+/);

      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const userId = telegramUser.user.id;

        // Sub-command: /upstox capital 8000
        if (args[1] === 'capital' && args[2]) {
          const newCapital = parseFloat(args[2]);
          if (isNaN(newCapital) || newCapital <= 0) {
            await botInstance.sendMessage(chatId, '❌ Invalid amount. Usage: `/upstox capital 8000`', { parse_mode: 'Markdown' });
            return;
          }
          const updated = await prisma.portfolio.updateMany({
            where: { userId, broker: 'UPSTOX', isActive: true },
            data: { startingCapital: newCapital }
          });
          if (updated.count === 0) {
            await botInstance.sendMessage(chatId, '❌ No Upstox portfolio found to update.');
            return;
          }
          await botInstance.sendMessage(chatId, `✅ Capital updated to ₹${newCapital.toLocaleString('en-IN')}. Fetching snapshot...`);
        }

        // Sub-command: /upstox target 15 — set profit-taking threshold to 15%
        if (args[1] === 'target' && args[2]) {
          const pct = parseFloat(args[2]);
          if (isNaN(pct) || pct <= 0 || pct > 200) {
            await botInstance.sendMessage(chatId, '❌ Invalid %. Usage: `/upstox target 10`', { parse_mode: 'Markdown' });
            return;
          }
          await prisma.portfolio.updateMany({
            where: { userId, broker: 'UPSTOX', isActive: true },
            data: { profitTargetPct: pct }
          });
          await botInstance.sendMessage(chatId, `🎯 Profit target set to *${pct}%*\nI'll alert you to withdraw when we hit this.`, { parse_mode: 'Markdown' });
          return;
        }

        // Sub-command: /upstox withdraw 2000 — record a bank withdrawal
        if (args[1] === 'withdraw' && args[2]) {
          const amount = parseFloat(args[2]);
          if (isNaN(amount) || amount <= 0) {
            await botInstance.sendMessage(chatId, '❌ Invalid amount. Usage: `/upstox withdraw 2000`', { parse_mode: 'Markdown' });
            return;
          }
          const p = await prisma.portfolio.findFirst({ where: { userId, broker: 'UPSTOX', isActive: true } });
          if (!p) {
            await botInstance.sendMessage(chatId, '❌ No Upstox portfolio found.');
            return;
          }
          const newTotalWithdrawn = parseFloat(p.totalWithdrawn || 0) + amount;
          const newStartingCapital = Math.max(0, parseFloat(p.startingCapital) - amount);
          await prisma.portfolio.update({
            where: { id: p.id },
            data: { totalWithdrawn: newTotalWithdrawn, startingCapital: newStartingCapital, availableCash: { decrement: amount } }
          });
          await prisma.capitalHistory.create({
            data: {
              portfolioId: p.id,
              oldCapital: parseFloat(p.startingCapital),
              newCapital: newStartingCapital,
              reason: `Bank withdrawal: ₹${amount.toLocaleString('en-IN')}`,
              changedBy: 'telegram'
            }
          });
          await botInstance.sendMessage(chatId,
            `✅ *Withdrawal recorded*\n\n💸 Withdrawn now: ₹${amount.toLocaleString('en-IN')}\n🏦 Total to bank: ₹${newTotalWithdrawn.toLocaleString('en-IN')}\n📉 New capital baseline: ₹${newStartingCapital.toLocaleString('en-IN')}\n\n_P&L now tracks from ₹${newStartingCapital.toLocaleString('en-IN')}_`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        // Check Upstox connected + token valid
        const integration = await prisma.upstoxIntegration.findUnique({ where: { userId } });
        if (!integration?.isConnected || !integration?.accessToken) {
          await botInstance.sendMessage(chatId, '❌ Upstox not connected. Use /auth to login.');
          return;
        }
        const valid = await isTokenValid(userId);
        if (!valid) {
          await botInstance.sendMessage(chatId, '🔐 Upstox token expired. Use /auth to refresh.');
          return;
        }

        // Sub-command: /upstox sync — auto-set startingCapital from current total portfolio value
        const isSyncCmd = args[1] === 'sync';

        if (args.length === 1 || isSyncCmd) {
          await botInstance.sendMessage(chatId, '📡 Fetching live Upstox data...');
        }

        // Fetch all Upstox APIs + portfolio in parallel (order book for open orders)
        const [fundsResult, holdingsResult, positionsResult, orderBookResult, portfolio] = await Promise.all([
          getFunds(userId),
          getHoldings(userId),
          getPositions(userId),
          getOrderBook(userId).catch(() => ({ orders: [] })), // non-blocking
          prisma.portfolio.findFirst({ where: { userId, broker: 'UPSTOX', isActive: true } })
        ]);

        let startingCapital = parseFloat(portfolio?.startingCapital || 0);
        // availableMargin = cash you can place a new order with RIGHT NOW
        // usedMargin      = cash locked in open positions (delivery buys held today)
        // payinAmount     = deposits credited today (already inside availableMargin)
        // notionalCash    = funds earmarked for withdrawal (NOT tradeable — explains "missing" cash)
        const availableCash  = fundsResult.availableMargin;
        const usedMargin     = fundsResult.usedMargin;
        const payinAmount    = fundsResult.payinAmount || 0;
        const notionalCash   = fundsResult.notionalCash || 0;
        const adhocMargin    = fundsResult.adhocMargin || 0;

        // ── Step 1: Map demat (long-term) holdings ──
        // These are positions you were holding BEFORE today (overnight).
        // They do NOT reflect today's buys/sells yet — that's T+1.
        const dematMap = new Map();
        for (const h of (holdingsResult.holdings || [])) {
          const sym = (h.tradingsymbol || h.trading_symbol || '').replace(/-EQ$/, '');
          if (!sym) continue;
          dematMap.set(sym, {
            symbol: sym,
            qty: h.quantity || 0,
            avgPrice: parseFloat(h.average_price || 0),
            lastPrice: parseFloat(h.last_price || h.close_price || 0),
            dematPnl: parseFloat(h.pnl || 0)
          });
        }

        // ── Step 2: Process today's positions for activity lines and sell/buy data ──
        // IMPORTANT: For delivery (CNC) sells, positions.quantity goes NEGATIVE
        // (e.g. sold 2 from demat → quantity = -2). Do NOT use positions.quantity
        // directly to determine effective holdings — use demat-first logic below.
        const activityLines = [];
        let totalRealisedToday = 0;
        const positionData = new Map(); // sym → position object

        for (const pos of (positionsResult.positions || [])) {
          const sym = (pos.tradingsymbol || pos.trading_symbol || '').replace(/-EQ$/, '');
          if (!sym) continue;
          positionData.set(sym, pos);

          const dayBuyQty   = pos.day_buy_quantity || 0;
          const daySellQty  = pos.day_sell_quantity || 0;
          const dayBuyPrice = parseFloat(pos.day_buy_price || 0);
          const daySellPrice= parseFloat(pos.day_sell_price || 0);
          const realised    = parseFloat(pos.realised || 0);
          const demat       = dematMap.get(sym);

          totalRealisedToday += realised;

          // Build human-readable activity line
          let actLine = `*${sym}*: `;
          if (dayBuyQty > 0)  actLine += `Bought ${dayBuyQty} @ ₹${dayBuyPrice.toFixed(2)}`;
          if (dayBuyQty > 0 && daySellQty > 0) actLine += `  ·  `;
          if (daySellQty > 0) {
            const src = demat ? 'from demat' : 'intraday';
            actLine += `Sold ${daySellQty} @ ₹${daySellPrice.toFixed(2)} _(${src})_`;
          }
          if (realised !== 0) {
            const rSign = realised >= 0 ? '+' : '';
            actLine += `\n   Realised P&L: ${rSign}₹${realised.toFixed(2)}`;
          }
          activityLines.push(actLine);
        }

        // ── Build effective holdings: DEMAT-FIRST ──
        // Same logic as syncUpstoxHoldings: start from overnight demat,
        // subtract today's sells, add today's buys. This is correct even when
        // positions.quantity is negative (CNC sell from demat).
        const effectiveHoldings = new Map();

        // 1. Demat holdings adjusted for today's sells/buys
        for (const [sym, h] of dematMap) {
          const pos         = positionData.get(sym);
          const daySellQty  = pos?.day_sell_quantity || 0;
          const dayBuyQty   = pos?.day_buy_quantity  || 0;
          const dayBuyPrice = parseFloat(pos?.day_buy_price || 0);
          const lastPrice   = parseFloat(pos?.last_price || 0) || h.lastPrice;

          const dematRemaining = Math.max(0, h.qty - daySellQty);
          const totalQty       = dematRemaining + dayBuyQty;
          if (totalQty <= 0) continue; // fully sold, nothing to show

          let avgCost = h.avgPrice;
          if (dematRemaining > 0 && dayBuyQty > 0) {
            // Weighted average: demat cost + today's buy cost
            avgCost = (dematRemaining * h.avgPrice + dayBuyQty * dayBuyPrice) / totalQty;
          } else if (dematRemaining === 0 && dayBuyQty > 0) {
            // Sold all demat today, only holding today's new buy
            avgCost = dayBuyPrice;
          }

          let source = 'demat';
          if (dematRemaining === 0)    source = 'today';         // sold all demat, only new buy
          else if (dayBuyQty > 0)      source = 'mixed';         // demat + new buy
          else if (daySellQty > 0)     source = 'demat-partial'; // partially sold from demat

          effectiveHoldings.set(sym, {
            symbol: sym, qty: totalQty, avgPrice: avgCost, lastPrice,
            unrealised: totalQty * (lastPrice - avgCost),
            source
          });
        }

        // 2. Same-day buys on stocks NOT in demat (brand new position, settles tomorrow)
        for (const [sym, pos] of positionData) {
          if (dematMap.has(sym)) continue; // already handled above
          const netQty   = pos.quantity || 0;
          if (netQty <= 0) continue;
          const lastPrice = parseFloat(pos.last_price || 0);
          const avgCost   = parseFloat(pos.day_buy_price || pos.average_price || 0);
          effectiveHoldings.set(sym, {
            symbol: sym, qty: netQty, avgPrice: avgCost, lastPrice,
            unrealised: parseFloat(pos.unrealised || 0),
            source: 'today'
          });
        }

        // ── Step 3: Calculate totals ──
        let totalHoldingValue  = 0;
        let totalHoldingCost   = 0;
        let totalUnrealised    = 0;
        const holdingLines     = [];

        for (const h of effectiveHoldings.values()) {
          const value      = h.qty * h.lastPrice;
          const cost       = h.qty * h.avgPrice;
          const unreal     = value - cost;
          const unrPct     = cost > 0 ? (unreal / cost) * 100 : 0;
          const uSign      = unreal >= 0 ? '+' : '';
          const uEmoji     = unreal >= 0 ? '▲' : '▼';

          totalHoldingValue += value;
          totalHoldingCost  += cost;
          totalUnrealised   += unreal;

          let note = '';
          if (h.source === 'today')         note = '\n   _⏳ Bought today — moves to demat tomorrow_';
          if (h.source === 'demat-partial') note = '\n   _⏳ Partially sold today — settles tomorrow_';
          if (h.source === 'mixed')         note = '\n   _⏳ Mix of demat + today\'s buy — settles tomorrow_';

          holdingLines.push(
            `*${h.symbol}*  ${h.qty} shares\n` +
            `   Avg cost: ₹${h.avgPrice.toFixed(2)}  →  Now: ₹${h.lastPrice.toFixed(2)}\n` +
            `   Invested: ₹${cost.toFixed(0)}  |  Value: ₹${value.toFixed(0)}\n` +
            `   ${uEmoji} Unrealised: ${uSign}₹${Math.abs(unreal).toFixed(0)} (${uSign}${unrPct.toFixed(2)}%)${note}`
          );
        }

        // ── Step 4: Overall P&L ──
        // Open LIMIT orders: Upstox deducts the blocked amount from availableMargin,
        // but those rupees are still "yours" — they just haven't been deployed yet.
        // We must add them back so the snapshot reflects total wealth correctly.
        // Filter is applied AFTER openOrders is computed below, so we compute it here inline.
        const _openOrdersForCalc = (orderBookResult.orders || []).filter(o => {
          const s = (o.status || '').toLowerCase();
          return s === 'open' || s === 'trigger pending' || s === 'put order req received' || s === 'modify pending';
        });
        const blockedInOpenOrders = _openOrdersForCalc
          .filter(o => (o.transaction_type || '').toUpperCase() === 'BUY')
          .reduce((sum, o) => sum + parseFloat(o.price || 0) * (o.pending_quantity || o.quantity || 0), 0);

        const totalPortfolioValue = availableCash + blockedInOpenOrders + totalHoldingValue;

        // /upstox sync: set startingCapital = current total portfolio value (baseline reset)
        // Only allowed to INCREASE startingCapital (adding new funds). Never decreases it —
        // that would erase loss history and make a losing portfolio look like it broke even.
        let capitalSynced = false;
        if (isSyncCmd) {
          const syncedAmount = Math.round(totalPortfolioValue);
          if (syncedAmount <= startingCapital && startingCapital > 0) {
            await botInstance.sendMessage(chatId,
              `⚠️ *Sync blocked*\n\nPortfolio value ₹${syncedAmount.toLocaleString('en-IN')} is *below* current baseline ₹${startingCapital.toLocaleString('en-IN')}.\n\nSync only resets baseline when adding new funds. Use \`/upstox capital ${syncedAmount}\` only if you intentionally want to reset the loss baseline.`,
              { parse_mode: 'Markdown' }
            );
          } else {
            await prisma.portfolio.updateMany({
              where: { userId, broker: 'UPSTOX', isActive: true },
              data: { startingCapital: syncedAmount }
            });
            startingCapital = syncedAmount;
            capitalSynced = true;
          }
        }

        const overallPnL    = startingCapital > 0 ? totalPortfolioValue - startingCapital : null;
        const overallPnLPct = startingCapital > 0 ? (overallPnL / startingCapital) * 100 : null;
        const oEmoji        = overallPnL === null ? '❓' : overallPnL >= 0 ? '📈' : '📉';
        const oSign         = overallPnL !== null && overallPnL >= 0 ? '+' : '';

        // ── Step 4b: Filter open/pending orders from order book ──
        const openOrders = _openOrdersForCalc; // already computed above for totalPortfolioValue

        // ── Step 5: Build message ──
        const ts = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
        let out = `💼 *UPSTOX — Live Snapshot*  _${ts} IST_\n`;
        out += `━━━━━━━━━━━━━━━━━━━\n`;

        if (capitalSynced) {
          out += `✅ *Capital synced → ₹${startingCapital.toLocaleString('en-IN')}*\n`;
        } else if (startingCapital > 0) {
          out += `🏦 *Your Capital:* ₹${startingCapital.toLocaleString('en-IN')}\n`;
        } else {
          out += `🏦 *Capital:* _not set — use /upstox sync or /upstox capital 7000_\n`;
        }
        out += `📊 *Portfolio Value:* ₹${totalPortfolioValue.toFixed(0)}\n`;
        if (overallPnL !== null) {
          out += `${oEmoji} *Overall P&L:* ${oSign}₹${Math.abs(overallPnL).toFixed(0)} (${oSign}${overallPnLPct.toFixed(2)}%)\n`;
        }
        if (totalRealisedToday !== 0) {
          const rSign = totalRealisedToday >= 0 ? '+' : '';
          out += `🔒 *Today's Realised:* ${rSign}₹${totalRealisedToday.toFixed(2)}\n`;
        }

        out += `━━━━━━━━━━━━━━━━━━━\n`;
        out += `💵 *Free Cash:* ₹${availableCash.toFixed(2)}  _← tradeable now_\n`;
        if (blockedInOpenOrders > 0) {
          out += `⏳ *In open LIMIT orders:* ₹${blockedInOpenOrders.toFixed(0)}  _← fills when price hits_\n`;
        }
        if (usedMargin > 0) {
          out += `🔐 *Locked in positions:* ₹${usedMargin.toFixed(0)}\n`;
        }
        // payinAmount: today's deposits (already inside availableCash — shown for info)
        if (payinAmount > 0) {
          out += `📥 *Payin (today's deposit):* ₹${payinAmount.toFixed(0)}  _← inside free cash_\n`;
        }
        // notionalCash: earmarked for withdrawal — explains why cash looks less than expected
        if (notionalCash > 0) {
          out += `🏧 *Withdrawal hold:* ₹${notionalCash.toFixed(0)}  _← not tradeable_\n`;
        }
        if (adhocMargin > 0) {
          out += `🎯 *Adhoc margin:* ₹${adhocMargin.toFixed(0)}\n`;
        }

        out += `━━━━━━━━━━━━━━━━━━━\n`;

        if (holdingLines.length > 0) {
          out += `*📌 Open Positions (${holdingLines.length}):*\n\n`;
          out += holdingLines.join('\n\n');
          out += '\n';
        } else {
          out += `_No open positions — fully in cash_\n`;
        }

        if (activityLines.length > 0) {
          out += `━━━━━━━━━━━━━━━━━━━\n`;
          out += `*🔄 Today's Activity:*\n`;
          out += activityLines.join('\n');
          out += '\n';
        }

        // Open LIMIT orders — sitting on the exchange, waiting to fill
        if (openOrders.length > 0) {
          // Batch-fetch LTP for all open order symbols so we can show the gap
          const openSymbols = [...new Set(openOrders.map(o =>
            (o.trading_symbol || o.tradingsymbol || '').replace(/-EQ$/, '').trim()).filter(Boolean))];
          let openLTPMap = new Map();
          try {
            if (openSymbols.length > 0) openLTPMap = await getUpstoxLTP(openSymbols);
          } catch (_) {}

          out += `━━━━━━━━━━━━━━━━━━━\n`;
          out += `*⏳ Open Orders — waiting to fill (${openOrders.length}):*\n`;
          for (const o of openOrders) {
            const side = (o.transaction_type || '').toUpperCase();
            const sideEmoji = side === 'BUY' ? '🟢' : '🔴';
            const limitPrice = parseFloat(o.price || 0);
            const pending = o.pending_quantity || o.quantity || 0;
            const sym = (o.trading_symbol || o.tradingsymbol || '').replace(/-EQ$/, '');
            const ltp = openLTPMap.get(sym)?.price || 0;

            let gapStr = '';
            if (ltp > 0 && limitPrice > 0) {
              const gapPct = ((ltp - limitPrice) / limitPrice * 100);
              const gapRs = (ltp - limitPrice).toFixed(2);
              const sign = gapPct >= 0 ? '+' : '';
              if (side === 'BUY') {
                // For BUY: LTP above limit = price hasn't dropped yet (gap to fill)
                gapStr = gapPct > 0
                  ? `  _Now ₹${ltp.toFixed(2)} — ${sign}${gapPct.toFixed(1)}% above limit, waiting for dip_`
                  : `  _Now ₹${ltp.toFixed(2)} — AT/BELOW limit, should fill soon!_`;
              } else {
                // For SELL: LTP below limit = price hasn't risen yet
                gapStr = gapPct < 0
                  ? `  _Now ₹${ltp.toFixed(2)} — ${Math.abs(gapPct).toFixed(1)}% below target, waiting for rise_`
                  : `  _Now ₹${ltp.toFixed(2)} — AT/ABOVE target, should fill soon!_`;
              }
            }

            const priceStr = limitPrice > 0 ? `₹${limitPrice.toFixed(2)}` : 'market';
            out += `${sideEmoji} ${side} ${pending}× *${sym}* @ ${priceStr}${gapStr}\n`;
          }
        }

        // ── Profit-taking alert ──
        const profitTargetPct  = parseFloat(portfolio?.profitTargetPct || 10);
        const totalWithdrawn   = parseFloat(portfolio?.totalWithdrawn  || 0);
        const profitRupees     = overallPnL || 0;
        const profitPct        = overallPnLPct || 0;
        const targetRupees     = startingCapital * (profitTargetPct / 100);
        const targetReached    = startingCapital > 0 && profitRupees >= targetRupees;
        // Suggested withdrawal: 50% of profits (keep 50% compounding)
        const suggestedWithdraw = targetReached ? Math.floor(profitRupees * 0.5 / 100) * 100 : 0;

        out += `━━━━━━━━━━━━━━━━━━━\n`;

        if (targetReached) {
          out += `🎯 *PROFIT TARGET HIT!* (${profitPct.toFixed(1)}% ≥ ${profitTargetPct}%)\n`;
          out += `💸 *Suggest withdrawing ₹${suggestedWithdraw.toLocaleString('en-IN')} to bank*\n`;
          out += `   _Keep the rest compounding. Use /upstox withdraw ${suggestedWithdraw}_\n`;
        } else if (startingCapital > 0 && profitRupees > 0) {
          const needed = targetRupees - profitRupees;
          out += `🎯 Target: ${profitTargetPct}% (₹${targetRupees.toLocaleString('en-IN')}) — ₹${needed.toFixed(0)} away\n`;
        } else {
          out += `🎯 Profit target: ${profitTargetPct}%  _(/upstox target N to change)_\n`;
        }
        if (totalWithdrawn > 0) {
          out += `🏦 *Total sent to bank: ₹${totalWithdrawn.toLocaleString('en-IN')}*\n`;
        }

        out += `━━━━━━━━━━━━━━━━━━━\n`;
        out += `_/upstox sync · /upstox withdraw N · /upstox target N_`;

        await botInstance.sendMessage(chatId, out, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.error(`/upstox command error: ${err?.message || String(err)}`);
        if (err?.stack) logger.error(err.stack.slice(0, 400));
        await botInstance.sendMessage(chatId, `❌ Failed to fetch Upstox data: ${err?.message || 'unknown error'}. Try again or use /auth if token expired.`).catch(() => {});
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

    // /signals — re-send pending signals after viability check
    botInstance.onText(/^\/signals$/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const userId = telegramUser.user.id;

        // Sync funds first so capital check is current
        try { await syncUpstoxFunds(userId); } catch (e) { /* non-blocking */ }

        const signals = await prisma.tradeSignal.findMany({
          where: {
            portfolio: { userId, isActive: true, isPaused: false },
            status: { in: ['PENDING', 'SNOOZED'] }
          },
          include: { portfolio: { include: { user: { include: { upstoxIntegration: true } } } } },
          orderBy: { createdAt: 'asc' }
        });

        if (signals.length === 0) {
          await botInstance.sendMessage(chatId,
            `📭 *No pending signals*\n\nNo active trade signals found. Use /regen to generate fresh signals.`,
            { parse_mode: 'Markdown' });
          return;
        }

        await botInstance.sendMessage(chatId,
          `🔎 *Checking ${signals.length} signal(s) for viability...*`,
          { parse_mode: 'Markdown' });

        // Cache DB holdings per portfolio for SELL validation
        const holdingsCache = new Map();
        async function getDbHoldings(portfolioId) {
          if (!holdingsCache.has(portfolioId)) {
            const rows = await prisma.holding.findMany({
              where: { portfolioId }, select: { symbol: true, quantity: true }
            });
            const m = new Map();
            for (const h of rows) m.set(h.symbol, h.quantity);
            holdingsCache.set(portfolioId, m);
          }
          return holdingsCache.get(portfolioId);
        }

        let sent = 0, expiredCount = 0;

        for (const signal of signals) {
          const upstoxIntegration = signal.portfolio?.user?.upstoxIntegration;
          const hasUpstox = signal.portfolio?.broker === 'UPSTOX' &&
            upstoxIntegration?.isConnected && upstoxIntegration?.accessToken;

          // ── Viability check ──
          let viable = true;
          let viabilityNote = '';

          if (signal.side === 'SELL') {
            const holdingsMap = await getDbHoldings(signal.portfolioId);
            if ((holdingsMap.get(signal.symbol) || 0) <= 0) {
              viable = false;
              viabilityNote = 'Stock no longer held';
            }
          } else {
            // BUY: check price range + capital
            let estimatedPrice = parseFloat(signal.triggerPrice || signal.triggerLow || 0);
            let livePrice = 0;
            try {
              const pd = await getCurrentPrice(signal.symbol, signal.exchange);
              livePrice = pd?.price || pd?.lastPrice || 0;
            } catch (e) { /* non-blocking */ }

            if (estimatedPrice <= 0 || signal.triggerType === 'MARKET') {
              estimatedPrice = livePrice || estimatedPrice;
            }

            // LIMIT: if live price already >8% above limit, entry window has passed
            if (viable && signal.triggerType === 'LIMIT' && livePrice > 0) {
              if (livePrice > parseFloat(signal.triggerPrice) * 1.08) {
                viable = false;
                viabilityNote = `Live ₹${livePrice.toFixed(0)} > limit ₹${parseFloat(signal.triggerPrice).toFixed(0)} by >8% — entry window passed`;
              }
            }

            // Capital check (excluding this signal's own reservation)
            if (viable && estimatedPrice > 0) {
              const { effectiveCash } = await getEffectiveCash(signal.portfolioId, signal.id);
              const orderCost = signal.quantity * estimatedPrice;
              if (orderCost > effectiveCash) {
                viable = false;
                viabilityNote = `Insufficient cash: need ₹${orderCost.toFixed(0)}, have ₹${effectiveCash.toFixed(0)}`;
              }
            }
          }

          if (!viable) {
            await prisma.tradeSignal.update({ where: { id: signal.id }, data: { status: 'EXPIRED' } });
            expiredCount++;
            await botInstance.sendMessage(chatId,
              `🗑 *Signal #${signal.id} expired* — ${signal.side} ${signal.quantity}x *${signal.symbol}*\n_${viabilityNote}_`,
              { parse_mode: 'Markdown' });
            continue;
          }

          // ── Re-send signal with buttons ──
          const sideEmoji = signal.side === 'BUY' ? '🟢' : '🔴';
          const bar = '█'.repeat(Math.floor(signal.confidence / 10)) + '░'.repeat(10 - Math.floor(signal.confidence / 10));
          let priceInfo = signal.triggerType === 'MARKET' ? 'At Market Price'
            : signal.triggerType === 'LIMIT' ? `Limit: ₹${signal.triggerPrice}`
            : `Zone: ₹${signal.triggerLow}–₹${signal.triggerHigh}`;
          const portfolioName = signal.portfolio.ownerName || signal.portfolio.name;
          const msgText = `${sideEmoji} *${signal.side} SIGNAL*\n━━━━━━━━━━━━━━━━━━━\n*${signal.symbol}* (${signal.exchange})\nQty: ${signal.quantity} | ${priceInfo}\n\n📁 *${portfolioName}*\n\nConfidence: ${bar} ${signal.confidence}%\n${signal.rationale || ''}`;

          const buttons = hasUpstox
            ? [{ text: '🚀 Execute', callback_data: `sig_exec_${signal.id}` },
               { text: '⏰ Snooze 30m', callback_data: `sig_snooze_${signal.id}` },
               { text: '❌ Dismiss', callback_data: `sig_dismiss_${signal.id}` }]
            : [{ text: '✅ ACK', callback_data: `sig_ack_${signal.id}` },
               { text: '⏰ Snooze 30m', callback_data: `sig_snooze_${signal.id}` },
               { text: '❌ Dismiss', callback_data: `sig_dismiss_${signal.id}` }];

          await botInstance.sendMessage(chatId, msgText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [buttons] }
          });
          await prisma.tradeSignal.update({
            where: { id: signal.id },
            data: { lastNotifiedAt: new Date(), status: 'PENDING' }
          });
          sent++;
          await new Promise(r => setTimeout(r, 300));
        }

        if (sent === 0 && expiredCount > 0) {
          await botInstance.sendMessage(chatId,
            `♻️ All ${expiredCount} signal(s) were stale and expired. Use /regen to generate fresh ones.`,
            { parse_mode: 'Markdown' });
        }
      } catch (error) {
        logger.error('/signals command error:', error);
        await botInstance.sendMessage(chatId, '❌ Failed to fetch signals').catch(() => {});
      }
    });

    // /regen — expire current pending signals and generate fresh ones now
    botInstance.onText(/^\/regen$/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const userId = telegramUser.user.id;

        const statusMsg = await botInstance.sendMessage(chatId,
          '🔄 *Regenerating signals...*\n_Expiring old, syncing data, running AI analysis..._',
          { parse_mode: 'Markdown' });

        // Expire all current PENDING/SNOOZED signals for this user
        const expiredResult = await prisma.tradeSignal.updateMany({
          where: {
            portfolio: { userId, isActive: true },
            status: { in: ['PENDING', 'SNOOZED'] }
          },
          data: { status: 'EXPIRED' }
        });
        logger.info(`/regen: expired ${expiredResult.count} signals for user ${userId}`);

        // Sync Upstox funds + holdings for freshest data
        try { await syncUpstoxFunds(userId); } catch (e) { logger.warn('Fund sync failed during /regen:', e.message); }
        try { await syncUpstoxHoldings(userId); } catch (e) { logger.warn('Holdings sync failed during /regen:', e.message); }

        // Find eligible portfolios
        const portfolios = await prisma.portfolio.findMany({
          where: { userId, isActive: true, isPaused: false },
          include: {
            holdings: true,
            user: { include: { upstoxIntegration: true } }
          }
        });

        if (portfolios.length === 0) {
          await botInstance.editMessageText('❌ No active portfolios found.',
            { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
          return;
        }

        let totalGenerated = 0;

        for (const portfolio of portfolios) {
          try {
            const signals = await generateTradeSignals(portfolio.id);
            if (signals.length === 0) continue;
            totalGenerated += signals.length;

            const upstoxIntegration = portfolio.user?.upstoxIntegration;
            const hasUpstox = portfolio.broker === 'UPSTOX' &&
              upstoxIntegration?.isConnected && upstoxIntegration?.accessToken;

            for (const signal of signals) {
              const sideEmoji = signal.side === 'BUY' ? '🟢' : '🔴';
              const bar = '█'.repeat(Math.floor(signal.confidence / 10)) + '░'.repeat(10 - Math.floor(signal.confidence / 10));
              let priceInfo = signal.triggerType === 'MARKET' ? 'At Market Price'
                : signal.triggerType === 'LIMIT' ? `Limit: ₹${signal.triggerPrice}`
                : `Zone: ₹${signal.triggerLow}–₹${signal.triggerHigh}`;
              const portfolioName = portfolio.ownerName || portfolio.name;
              const msgText = `${sideEmoji} *${signal.side} SIGNAL* _(fresh)_\n━━━━━━━━━━━━━━━━━━━\n*${signal.symbol}* (${signal.exchange})\nQty: ${signal.quantity} | ${priceInfo}\n\n📁 *${portfolioName}*\n\nConfidence: ${bar} ${signal.confidence}%\n${signal.rationale || ''}`;

              const buttons = hasUpstox
                ? [{ text: '🚀 Execute', callback_data: `sig_exec_${signal.id}` },
                   { text: '⏰ Snooze 30m', callback_data: `sig_snooze_${signal.id}` },
                   { text: '❌ Dismiss', callback_data: `sig_dismiss_${signal.id}` }]
                : [{ text: '✅ ACK', callback_data: `sig_ack_${signal.id}` },
                   { text: '⏰ Snooze 30m', callback_data: `sig_snooze_${signal.id}` },
                   { text: '❌ Dismiss', callback_data: `sig_dismiss_${signal.id}` }];

              await botInstance.sendMessage(chatId, msgText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [buttons] }
              });
              await prisma.tradeSignal.update({
                where: { id: signal.id },
                data: { lastNotifiedAt: new Date() }
              });
              await new Promise(r => setTimeout(r, 300));
            }
          } catch (err) {
            logger.error(`/regen: signal generation failed for portfolio ${portfolio.id}:`, err.message);
          }
        }

        const summary = totalGenerated > 0
          ? `✅ *${totalGenerated} fresh signal(s) sent above* (${expiredResult.count} old expired)`
          : `♻️ Expired ${expiredResult.count} old signal(s).\n\n🤷 *No new signals generated*\n_Market conditions may not favour trades right now. Try again later._`;

        await botInstance.editMessageText(summary,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }).catch(() => {});

      } catch (error) {
        logger.error('/regen command error:', error);
        await botInstance.sendMessage(chatId, '❌ Signal regeneration failed').catch(() => {});
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

        // Handle "Force LIMIT at signal price" (after large price deviation warning)
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

        // Load signal with portfolio to check broker type
        const signal = await prisma.tradeSignal.findUnique({
          where: { id: signalId },
          include: { portfolio: true }
        });

        if (!signal) {
          await botInstance.answerCallbackQuery(query.id, { text: 'Signal not found' }).catch(() => {});
          return;
        }

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

        // For non-Upstox portfolios: update availableCash on ACK
        if (action === 'ack' && signal.portfolio && signal.portfolio.broker !== 'UPSTOX') {
          const price = parseFloat(signal.triggerPrice || signal.triggerLow || 0);
          if (price > 0 && signal.quantity > 0) {
            const amount = signal.quantity * price;
            if (signal.side === 'BUY') {
              await prisma.portfolio.update({
                where: { id: signal.portfolioId },
                data: { availableCash: { decrement: amount } }
              });
              logger.info(`[Capital] Non-Upstox ACK BUY: portfolio ${signal.portfolioId} cash -₹${amount.toFixed(0)} (${signal.symbol})`);
            } else if (signal.side === 'SELL') {
              await prisma.portfolio.update({
                where: { id: signal.portfolioId },
                data: { availableCash: { increment: amount } }
              });
              logger.info(`[Capital] Non-Upstox ACK SELL: portfolio ${signal.portfolioId} cash +₹${amount.toFixed(0)} (${signal.symbol})`);
            }
          }
        }

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

    // /report — Daily intelligence report: positions, signals, P&L, next scans
    botInstance.onText(/^\/report$/, async (msg) => {
      try {
        const telegramUser = await getOrCreateUser(msg.from.id, msg.from.username, msg.from.first_name);
        const portfolios = await getUserPortfolios(telegramUser.user.id);
        const activePortfolios = portfolios.filter(p => !p.isPaused);
        const targets = activePortfolios.length > 0 ? activePortfolios : portfolios.slice(0, 1);

        if (targets.length === 0) {
          await botInstance.sendMessage(msg.chat.id, '📭 No portfolios found.');
          return;
        }

        for (const portfolio of targets) {
          const todayIST = new Date();
          todayIST.setHours(0, 0, 0, 0);

          // Today's signals
          const todaySignals = await prisma.tradeSignal.findMany({
            where: { portfolioId: portfolio.id, createdAt: { gte: todayIST } },
            orderBy: { createdAt: 'asc' }
          });

          const pendingSignals = todaySignals.filter(s => s.status === 'PENDING');

          // Holdings P&L
          const holdings = portfolio.holdings || [];
          const totalInvested = holdings.reduce((sum, h) =>
            sum + (parseFloat(h.avgPrice || 0) * parseInt(h.quantity || 0)), 0);
          const totalCurrentVal = holdings.reduce((sum, h) => {
            const curr = parseFloat(h.currentPrice || h.avgPrice || 0);
            return sum + curr * parseInt(h.quantity || 0);
          }, 0);
          const openPnL = totalCurrentVal - totalInvested;

          const cash = parseFloat(portfolio.availableCash || 0);
          const totalVal = totalCurrentVal + cash;
          const startCap = parseFloat(portfolio.startingCapital || totalVal);
          const overallPnL = totalVal - startCap;
          const overallPnLPct = startCap > 0 ? ((overallPnL / startCap) * 100) : 0;

          // Monthly target progress
          const targetPct = parseFloat(portfolio.profitTargetPct || 5);
          const targetAmount = startCap * targetPct / 100;
          const targetProgress = targetAmount > 0 ? Math.round(overallPnL / targetAmount * 100) : 0;
          const targetBar = overallPnL >= targetAmount
            ? '🟢 MONTHLY TARGET HIT'
            : overallPnLPct > 0
              ? `🟡 ${targetProgress}% to ${targetPct}% monthly target`
              : `🔴 DRAWDOWN — ${overallPnLPct.toFixed(1)}%`;

          // Today's signal activity
          const signalLines = todaySignals.length > 0
            ? todaySignals.map(s => {
                const st = s.status === 'EXECUTED' ? '✅' : s.status === 'EXPIRED' ? '⏰' : s.status === 'DISMISSED' ? '❌' : '🔔';
                const side = s.side === 'BUY' ? '🟢' : '🔴';
                const price = s.triggerPrice ? `₹${parseFloat(s.triggerPrice).toFixed(0)}` : 'MKT';
                return `${st}${side} ${s.symbol} ×${s.quantity} @ ${price} (${s.confidence}%)`;
              }).join('\n')
            : 'No signals today yet';

          // Live positions detail
          const holdingLines = holdings.length > 0
            ? holdings.map(h => {
                const avg = parseFloat(h.avgPrice || 0);
                const curr = parseFloat(h.currentPrice || avg);
                const qty = parseInt(h.quantity || 0);
                const pnl = (curr - avg) * qty;
                const pnlPct = avg > 0 ? ((curr - avg) / avg * 100).toFixed(1) : 0;
                const arrow = pnl >= 0 ? '▲' : '▼';
                const pnlStr = pnl >= 0
                  ? `+₹${pnl.toFixed(0)} (+${pnlPct}%)`
                  : `-₹${Math.abs(pnl).toFixed(0)} (${pnlPct}%)`;
                return `• *${h.symbol}* ${qty}sh | Avg ₹${avg.toFixed(0)} → ₹${curr.toFixed(0)} | ${arrow}${pnlStr}`;
              }).join('\n')
            : 'No open positions';

          // Pending signals
          const pendingLines = pendingSignals.length > 0
            ? pendingSignals.map(s => {
                const side = s.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
                const price = s.triggerPrice ? `₹${parseFloat(s.triggerPrice).toFixed(0)}` : 'MARKET';
                return `• ${side} ${s.symbol} ×${s.quantity} @ ${price} — ${s.confidence}% conf`;
              }).join('\n')
            : 'None awaiting action';

          // Upcoming scans (based on IST clock)
          const nowTotalMin = new Date().getHours() * 60 + new Date().getMinutes();
          const scanSchedule = [
            { label: 'Pre-Market Brief', hm: '08:30', mins: 8 * 60 + 30 },
            { label: 'Morning Full Scan', hm: '09:30', mins: 9 * 60 + 30 },
            { label: 'Mid-Morning Pivot', hm: '11:00', mins: 11 * 60 },
            { label: 'Afternoon Scan',   hm: '13:00', mins: 13 * 60 },
            { label: 'Pre-Close Pivot',  hm: '14:30', mins: 14 * 60 + 30 },
            { label: 'EOD Review',       hm: '15:45', mins: 15 * 60 + 45 },
          ];
          const nextScans = scanSchedule
            .filter(s => s.mins > nowTotalMin)
            .slice(0, 3)
            .map(s => `  📍 ${s.hm} — ${s.label}`)
            .join('\n') || '  Market closed for today';

          const pnlSign  = overallPnL >= 0 ? '+' : '';
          const openSign = openPnL >= 0 ? '+' : '';

          const report = `📊 *${portfolio.ownerName || portfolio.name} — Daily Report*
━━━━━━━━━━━━━━━━━━━
💰 *Capital Standing*
Starting:  ₹${startCap.toLocaleString('en-IN')}
Current:   ₹${totalVal.toLocaleString('en-IN')}
P&L:       ${pnlSign}₹${Math.abs(overallPnL).toFixed(0)} (${pnlSign}${overallPnLPct.toFixed(1)}%)
Cash:      ₹${cash.toLocaleString('en-IN')} available
${targetBar}

📈 *Live Positions (${holdings.length})*
${holdingLines}${holdings.length > 0 ? `\nOpen P&L: ${openSign}₹${Math.abs(openPnL).toFixed(0)}` : ''}

🎯 *Today's Signals (${todaySignals.length})*
${signalLines}

⏳ *Pending — Awaiting Action*
${pendingLines}

🔄 *Next AI Scans*
${nextScans}`;

          if (report.length <= 4000) {
            await botInstance.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });
          } else {
            // Split at a natural line break near the midpoint
            const splitAt = report.lastIndexOf('\n', Math.floor(report.length / 2));
            await botInstance.sendMessage(msg.chat.id, report.substring(0, splitAt), { parse_mode: 'Markdown' });
            await botInstance.sendMessage(msg.chat.id, report.substring(splitAt + 1), { parse_mode: 'Markdown' });
          }
        }
      } catch (error) {
        logger.error('Report command error:', error);
        await botInstance.sendMessage(msg.chat.id, '❌ Error generating report. Please try again.').catch(() => {});
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

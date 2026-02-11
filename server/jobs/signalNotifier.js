import cron from 'node-cron';
import prisma from '../services/prisma.js';
import { getBot } from '../services/telegramBot.js';
import { generateTradeSignals, expireOldSignals } from '../services/signalGenerator.js';
import { isTokenValid, getAuthorizationUrl, getHoldings, getOrderStatus } from '../services/upstoxService.js';
import { refreshAiTarget } from '../services/dailyTargetService.js';
import { isTradingDay } from '../utils/marketHolidays.js';
import logger from '../services/logger.js';

/**
 * Check if Upstox token is expired and send a reminder to re-authenticate.
 * Runs once in the morning before signal generation.
 */
async function remindUpstoxAuth() {
  try {
    const bot = getBot();
    if (!bot) return;

    // Find users with Upstox integration
    const integrations = await prisma.upstoxIntegration.findMany({
      where: { isConnected: true },
      include: { user: { include: { telegramUser: true } } }
    });

    for (const integration of integrations) {
      const telegramUser = integration.user?.telegramUser;
      if (!telegramUser || !telegramUser.isActive || telegramUser.isMuted) continue;

      const valid = await isTokenValid(integration.userId);
      if (valid) continue;

      try {
        const authUrl = await getAuthorizationUrl(integration.userId);
        const chatId = parseInt(telegramUser.telegramId);
        await bot.sendMessage(chatId,
          `🔐 *Upstox Token Expired*\n\nYour daily token has expired. Please re-authenticate to enable Execute buttons on trade signals:\n\n[Login to Upstox](${authUrl})\n\nOr use /auth anytime.`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
        logger.info(`Sent Upstox re-auth reminder to ${telegramUser.telegramId}`);
      } catch (err) {
        logger.error(`Failed to send Upstox auth reminder:`, err.message);
      }
    }
  } catch (error) {
    logger.error('Upstox auth reminder error:', error);
  }
}

/**
 * Auto-generate trade signals for all active portfolios.
 * Runs at 9:30 AM and 1:00 PM IST during market hours.
 */
async function generateSignalsForAllPortfolios() {
  if (!isTradingDay(new Date())) return;

  try {
    // Get all active portfolios that have holdings
    const portfolios = await prisma.portfolio.findMany({
      where: { isActive: true },
      include: {
        holdings: true,
        user: { include: { telegramUser: true } }
      }
    });

    // Only generate for portfolios with linked Telegram users
    const eligiblePortfolios = portfolios.filter(p =>
      p.user?.telegramUser?.isActive && !p.user?.telegramUser?.isMuted
    );

    if (eligiblePortfolios.length === 0) {
      logger.info('No eligible portfolios for signal generation');
      return;
    }

    let totalSignals = 0;
    for (const portfolio of eligiblePortfolios) {
      try {
        // Check if we already generated signals for this portfolio today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const existingToday = await prisma.tradeSignal.count({
          where: {
            portfolioId: portfolio.id,
            createdAt: { gte: today },
            status: { notIn: ['EXPIRED'] }
          }
        });

        // Skip if already have 3+ active signals today for this portfolio
        if (existingToday >= 3) {
          logger.info(`Portfolio ${portfolio.id} already has ${existingToday} signals today, skipping`);
          continue;
        }

        // Fix 2: Verify previous EXECUTED signals against actual Upstox holdings
        let extraContext = '';
        if (portfolio.broker === 'UPSTOX') {
          try {
            const threeDaysAgo = new Date();
            threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

            const executedSignals = await prisma.tradeSignal.findMany({
              where: {
                portfolioId: portfolio.id,
                status: 'EXECUTED',
                side: 'BUY',
                createdAt: { gte: threeDaysAgo }
              }
            });

            if (executedSignals.length > 0) {
              try {
                const upstoxHoldings = await getHoldings(portfolio.user.id);
                const upstoxSymbols = new Set(
                  (upstoxHoldings || []).map(h => (h.tradingsymbol || h.trading_symbol || '').toUpperCase())
                );

                const unfilled = executedSignals.filter(s => !upstoxSymbols.has(s.symbol.toUpperCase()));

                if (unfilled.length > 0) {
                  const unfilledNames = unfilled.map(s => s.symbol).join(', ');
                  extraContext = `\n⚠️ UNFILLED SIGNALS: Previous BUY signals for ${unfilledNames} were marked EXECUTED but are NOT in actual Upstox holdings. These trades may have failed. Do NOT generate new signals for these symbols unless you have a strong reason.`;

                  logger.info(`Unfilled signals detected for portfolio ${portfolio.id}: ${unfilledNames}`);

                  // Alert user via Telegram
                  const telegramUser = portfolio.user?.telegramUser;
                  if (telegramUser) {
                    const bot = getBot();
                    if (bot) {
                      await bot.sendMessage(
                        parseInt(telegramUser.telegramId),
                        `⚠️ *Unfilled Signals Detected*\n\nPrevious BUY signals for *${unfilledNames}* were executed but trades did not complete in Upstox. Please check your order history.`,
                        { parse_mode: 'Markdown' }
                      );
                    }
                  }
                }
              } catch (holdingsErr) {
                logger.warn(`Could not fetch Upstox holdings for verification (user ${portfolio.user.id}):`, holdingsErr.message);
              }
            }
          } catch (verifyErr) {
            logger.error(`Holdings verification failed for portfolio ${portfolio.id}:`, verifyErr.message);
          }
        }

        const signals = await generateTradeSignals(portfolio.id, extraContext);
        totalSignals += signals.length;
        logger.info(`Generated ${signals.length} signals for portfolio ${portfolio.id} (${portfolio.ownerName || portfolio.name})`);

        // Small delay between portfolios to avoid API rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        logger.error(`Signal generation failed for portfolio ${portfolio.id}:`, error.message);
      }
    }

    logger.info(`Signal generation complete: ${totalSignals} signals across ${eligiblePortfolios.length} portfolios`);
  } catch (error) {
    logger.error('Signal generation batch error:', error);
  }
}

/**
 * Check for pending trade signals and send/resend to Telegram.
 * Signals are sent with inline buttons: Execute/ACK, Snooze 30m, Dismiss.
 * Re-sends every 30 minutes until acknowledged, executed, or dismissed.
 */
async function notifyPendingSignals() {
  if (!isTradingDay(new Date())) return;

  const bot = getBot();
  if (!bot) return;

  try {
    // First expire old signals
    await expireOldSignals();

    const now = new Date();
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);

    // Find signals that need notification:
    // - Status PENDING or SNOOZED
    // - Never notified, OR last notified >= 30 min ago
    const signals = await prisma.tradeSignal.findMany({
      where: {
        status: { in: ['PENDING', 'SNOOZED'] },
        OR: [
          { lastNotifiedAt: null },
          { lastNotifiedAt: { lte: thirtyMinAgo } }
        ]
      },
      include: {
        portfolio: {
          include: {
            user: {
              include: {
                telegramUser: true,
                upstoxIntegration: true
              }
            }
          }
        }
      }
    });

    let sentCount = 0;
    for (const signal of signals) {
      const telegramUser = signal.portfolio?.user?.telegramUser;
      if (!telegramUser || !telegramUser.isActive || telegramUser.isMuted) continue;

      try {
        const chatId = parseInt(telegramUser.telegramId);
        const sideEmoji = signal.side === 'BUY' ? '🟢' : '🔴';
        const confidenceBar = '█'.repeat(Math.floor(signal.confidence / 10)) + '░'.repeat(10 - Math.floor(signal.confidence / 10));

        let priceInfo = '';
        if (signal.triggerType === 'MARKET') {
          priceInfo = 'At Market Price';
        } else if (signal.triggerType === 'LIMIT') {
          priceInfo = `Limit: ₹${signal.triggerPrice}`;
        } else if (signal.triggerType === 'ZONE') {
          priceInfo = `Zone: ₹${signal.triggerLow} - ₹${signal.triggerHigh}`;
        }

        const portfolioName = signal.portfolio.ownerName || signal.portfolio.name;
        const brokerName = (signal.portfolio.broker || 'Unknown').replace(/_/g, ' ');
        const riskProfile = signal.portfolio.riskProfile || '';
        const repeatNote = signal.notifyCount > 0 ? `\n⏰ _Reminder #${signal.notifyCount + 1}_` : '';

        const msgText = `${sideEmoji} *${signal.side} SIGNAL*
━━━━━━━━━━━━━━━━━━━
*${signal.symbol}* (${signal.exchange})
Qty: ${signal.quantity} | ${priceInfo}

📁 *${portfolioName}* — ${brokerName}${riskProfile ? ' (' + riskProfile + ')' : ''}

Confidence: ${confidenceBar} ${signal.confidence}%
${signal.rationale || ''}${repeatNote}`;

        // Check if this portfolio's broker is Upstox AND user has valid Upstox integration
        const isUpstoxBroker = signal.portfolio?.broker === 'UPSTOX';
        const upstoxIntegration = signal.portfolio?.user?.upstoxIntegration;
        const hasUpstox = isUpstoxBroker && upstoxIntegration?.isConnected && upstoxIntegration?.accessToken;

        const buttons = hasUpstox
          ? [
              { text: '🚀 Execute', callback_data: `sig_exec_${signal.id}` },
              { text: '⏰ Snooze 30m', callback_data: `sig_snooze_${signal.id}` },
              { text: '❌ Dismiss', callback_data: `sig_dismiss_${signal.id}` }
            ]
          : [
              { text: '✅ ACK', callback_data: `sig_ack_${signal.id}` },
              { text: '⏰ Snooze 30m', callback_data: `sig_snooze_${signal.id}` },
              { text: '❌ Dismiss', callback_data: `sig_dismiss_${signal.id}` }
            ];

        const inlineKeyboard = {
          reply_markup: {
            inline_keyboard: [buttons]
          }
        };

        await bot.sendMessage(chatId, msgText, {
          parse_mode: 'Markdown',
          ...inlineKeyboard
        });

        // Update notification tracking
        await prisma.tradeSignal.update({
          where: { id: signal.id },
          data: {
            lastNotifiedAt: now,
            notifyCount: { increment: 1 },
            // If it was snoozed, move back to pending for the next cycle
            status: 'PENDING'
          }
        });

        sentCount++;
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        logger.error(`Failed to notify signal ${signal.id}:`, error.message);
      }
    }

    if (sentCount > 0) {
      logger.info(`Sent ${sentCount}/${signals.length} trade signal notifications`);
    } else if (signals.length > 0) {
      logger.warn(`Found ${signals.length} pending signals but sent 0 (no linked Telegram users)`);
    }
  } catch (error) {
    logger.error('Signal notification error:', error);
  }
}

/**
 * Poll pending/placing Upstox orders and update linked TradeSignals.
 * Runs every 5 min during market hours to catch orders that settled
 * after the initial 15s polling window.
 */
async function pollPendingOrders() {
  if (!isTradingDay(new Date())) return;

  const bot = getBot();

  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Find all non-terminal UpstoxOrders from last 24h
    const pendingOrders = await prisma.upstoxOrder.findMany({
      where: {
        createdAt: { gte: twentyFourHoursAgo },
        status: { notIn: ['complete', 'traded', 'rejected', 'cancelled', 'COMPLETE', 'TRADED', 'REJECTED', 'CANCELLED'] }
      },
      include: {
        user: { include: { upstoxIntegration: true, telegramUser: true } }
      }
    });

    if (pendingOrders.length === 0) return;

    logger.info(`Polling ${pendingOrders.length} pending Upstox orders...`);

    for (const order of pendingOrders) {
      try {
        if (!order.user?.upstoxIntegration?.accessToken) continue;

        const status = await getOrderStatus(order.userId, order.orderId);
        const orderStatus = (status.status || '').toLowerCase();

        if (!['complete', 'traded', 'rejected', 'cancelled'].includes(orderStatus)) {
          continue; // Still pending
        }

        logger.info(`Order ${order.orderId} settled: ${orderStatus}`);

        // Find linked TradeSignal
        const linkedSignal = await prisma.tradeSignal.findFirst({
          where: { upstoxOrderId: order.id }
        });

        if (!linkedSignal) continue;

        const telegramUser = order.user?.telegramUser;
        const chatId = telegramUser ? parseInt(telegramUser.telegramId) : null;

        if (['complete', 'traded'].includes(orderStatus)) {
          // Success — confirm signal
          if (linkedSignal.status !== 'EXECUTED') {
            await prisma.tradeSignal.update({
              where: { id: linkedSignal.id },
              data: { status: 'EXECUTED' }
            });
          }

          if (bot && chatId && telegramUser.isActive) {
            const avgPrice = status.averagePrice ? ` @ ₹${status.averagePrice}` : '';
            await bot.sendMessage(chatId,
              `✅ *ORDER CONFIRMED* (via monitoring)\n\n${linkedSignal.side} ${linkedSignal.quantity}x *${linkedSignal.symbol}*${avgPrice}\nOrder: \`${order.orderId}\``,
              { parse_mode: 'Markdown' }
            );
          }
        } else {
          // Failure — roll back signal
          await prisma.tradeSignal.update({
            where: { id: linkedSignal.id },
            data: { status: 'PENDING', upstoxOrderId: null, lastNotifiedAt: null }
          });

          if (bot && chatId && telegramUser.isActive) {
            const reason = status.message || 'Unknown reason';
            await bot.sendMessage(chatId,
              `🔴 *ORDER FAILED — THIS IS MY FAILURE*\n\n${linkedSignal.side} ${linkedSignal.symbol} was *${orderStatus.toUpperCase()}*\nReason: _${reason}_\n\nSignal has been reset. It will re-appear in your next notification cycle.`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🔄 Retry as MARKET', callback_data: `sig_mkt_${linkedSignal.id}` },
                    { text: '⏰ Snooze 1hr', callback_data: `sig_snooze_${linkedSignal.id}` },
                    { text: '🚫 Dismiss', callback_data: `sig_dismiss_${linkedSignal.id}` }
                  ]]
                }
              }
            );
          }

          logger.warn(`Signal #${linkedSignal.id} rolled back via cron: order ${order.orderId} = ${orderStatus}`);
        }

        // Small delay between API calls
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (orderErr) {
        logger.error(`Failed to poll order ${order.orderId}:`, orderErr.message);
      }
    }
  } catch (error) {
    logger.error('Order polling cron error:', error);
  }
}

/**
 * Auto-compute daily earning targets at market open.
 * Runs at 9:15 AM IST — ensures targets exist BEFORE the 10 AM hourly check.
 */
async function computeMorningTargets() {
  if (!isTradingDay(new Date())) return;

  try {
    logger.info('Computing morning daily targets...');

    const portfolios = await prisma.portfolio.findMany({
      where: { isActive: true },
      include: {
        holdings: true,
        user: { include: { telegramUser: true } }
      }
    });

    const eligible = portfolios.filter(p =>
      p.holdings?.length > 0 &&
      p.user?.telegramUser?.isActive &&
      !p.user?.telegramUser?.isMuted
    );

    if (eligible.length === 0) {
      logger.info('No eligible portfolios for morning targets');
      return;
    }

    const bot = getBot();
    let created = 0;

    for (const portfolio of eligible) {
      try {
        const target = await refreshAiTarget(portfolio.id);
        created++;

        // Send target notification via Telegram
        if (bot && target.aiTarget > 0) {
          const chatId = parseInt(portfolio.user.telegramUser.telegramId);
          const portfolioName = portfolio.ownerName || portfolio.name;
          const broker = (portfolio.broker || 'Unknown').replace(/_/g, ' ');
          const confidenceBar = '█'.repeat(Math.floor(target.aiConfidence / 10)) + '░'.repeat(10 - Math.floor(target.aiConfidence / 10));

          const msg = `🎯 *DAILY TARGET SET*
━━━━━━━━━━━━━━━━━━━
📁 *${portfolioName}* — ${broker}

💰 Today's Target: *₹${target.aiTarget.toFixed(0)}*
Confidence: ${confidenceBar} ${target.aiConfidence}%

${target.aiRationale || ''}

I'll track progress hourly and generate recovery signals if we fall behind. Let's hit this target.`;

          await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        }

        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        logger.error(`Morning target failed for portfolio ${portfolio.id}:`, err.message);
      }
    }

    logger.info(`Morning targets computed: ${created}/${eligible.length} portfolios`);
  } catch (error) {
    logger.error('Morning target computation error:', error);
  }
}

/**
 * Initialize the signal notifier cron jobs.
 */
export function initSignalNotifier() {
  logger.info('Initializing signal notifier...');

  // Remind to re-auth Upstox at 9:15 AM if token expired
  cron.schedule('15 9 * * 1-5', async () => {
    if (!isTradingDay(new Date())) return;
    await remindUpstoxAuth();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Compute daily earning targets at 9:16 AM (after Upstox auth, before signals)
  cron.schedule('16 9 * * 1-5', async () => {
    logger.info('Running morning target computation...');
    await computeMorningTargets();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Generate signals at 9:30 AM and 1:00 PM IST (market open + midday)
  cron.schedule('30 9 * * 1-5', async () => {
    logger.info('Running morning signal generation...');
    await generateSignalsForAllPortfolios();
  }, {
    timezone: 'Asia/Kolkata'
  });

  cron.schedule('0 13 * * 1-5', async () => {
    logger.info('Running midday signal generation...');
    await generateSignalsForAllPortfolios();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Notify pending signals every 5 minutes during market hours
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    await notifyPendingSignals();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Poll pending Upstox orders every 5 min during market hours
  cron.schedule('*/5 9-16 * * 1-5', async () => {
    await pollPendingOrders();
  }, {
    timezone: 'Asia/Kolkata'
  });

  logger.info('Signal notifier initialized:');
  logger.info('  Morning targets: 9:16 AM IST');
  logger.info('  Signal generation: 9:30 AM + 1:00 PM IST');
  logger.info('  Signal notifications: every 5 min, 9-3:30 PM IST');
  logger.info('  Order status polling: every 5 min, 9 AM-4 PM IST');
}

export default { initSignalNotifier, notifyPendingSignals, generateSignalsForAllPortfolios, pollPendingOrders, computeMorningTargets };

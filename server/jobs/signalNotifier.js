import cron from 'node-cron';
import prisma from '../services/prisma.js';
import { getBot } from '../services/telegramBot.js';
import { generateTradeSignals, expireOldSignals } from '../services/signalGenerator.js';
import { isTokenValid, getAuthorizationUrl } from '../services/upstoxService.js';
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

        const signals = await generateTradeSignals(portfolio.id);
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

  logger.info('Signal notifier initialized:');
  logger.info('  Signal generation: 9:30 AM + 1:00 PM IST');
  logger.info('  Signal notifications: every 5 min, 9-3:30 PM IST');
}

export default { initSignalNotifier, notifyPendingSignals, generateSignalsForAllPortfolios };

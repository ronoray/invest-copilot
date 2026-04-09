import express from 'express';
import { exchangeCodeForToken } from '../services/upstoxService.js';
import { getBot } from '../services/telegramBot.js';
import { updateCashOnExecution, upsertHoldingOnExecution, syncUpstoxFunds } from '../services/capitalGuard.js';
import prisma from '../services/prisma.js';
import logger from '../services/logger.js';
const router = express.Router();

// Guard: Upstox webhook secret — must match UPSTOX_WEBHOOK_SECRET env var
// Register webhook URLs in Upstox portal with ?secret=<value> query param
function verifyUpstoxWebhook(req, res) {
  const expectedSecret = process.env.UPSTOX_WEBHOOK_SECRET;
  if (!expectedSecret) {
    logger.error('UPSTOX_WEBHOOK_SECRET not set — refusing all Upstox webhook requests');
    res.status(403).json({ error: 'Webhook not configured' });
    return false;
  }
  const provided = req.query.secret || req.headers['x-webhook-secret'];
  if (!provided || provided !== expectedSecret) {
    logger.warn('Upstox webhook: invalid or missing secret from ' + req.ip);
    res.status(403).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * GET /auth/upstox/callback
 * Upstox OAuth callback — exchanges code for token.
 * PUBLIC route (no JWT) — Upstox redirects browser here after login.
 */
router.get('/auth/upstox/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).send('Missing authorization code from Upstox.');
    }

    const userId = parseInt(state);
    if (!userId) {
      return res.status(400).send('Invalid state parameter.');
    }

    await exchangeCodeForToken(code, userId);

    // Sync Upstox funds to portfolio availableCash
    try {
      await syncUpstoxFunds(userId);
    } catch (syncErr) {
      logger.warn('Fund sync after OAuth failed:', syncErr.message);
    }

    // Notify user via Telegram
    try {
      const telegramUser = await prisma.telegramUser.findFirst({
        where: { userId }
      });
      if (telegramUser) {
        const bot = getBot();
        if (bot) {
          await bot.sendMessage(
            parseInt(telegramUser.telegramId),
            '✅ *Upstox Connected!*\nYour token has been refreshed. Execute buttons on trade signals will work until market close today.',
            { parse_mode: 'Markdown' }
          );
        }
      }
    } catch (tgErr) {
      logger.warn('Could not send Telegram notification after Upstox auth:', tgErr.message);
    }

    // Redirect to frontend with success message
    const frontendUrl = process.env.FRONTEND_URL || 'https://invest.hungrytimes.in';
    res.redirect(`${frontendUrl}?upstox_auth=success`);
  } catch (error) {
    const errMsg = error.response?.data?.message || error.response?.data?.error || error.message || 'Unknown error';
    const errDetail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    logger.error('Upstox callback error:', errDetail);
    const frontendUrl = process.env.FRONTEND_URL || 'https://invest.hungrytimes.in';
    res.redirect(`${frontendUrl}?upstox_auth=failed&error=${encodeURIComponent(errMsg)}`);
  }
});

/**
 * POST /webhook/upstox/token
 * Upstox notifier webhook — receives access token automatically after approval.
 * This enables automatic daily token refresh without user clicking a login link.
 */
router.post('/webhook/upstox/token', async (req, res) => {
  if (!verifyUpstoxWebhook(req, res)) return;
  try {
    logger.info('Upstox token webhook received:', JSON.stringify(req.body));

    const { authorized_redirect_uri, user_id, access_token, email } = req.body || {};

    if (!access_token) {
      logger.warn('Upstox token webhook: no access_token in payload');
      return res.status(400).json({ error: 'No access_token' });
    }

    // Find the integration by matching — Upstox sends us the token
    // We need to figure out which user this belongs to
    // Try to match by the first connected integration (single-user setup)
    const integration = await prisma.upstoxIntegration.findFirst({
      where: { isConnected: true },
      include: { user: { include: { telegramUser: true } } }
    });

    if (!integration) {
      logger.warn('Upstox token webhook: no connected integration found');
      return res.status(404).json({ error: 'No integration found' });
    }

    // Update token
    const expiresAt = new Date();
    expiresAt.setHours(23, 59, 59, 0);

    await prisma.upstoxIntegration.update({
      where: { id: integration.id },
      data: {
        accessToken: access_token,
        tokenExpiresAt: expiresAt,
        isConnected: true,
        lastSyncAt: new Date()
      }
    });

    logger.info(`Upstox token auto-refreshed for user ${integration.userId} via webhook`);

    // Sync Upstox funds to portfolio availableCash
    try {
      await syncUpstoxFunds(integration.userId);
    } catch (syncErr) {
      logger.warn('Fund sync after token webhook failed:', syncErr.message);
    }

    // Notify via Telegram
    try {
      const telegramUser = integration.user?.telegramUser;
      if (telegramUser) {
        const bot = getBot();
        if (bot) {
          await bot.sendMessage(
            parseInt(telegramUser.telegramId),
            '🔑 *Upstox Token Auto-Refreshed*\nYour token was refreshed automatically via webhook. Execute buttons are active!',
            { parse_mode: 'Markdown' }
          );
        }
      }
    } catch (tgErr) {
      logger.warn('Could not send Telegram notification after token webhook:', tgErr.message);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Upstox token webhook error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /webhook/upstox/orders
 * Upstox order postback — receives order status updates.
 */
router.post('/webhook/upstox/orders', async (req, res) => {
  if (!verifyUpstoxWebhook(req, res)) return;
  try {
    logger.info('Upstox order webhook received:', JSON.stringify(req.body));

    const orderData = req.body;
    if (!orderData || !orderData.order_id) {
      return res.status(400).json({ error: 'Invalid order data' });
    }

    const orderId = orderData.order_id;
    const status = orderData.status || 'UNKNOWN';

    // Update order in DB
    const updated = await prisma.upstoxOrder.updateMany({
      where: { orderId },
      data: {
        status: status === 'complete' ? 'COMPLETE' : status.toUpperCase(),
        filledQuantity: orderData.filled_quantity || 0,
        averagePrice: orderData.average_price || null,
        message: orderData.status_message || null,
        executedAt: status === 'complete' ? new Date() : null
      }
    });

    if (updated.count > 0) {
      logger.info(`Order ${orderId} updated via webhook: ${status}`);

      // Sync portfolio cash and holdings on completed orders
      if (status === 'complete') {
        try {
          const completedOrder = await prisma.upstoxOrder.findFirst({ where: { orderId } });
          if (completedOrder) {
            await updateCashOnExecution(completedOrder.id);
            await upsertHoldingOnExecution(completedOrder.id);

            // Mark linked TradeSignal as EXECUTED (catches poll timeout case)
            const linkedSignal = await prisma.tradeSignal.findFirst({
              where: { upstoxOrderId: completedOrder.id, status: { not: 'EXECUTED' } }
            });
            if (linkedSignal) {
              await prisma.tradeSignal.update({
                where: { id: linkedSignal.id },
                data: { status: 'EXECUTED' }
              });
              logger.info(`Signal #${linkedSignal.id} marked EXECUTED via webhook for order ${orderId}`);
            }
          }
        } catch (cashErr) {
          logger.error(`Cash/holding sync failed for order ${orderId}:`, cashErr.message);
        }
      }

      // Notify user via Telegram + handle linked TradeSignal
      if (status === 'complete' || status === 'rejected' || status === 'cancelled') {
        let order;
        try {
          order = await prisma.upstoxOrder.findFirst({
            where: { orderId },
            include: {
              integration: {
                include: {
                  user: { include: { telegramUser: true } }
                }
              }
            }
          });
        } catch (fetchErr) {
          logger.warn(`Could not fetch order ${orderId} for notification: ${fetchErr?.message || String(fetchErr)}`);
        }

        if (order) {
          // Detect EOD expiry: Upstox cancels unfilled day-validity LIMIT orders at market close.
          // These are NOT failures — the order simply never filled. Treat differently from
          // genuine rejections (invalid price, insufficient funds) or manual cancels.
          const statusMsg = (orderData.status_message || '').toLowerCase();
          const istHour = parseInt(new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
          const isEodExpiry = status === 'cancelled' && (
            statusMsg.includes('day') ||
            statusMsg.includes('expir') ||
            statusMsg.includes('validity') ||
            statusMsg.includes('cancelled at') ||
            istHour >= 15  // after 15:00 IST = almost certainly an EOD sweep
          );

          // Handle linked TradeSignal first (DB work before any Telegram calls)
          if (status === 'rejected' || status === 'cancelled') {
            try {
              const linkedSignal = await prisma.tradeSignal.findFirst({
                where: { upstoxOrderId: order.id }
              });

              if (linkedSignal) {
                if (isEodExpiry) {
                  // EOD expiry: expire signal cleanly — tomorrow's scan will produce fresh signals
                  await prisma.tradeSignal.update({
                    where: { id: linkedSignal.id },
                    data: { status: 'EXPIRED', upstoxOrderId: null }
                  });
                  await prisma.signalAck.create({
                    data: {
                      signalId: linkedSignal.id,
                      action: 'ROLLBACK',
                      note: 'EOD expiry: LIMIT order never filled today'
                    }
                  });
                  logger.info(`EOD EXPIRY: Signal ${linkedSignal.id} (${linkedSignal.symbol}) expired cleanly`);
                } else {
                  // Genuine rejection or manual cancel — restore signal with Execute button
                  await prisma.tradeSignal.update({
                    where: { id: linkedSignal.id },
                    data: { status: 'PENDING', upstoxOrderId: null, lastNotifiedAt: null }
                  });
                  await prisma.signalAck.create({
                    data: {
                      signalId: linkedSignal.id,
                      action: 'ROLLBACK',
                      note: `Order ${status}: ${orderData.status_message || 'No reason provided'}`
                    }
                  });
                  logger.info(`ROLLBACK: Signal ${linkedSignal.id} reset to PENDING after order ${status} (${orderData.status_message || ''})`);

                  // Re-send signal with buttons
                  try {
                    const telegramUser = order?.integration?.user?.telegramUser;
                    if (telegramUser) {
                      const bot = getBot();
                      if (bot) {
                        const chatId = parseInt(telegramUser.telegramId);
                        const reason = orderData.status_message || 'Unknown reason';
                        const sideEmoji = linkedSignal.side === 'BUY' ? '🟢' : '🔴';
                        const rollbackMsg = `⚠️ *ORDER ${status.toUpperCase()} — Signal Restored*\n━━━━━━━━━━━━━━━━━━━\n${sideEmoji} *${linkedSignal.side} ${linkedSignal.quantity}x ${linkedSignal.symbol}*\nReason: ${reason}\n\nSignal has been restored. You can try again:`;
                        await bot.sendMessage(chatId, rollbackMsg, {
                          parse_mode: 'Markdown',
                          reply_markup: {
                            inline_keyboard: [[
                              { text: '🚀 Execute', callback_data: `sig_exec_${linkedSignal.id}` },
                              { text: '⏰ Snooze 30m', callback_data: `sig_snooze_${linkedSignal.id}` },
                              { text: '❌ Dismiss', callback_data: `sig_dismiss_${linkedSignal.id}` }
                            ]]
                          }
                        });
                      }
                    }
                  } catch (tgRollbackErr) {
                    logger.warn(`Could not send rollback notification: ${tgRollbackErr?.message || String(tgRollbackErr)}`);
                  }
                }
              }
            } catch (signalErr) {
              logger.error(`Signal rollback failed for order ${orderId}: ${signalErr?.message || String(signalErr)}`);
            }
          }

          // Send order status notification
          try {
            const telegramUser = order?.integration?.user?.telegramUser;
            if (telegramUser) {
              const bot = getBot();
              if (bot) {
                let msg;
                if (isEodExpiry) {
                  msg = `🕐 *LIMIT Order Expired* (unfilled)\n${order.transactionType} ${order.quantity}x *${order.symbol}* — price never reached today`;
                } else {
                  const emoji = status === 'complete' ? '✅' : status === 'rejected' ? '❌' : '🚫';
                  msg = `${emoji} *Order ${status.toUpperCase()}*\n${order.transactionType} ${order.quantity}x *${order.symbol}*${orderData.average_price ? '\nPrice: ₹' + orderData.average_price : ''}${orderData.status_message ? '\n' + orderData.status_message : ''}`;
                }
                await bot.sendMessage(parseInt(telegramUser.telegramId), msg, { parse_mode: 'Markdown' });
              }
            }
          } catch (tgErr) {
            logger.warn(`Could not send order status notification: ${tgErr?.message || String(tgErr)}`);
          }
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Upstox order webhook error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;

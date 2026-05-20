/**
 * Upstox webhook routes — per v3 API spec.
 *
 * POST /upstox/notifier      — access token delivery (no auth, rate-limited)
 * POST /upstox/postback      — order/GTT status updates (no auth, rate-limited)
 * GET  /health/upstox        — token freshness + configuration check
 * POST /api/upstox/request-auth — manual re-auth trigger (requires JWT)
 *
 * Per Upstox spec: notifier and postback endpoints must accept POST with no auth
 * and return 2XX. Security is handled by: rate limiting + payload shape validation
 * + HTTPS-only at the Traefik reverse proxy layer.
 */

import express from 'express';
import prisma from '../services/prisma.js';
import { set_token } from '../services/upstoxTokenStore.js';
import { kickoffWithNotification } from '../services/upstoxAuthKickoff.js';
import { syncUpstoxFunds } from '../services/capitalGuard.js';
import { getBot } from '../services/telegramBot.js';
import { authenticate } from '../middleware/auth.js';
import logger from '../services/logger.js';

const router = express.Router();

// ============================================
// SIMPLE IN-PROCESS RATE LIMITER
// Max 60 requests / minute per IP on webhook endpoints.
// ============================================

const _rl = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let e = _rl.get(ip);
  if (!e || now - e.window > 60000) {
    e = { count: 1, window: now };
  } else {
    e.count++;
  }
  _rl.set(ip, e);
  if (e.count > 60) {
    logger.warn(`[webhook] Rate limit exceeded from ${ip}`);
    return res.status(429).json({ error: 'rate limit exceeded' });
  }
  next();
}

setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [ip, e] of _rl.entries()) {
    if (e.window < cutoff) _rl.delete(ip);
  }
}, 300000).unref();

// ============================================
// POST /upstox/notifier  (and /webhook/upstox/notifier — CF bypass alias)
// Upstox delivers the access token here after the user taps Approve.
// ============================================

async function processNotifier(req) {
  const payload = req.body;

  if (
    !payload ||
    typeof payload !== 'object' ||
    payload.message_type !== 'access_token' ||
    typeof payload.access_token !== 'string' ||
    !payload.access_token
  ) {
    logger.warn(
      '[notifier] Invalid payload — expected message_type=access_token with access_token string. ' +
      `Got: message_type=${payload?.message_type}, has_token=${!!payload?.access_token}`,
    );
    return;
  }

  const integration = await prisma.upstoxIntegration.findFirst({
    where: { isConnected: true },
    include: { user: { include: { telegramUser: true } } },
  });

  if (!integration) {
    logger.warn('[notifier] No connected UpstoxIntegration found');
    return;
  }

  const result = await set_token(integration.userId, payload);

  if (!result.saved) {
    logger.info(`[notifier] Token not saved: ${result.reason}`);
    return;
  }

  try {
    await syncUpstoxFunds(integration.userId);
  } catch (e) {
    logger.warn('[notifier] Fund sync after token refresh failed:', e.message);
  }

  const telegramUser = integration.user?.telegramUser;
  if (telegramUser) {
    const bot = getBot();
    if (bot) {
      const expiryIST = result.expiresAt
        ? new Date(result.expiresAt).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          })
        : 'unknown';
      await bot
        .sendMessage(
          parseInt(telegramUser.telegramId),
          `✅ *Upstox Token Refreshed*\n` +
          `New token received via notifier webhook.\n` +
          `Valid until: *${expiryIST} IST*\n` +
          `Execute buttons are active!`,
          { parse_mode: 'Markdown' },
        )
        .catch(e => logger.warn('[notifier] Telegram send failed:', e.message));
    }
  }
}

function notifierHandler(req, res) {
  res.json({ status: 'ok' });
  setImmediate(() =>
    processNotifier(req).catch(err =>
      logger.error('[notifier] Background processing error:', err),
    ),
  );
}

router.post('/upstox/notifier', rateLimit, notifierHandler);
// Cloudflare Access bypass alias — /webhook/* is exempted from Zero Trust auth
router.post('/webhook/upstox/notifier', rateLimit, notifierHandler);

// ============================================
// POST /upstox/postback  (and /webhook/upstox/postback — CF bypass alias)
// Upstox sends order and GTT order status updates here.
// ============================================

async function processPostback(req) {
  const data = req.body;
  const updateType = data?.update_type;

  if (!updateType) {
    logger.warn('[postback] Missing update_type in payload');
    return;
  }

  if (updateType === 'order') {
    await handleOrderUpdate(data);
  } else if (updateType === 'gtt_order') {
    await handleGttOrderUpdate(data);
  } else {
    logger.warn(`[postback] Unknown update_type: ${updateType}`);
  }
}

function postbackHandler(req, res) {
  res.json({ status: 'ok' });
  setImmediate(() =>
    processPostback(req).catch(err =>
      logger.error('[postback] Background processing error:', err),
    ),
  );
}

router.post('/upstox/postback', rateLimit, postbackHandler);
// Cloudflare Access bypass alias
router.post('/webhook/upstox/postback', rateLimit, postbackHandler);

async function handleOrderUpdate(data) {
  // Use snake_case fields per spec; deprecated tradingsymbol / userId are ignored.
  const orderId = data.order_id;
  const status = data.status || 'UNKNOWN';

  if (!orderId) {
    logger.warn('[postback:order] Missing order_id — ignoring');
    return;
  }

  logger.info(
    `[postback:order] order_id=${orderId} ` +
    `status=${status} ` +
    `symbol=${data.trading_symbol} ` +
    `tx=${data.transaction_type} ` +
    `filled=${data.filled_quantity}/${data.quantity}`,
  );

  const updated = await prisma.upstoxOrder.updateMany({
    where: { orderId },
    data: {
      status: status === 'complete' ? 'COMPLETE' : status.toUpperCase(),
      filledQuantity: data.filled_quantity ?? 0,
      averagePrice: data.average_price ?? null,
      message: data.status_message || null,
      executedAt: status === 'complete' ? new Date() : null,
    },
  });

  if (updated.count > 0) {
    logger.info(`[postback:order] Updated ${updated.count} DB record(s) for order ${orderId}`);
  } else {
    logger.info(`[postback:order] No DB record for order ${orderId} — may be an external order`);
  }
}

async function handleGttOrderUpdate(data) {
  const gttOrderId = data.gtt_order_id;

  logger.info(
    `[postback:gtt_order] gtt_order_id=${gttOrderId} ` +
    `type=${data.type} ` +
    `exchange=${data.exchange} ` +
    `qty=${data.quantity}`,
  );

  if (Array.isArray(data.rules)) {
    for (const rule of data.rules) {
      logger.info(
        `[postback:gtt_order]   rule: strategy=${rule.strategy} ` +
        `status=${rule.status} ` +
        `order_id=${rule.order_id} ` +
        `trigger_price=${rule.trigger_price}`,
      );
    }
  }
  // GTT order management not implemented — events are logged for observability.
}

// ============================================
// GET /health/upstox
// ============================================

router.get('/health/upstox', async (req, res) => {
  try {
    const integration = await prisma.upstoxIntegration.findFirst({
      where: { isConnected: true },
      select: {
        accessToken: true,
        tokenExpiresAt: true,
        issuedAt: true,
        lastAuthRequestAt: true,
        isConnected: true,
      },
    });

    const now = new Date();
    const expiresAt = integration?.tokenExpiresAt ? new Date(integration.tokenExpiresAt) : null;
    const hasToken = !!(integration?.accessToken && expiresAt && now < expiresAt);
    const expiresInSeconds = expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : 0;

    res.json({
      has_token: hasToken,
      expires_at_iso: expiresAt?.toISOString() ?? null,
      expires_in_seconds: expiresInSeconds,
      last_refresh_iso: integration?.issuedAt?.toISOString() ?? null,
      last_auth_request_iso: integration?.lastAuthRequestAt?.toISOString() ?? null,
      notifier_configured: !!(process.env.UPSTOX_CLIENT_ID && process.env.UPSTOX_CLIENT_SECRET),
      postback_configured: true,
      notifier_path: process.env.UPSTOX_NOTIFIER_PATH || '/upstox/notifier',
      postback_path: process.env.UPSTOX_POSTBACK_PATH || '/upstox/postback',
    });
  } catch (err) {
    logger.error('[health/upstox] Error:', err);
    res.status(500).json({ error: 'Failed to fetch Upstox health' });
  }
});

// ============================================
// POST /api/upstox/request-auth  (authenticated)
// Manual trigger for the daily auth kickoff.
// ============================================

router.post('/api/upstox/request-auth', authenticate, async (req, res) => {
  try {
    const result = await kickoffWithNotification();
    if (result.ok) {
      res.json({
        ok: true,
        message: 'Auth request sent. Check your Upstox app for the approval notification.',
        authorization_expiry: result.authorizationExpiry?.toISOString() ?? null,
      });
    } else {
      res.status(502).json({ ok: false, error: result.error });
    }
  } catch (err) {
    logger.error('[request-auth] Unexpected error:', err);
    res.status(500).json({ error: 'Auth kickoff failed' });
  }
});

export default router;

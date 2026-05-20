/**
 * Upstox daily auth kickoff.
 *
 * Calls the v3 Access Token Request API so Upstox sends the user an
 * in-app + WhatsApp approval prompt. After the user taps Approve, Upstox
 * POSTs the token to /upstox/notifier. No browser redirect involved.
 *
 * Scheduled at 8:30 AM IST weekdays (configurable via UPSTOX_DAILY_AUTH_CRON).
 * Also callable manually via POST /api/upstox/request-auth.
 */

import axios from 'axios';
import cron from 'node-cron';
import prisma from './prisma.js';
import logger from './logger.js';

const UPSTOX_BASE_URL = process.env.UPSTOX_BASE_URL || 'https://api.upstox.com';
const COOLDOWN_MS = 30 * 60 * 1000; // suppress repeat triggers within 30 min

let _lastTriggeredAt = 0;

/**
 * Format ms timestamp as IST string for notifications.
 */
function msToIST(ms) {
  return new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Human-readable messages for Upstox error codes from the token-request endpoint.
 */
function errorMessageFor(code, fallback) {
  const map = {
    UDAPI100069: 'Invalid UPSTOX_CLIENT_ID or UPSTOX_CLIENT_SECRET — check env vars.',
    UDAPI1123:   'Notifier webhook URL not configured. Set https://<your-domain>/upstox/notifier in Upstox My Apps.',
    UDAPI1124:   'Token requests only work for individual user accounts, not institutional/dealer accounts.',
    UDAPI1155:   'Upstox app is under exchange review or was rejected — contact Upstox support.',
    UDAPI1157:   'Upstox API app has expired. Create a new app at account.upstox.com/developer/apps.',
  };
  return map[code] || `Upstox error ${code || 'unknown'}: ${fallback}`;
}

/**
 * POST to Upstox v3 token-request API.
 *
 * On success: Upstox sends user an in-app + WhatsApp approval prompt.
 *             Token arrives later via the notifier webhook.
 * On failure: returns { ok: false, error: string, errorCode: string|null }
 *
 * @returns {Promise<{ok: boolean, authorizationExpiry: Date|null, notifierUrl: string|null, error: string|null, errorCode: string|null}>}
 */
export async function requestAccessToken() {
  const clientId = process.env.UPSTOX_CLIENT_ID;
  const clientSecret = process.env.UPSTOX_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const err = 'UPSTOX_CLIENT_ID or UPSTOX_CLIENT_SECRET not set in env';
    logger.error('[auth-kickoff] ' + err);
    return { ok: false, error: err, errorCode: null, authorizationExpiry: null, notifierUrl: null };
  }

  logger.info('[auth-kickoff] Calling Upstox v3 token-request API...');

  let responseData;
  let errorCode = null;
  let errorMsg = null;

  try {
    const response = await axios.post(
      `${UPSTOX_BASE_URL}/v3/login/auth/token/request/${clientId}`,
      { client_secret: clientSecret },
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    );
    responseData = response.data;
  } catch (err) {
    const body = err.response?.data;
    errorCode = body?.errors?.[0]?.errorCode || body?.error_code || null;
    errorMsg = errorMessageFor(errorCode, body?.message || err.message);
    logger.error(`[auth-kickoff] API call failed [${err.response?.status}]: ${errorMsg}`);
    return { ok: false, error: errorMsg, errorCode, authorizationExpiry: null, notifierUrl: null };
  }

  if (responseData?.status !== 'success') {
    errorCode = responseData?.errors?.[0]?.errorCode || null;
    errorMsg = errorMessageFor(errorCode, JSON.stringify(responseData));
    logger.error(`[auth-kickoff] Non-success response: ${errorMsg}`);
    return { ok: false, error: errorMsg, errorCode, authorizationExpiry: null, notifierUrl: null };
  }

  const { authorization_expiry, notifier_url } = responseData.data || {};
  const authExpiry = authorization_expiry ? new Date(parseInt(authorization_expiry, 10)) : null;

  // Record the time of this request
  try {
    await prisma.upstoxIntegration.updateMany({ data: { lastAuthRequestAt: new Date() } });
  } catch (e) {
    logger.warn('[auth-kickoff] Could not update lastAuthRequestAt:', e.message);
  }

  _lastTriggeredAt = Date.now();

  logger.info(
    `[auth-kickoff] Token request sent. ` +
    `Waiting for user approval. ` +
    `Authorization expires: ${authExpiry?.toISOString() || 'unknown'}`,
  );

  return { ok: true, authorizationExpiry: authExpiry, notifierUrl: notifier_url, error: null, errorCode: null };
}

/**
 * Run requestAccessToken and send Telegram notification with the result.
 * This is the function called by both the cron job and manual HTTP trigger.
 */
export async function kickoffWithNotification() {
  let bot = null;
  let telegramUser = null;

  try {
    const { getBot } = await import('./telegramBot.js');
    bot = getBot();
    telegramUser = await prisma.telegramUser.findFirst({ where: { isActive: true } });
  } catch {
    // Telegram is optional — proceed without it
  }

  const sendTelegram = async (msg) => {
    if (bot && telegramUser) {
      try {
        await bot.sendMessage(parseInt(telegramUser.telegramId), msg, { parse_mode: 'Markdown' });
      } catch (e) {
        logger.warn('[auth-kickoff] Telegram send failed:', e.message);
      }
    }
  };

  const result = await requestAccessToken();

  if (result.ok) {
    const expiryStr = result.authorizationExpiry
      ? msToIST(result.authorizationExpiry.getTime())
      : 'unknown';
    await sendTelegram(
      `🔐 *Upstox Auth Request Sent*\n` +
      `Open the Upstox app and tap *Approve* on the notification.\n` +
      `Request expires: *${expiryStr} IST*`,
    );
  } else {
    await sendTelegram(`❌ *Upstox Auth Request Failed*\n${result.error}`);
  }

  return result;
}

/**
 * Trigger re-auth in the background, suppressed if already triggered within COOLDOWN_MS.
 * Returns true if the trigger was fired, false if suppressed.
 */
export async function triggerReAuthIfNotRecent() {
  const ageSec = Math.round((Date.now() - _lastTriggeredAt) / 1000);
  if (Date.now() - _lastTriggeredAt < COOLDOWN_MS) {
    logger.info(`[auth-kickoff] Suppressed — last triggered ${ageSec}s ago (cooldown=${COOLDOWN_MS / 1000}s)`);
    return false;
  }
  kickoffWithNotification().catch(e =>
    logger.error('[auth-kickoff] Background re-auth trigger failed:', e.message),
  );
  return true;
}

/**
 * Register the daily cron job.
 * Called from index.js inside the cron-enabled block.
 */
export function initAuthKickoff() {
  const cronExpr = process.env.UPSTOX_DAILY_AUTH_CRON || '30 8 * * 1-5';
  cron.schedule(
    cronExpr,
    () => {
      kickoffWithNotification().catch(e =>
        logger.error('[auth-kickoff] Scheduled run failed:', e.message),
      );
    },
    { timezone: 'Asia/Kolkata' },
  );
  logger.info(`[auth-kickoff] Daily auth cron scheduled: "${cronExpr}" IST`);
}

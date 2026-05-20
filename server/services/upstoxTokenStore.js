/**
 * Upstox token store — single source of truth for the access token.
 *
 * All Upstox API callers must use get_active_token() instead of reading
 * the DB directly. set_token() is called by the notifier webhook handler.
 *
 * Design:
 *   - Primary record: UpstoxIntegration (mutable, latest token)
 *   - History: UpstoxTokenHistory (append-only, sanitized — no full tokens)
 *   - Dedupe: reject duplicate issued_at + client_id combos
 *   - Safety margin: get_active_token returns null if token expires < 5 min from now
 */

import prisma from './prisma.js';
import logger from './logger.js';

const SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns the active token for a userId, or null if missing/stale/near-expiry.
 *
 * "Stale" means: now >= expires_at - SAFETY_MARGIN_MS
 * Callers should treat null as "re-auth required" and throw TokenStaleError.
 *
 * @param {number} userId
 * @returns {Promise<{accessToken: string, tokenType: string, expiresAt: Date, issuedAt: Date|null}|null>}
 */
export async function get_active_token(userId) {
  const integration = await prisma.upstoxIntegration.findUnique({
    where: { userId },
    select: {
      accessToken: true,
      tokenExpiresAt: true,
      tokenType: true,
      issuedAt: true,
      isConnected: true,
    },
  });

  if (!integration?.isConnected || !integration?.accessToken) return null;

  const expiresAtMs = integration.tokenExpiresAt
    ? new Date(integration.tokenExpiresAt).getTime()
    : 0;

  if (Date.now() >= expiresAtMs - SAFETY_MARGIN_MS) return null;

  return {
    accessToken: integration.accessToken,
    tokenType: integration.tokenType || 'Bearer',
    expiresAt: integration.tokenExpiresAt,
    issuedAt: integration.issuedAt,
  };
}

/**
 * Persist a token received from the Upstox notifier webhook.
 *
 * Payload shape (v3 notifier):
 *   { client_id, user_id, access_token, token_type, expires_at (ms string), issued_at (ms string), message_type }
 *
 * Idempotent: dedupes on issued_at + client_id — safe to call multiple times
 * with the same webhook payload without double-writing.
 *
 * @param {number} userId
 * @param {object} payload  Raw Upstox notifier payload
 * @returns {Promise<{saved: boolean, reason?: string, expiresAt?: Date}>}
 */
export async function set_token(userId, payload) {
  const {
    client_id,
    user_id,
    access_token,
    token_type = 'Bearer',
    expires_at,
    issued_at,
  } = payload;

  if (!access_token) {
    return { saved: false, reason: 'no access_token in payload' };
  }

  const integration = await prisma.upstoxIntegration.findFirst({ where: { userId } });
  if (!integration) {
    return { saved: false, reason: `no UpstoxIntegration found for userId=${userId}` };
  }

  const issuedAtMs = issued_at ? parseInt(issued_at, 10) : null;
  const expiresAtMs = expires_at ? parseInt(expires_at, 10) : null;

  // Dedupe: same issued_at + client_id already stored → skip
  if (issuedAtMs && client_id) {
    const existing = await prisma.upstoxTokenHistory.findFirst({
      where: {
        integrationId: integration.id,
        upstoxClientId: client_id,
        issuedAt: new Date(issuedAtMs),
      },
    });
    if (existing) {
      return {
        saved: false,
        reason: `duplicate: issued_at=${new Date(issuedAtMs).toISOString()} client_id=${client_id} already in history`,
      };
    }
  }

  const issuedAtDate = issuedAtMs ? new Date(issuedAtMs) : null;
  let expiresAtDate = expiresAtMs ? new Date(expiresAtMs) : null;

  // Fallback: decode JWT exp field if Upstox didn't send expires_at
  if (!expiresAtDate || expiresAtDate.getTime() === 0) {
    try {
      const jwtPayload = JSON.parse(
        Buffer.from(access_token.split('.')[1], 'base64').toString(),
      );
      if (jwtPayload.exp) expiresAtDate = new Date(jwtPayload.exp * 1000);
    } catch {
      // 3-hour fallback if JWT decode fails
      expiresAtDate = new Date(Date.now() + 3 * 60 * 60 * 1000);
    }
  }

  // Reject if not newer than what we already have
  const currentExpiry = integration.tokenExpiresAt
    ? new Date(integration.tokenExpiresAt)
    : null;
  if (currentExpiry && expiresAtDate && expiresAtDate <= currentExpiry) {
    return {
      saved: false,
      reason: `stored token (expires ${currentExpiry.toISOString()}) is newer than incoming (${expiresAtDate.toISOString()})`,
    };
  }

  // Write to primary store
  await prisma.upstoxIntegration.update({
    where: { id: integration.id },
    data: {
      accessToken: access_token,
      tokenType: token_type,
      tokenExpiresAt: expiresAtDate,
      issuedAt: issuedAtDate,
      upstoxUserId: user_id || null,
      upstoxClientId: client_id || null,
      isConnected: true,
      lastSyncAt: new Date(),
    },
  });

  // Append sanitized record to history
  await prisma.upstoxTokenHistory.create({
    data: {
      integrationId: integration.id,
      userId,
      tokenHead: access_token.substring(0, 4),
      tokenTail: access_token.substring(access_token.length - 4),
      tokenType: token_type,
      issuedAt: issuedAtDate,
      expiresAt: expiresAtDate,
      upstoxUserId: user_id || null,
      upstoxClientId: client_id || null,
    },
  });

  logger.info(
    `[token-store] Saved token for userId=${userId}: ` +
    `issued=${issuedAtDate?.toISOString()}, ` +
    `expires=${expiresAtDate?.toISOString()}, ` +
    `upstox_user=${user_id}, ` +
    `token=${access_token.substring(0, 4)}...${access_token.substring(access_token.length - 4)}`,
  );

  return { saved: true, expiresAt: expiresAtDate };
}

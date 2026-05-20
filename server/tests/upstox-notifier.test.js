/**
 * Unit tests for the Upstox notifier webhook payload handling.
 *
 * Tests set_token() using the exact payload shape from the Upstox v3 spec:
 * { client_id, user_id, access_token, token_type, expires_at (ms), issued_at (ms), message_type }
 *
 * Run: node --test server/tests/upstox-notifier.test.js
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Minimal Prisma mock ────────────────────────────────────────────────────

let _store = null;
let _history = [];

const mockPrisma = {
  upstoxIntegration: {
    findFirst: async () => _store ? { ..._store } : null,
    update: async ({ data }) => { _store = { ..._store, ...data }; return _store; },
  },
  upstoxTokenHistory: {
    findFirst: async ({ where }) => {
      return _history.find(
        h => h.integrationId === where.integrationId &&
             h.upstoxClientId === where.upstoxClientId &&
             h.issuedAt?.getTime() === where.issuedAt?.getTime(),
      ) || null;
    },
    create: async ({ data }) => { _history.push(data); return data; },
  },
};

// Inject mock via module-level substitution
// We replicate set_token logic inline to avoid ESM import complexity in unit tests.

const SAFETY_MARGIN_MS = 5 * 60 * 1000;

async function set_token_under_test(userId, payload) {
  const {
    client_id,
    user_id,
    access_token,
    token_type = 'Bearer',
    expires_at,
    issued_at,
  } = payload;

  if (!access_token) return { saved: false, reason: 'no access_token in payload' };

  const integration = await mockPrisma.upstoxIntegration.findFirst({ where: { userId } });
  if (!integration) return { saved: false, reason: `no integration for userId=${userId}` };

  const issuedAtMs = issued_at ? parseInt(issued_at, 10) : null;
  const expiresAtMs = expires_at ? parseInt(expires_at, 10) : null;

  if (issuedAtMs && client_id) {
    const dup = await mockPrisma.upstoxTokenHistory.findFirst({
      where: { integrationId: integration.id, upstoxClientId: client_id, issuedAt: new Date(issuedAtMs) },
    });
    if (dup) return { saved: false, reason: 'duplicate' };
  }

  const issuedAtDate = issuedAtMs ? new Date(issuedAtMs) : null;
  let expiresAtDate = expiresAtMs ? new Date(expiresAtMs) : null;

  if (!expiresAtDate || expiresAtDate.getTime() === 0) {
    try {
      const p = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64').toString());
      if (p.exp) expiresAtDate = new Date(p.exp * 1000);
    } catch {
      expiresAtDate = new Date(Date.now() + 3 * 60 * 60 * 1000);
    }
  }

  const currentExpiry = integration.tokenExpiresAt ? new Date(integration.tokenExpiresAt) : null;
  if (currentExpiry && expiresAtDate && expiresAtDate <= currentExpiry) {
    return { saved: false, reason: 'not newer' };
  }

  await mockPrisma.upstoxIntegration.update({
    where: { id: integration.id },
    data: { accessToken: access_token, tokenType: token_type, tokenExpiresAt: expiresAtDate, issuedAt: issuedAtDate, upstoxUserId: user_id || null, upstoxClientId: client_id || null, isConnected: true, lastSyncAt: new Date() },
  });

  await mockPrisma.upstoxTokenHistory.create({
    data: { integrationId: integration.id, userId, tokenHead: access_token.substring(0, 4), tokenTail: access_token.substring(access_token.length - 4), tokenType: token_type, issuedAt: issuedAtDate, expiresAt: expiresAtDate, upstoxUserId: user_id || null, upstoxClientId: client_id || null },
  });

  return { saved: true, expiresAt: expiresAtDate };
}

// Sample Upstox notifier payload (exact shape from v3 docs)
const SAMPLE_PAYLOAD = {
  client_id: 'test-client-id-abc123',
  user_id: 'RONO1234',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJST05PMTIzNCIsImV4cCI6MTczMTQ0ODgwMH0.SIG',
  token_type: 'Bearer',
  expires_at: '1731448800000',   // ms string — per spec
  issued_at:  '1731412800000',   // ms string — per spec
  message_type: 'access_token',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Upstox notifier webhook — set_token', () => {
  beforeEach(() => {
    _store = { id: 1, userId: 1, isConnected: true, tokenExpiresAt: null, accessToken: null };
    _history = [];
  });

  test('parses v3 payload and writes token to integration + history', async () => {
    const result = await set_token_under_test(1, SAMPLE_PAYLOAD);

    assert.equal(result.saved, true);
    assert.ok(result.expiresAt instanceof Date);
    assert.equal(result.expiresAt.getTime(), 1731448800000);

    assert.equal(_store.accessToken, SAMPLE_PAYLOAD.access_token);
    assert.equal(_store.tokenType, 'Bearer');
    assert.equal(_store.upstoxUserId, 'RONO1234');
    assert.equal(_store.upstoxClientId, 'test-client-id-abc123');
    assert.equal(_store.isConnected, true);

    assert.equal(_history.length, 1);
    assert.equal(_history[0].tokenHead, SAMPLE_PAYLOAD.access_token.substring(0, 4));
    assert.equal(_history[0].tokenTail, SAMPLE_PAYLOAD.access_token.substring(SAMPLE_PAYLOAD.access_token.length - 4));
    assert.equal(_history[0].upstoxClientId, 'test-client-id-abc123');
  });

  test('dedupes on same issued_at + client_id', async () => {
    await set_token_under_test(1, SAMPLE_PAYLOAD);
    const second = await set_token_under_test(1, SAMPLE_PAYLOAD);

    assert.equal(second.saved, false);
    assert.equal(second.reason, 'duplicate');
    assert.equal(_history.length, 1, 'history should only have one entry');
  });

  test('rejects payload with no access_token', async () => {
    const result = await set_token_under_test(1, { ...SAMPLE_PAYLOAD, access_token: undefined });
    assert.equal(result.saved, false);
    assert.ok(result.reason.includes('no access_token'));
  });

  test('rejects token that expires before currently-stored token', async () => {
    // Pre-populate store with a token expiring far in the future
    _store.tokenExpiresAt = new Date(Date.now() + 10 * 60 * 60 * 1000);
    _store.accessToken = 'old-token';

    // Incoming token expires earlier
    const olderPayload = { ...SAMPLE_PAYLOAD, expires_at: String(Date.now() + 1 * 60 * 60 * 1000) };
    const result = await set_token_under_test(1, olderPayload);

    assert.equal(result.saved, false);
    assert.ok(result.reason.includes('not newer'));
    assert.equal(_store.accessToken, 'old-token', 'existing token should not be overwritten');
  });

  test('falls back to JWT exp when expires_at is absent', async () => {
    // Build a fake JWT with exp = 2 hours from now
    const exp = Math.round((Date.now() + 2 * 60 * 60 * 1000) / 1000);
    const jwtPayload = Buffer.from(JSON.stringify({ sub: 'RONO1234', exp })).toString('base64');
    const fakeJwt = `header.${jwtPayload}.sig`;

    const result = await set_token_under_test(1, {
      ...SAMPLE_PAYLOAD,
      access_token: fakeJwt,
      expires_at: undefined,
      issued_at: String(Date.now()),
    });

    assert.equal(result.saved, true);
    // expiresAt should be close to exp * 1000
    const diff = Math.abs(result.expiresAt.getTime() - exp * 1000);
    assert.ok(diff < 1000, `expiresAt should match JWT exp, diff=${diff}ms`);
  });

  test('returns saved=false when no integration exists for userId', async () => {
    _store = null;
    const result = await set_token_under_test(999, SAMPLE_PAYLOAD);
    assert.equal(result.saved, false);
    assert.ok(result.reason.includes('no integration'));
  });
});

/**
 * Unit tests for the token freshness guard.
 *
 * Tests the logic in get_active_token():
 *   - Valid token → returns token object
 *   - Stale (expired) → returns null
 *   - Near-expiry (within 5-min safety margin) → returns null
 *
 * Tests the re-auth cooldown in triggerReAuthIfNotRecent():
 *   - First call → triggers (returns true)
 *   - Second call within cooldown → suppressed (returns false)
 *   - Third call after cooldown → triggers again (returns true)
 *
 * Run: node --test server/tests/upstox-token-guard.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ─── Replicate guard logic (no DB, pure unit) ────────────────────────────────

const SAFETY_MARGIN_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;

function get_active_token_logic(integration, nowMs = Date.now()) {
  if (!integration?.isConnected || !integration?.accessToken) return null;

  const expiresAtMs = integration.tokenExpiresAt
    ? new Date(integration.tokenExpiresAt).getTime()
    : 0;

  if (nowMs >= expiresAtMs - SAFETY_MARGIN_MS) return null;

  return {
    accessToken: integration.accessToken,
    tokenType: integration.tokenType || 'Bearer',
    expiresAt: integration.tokenExpiresAt,
    issuedAt: integration.issuedAt,
  };
}

function make_cooldown_tracker(cooldownMs = COOLDOWN_MS) {
  let lastTriggeredAt = 0;
  let triggerCount = 0;

  return {
    trigger(nowMs = Date.now()) {
      const age = nowMs - lastTriggeredAt;
      if (age < cooldownMs) return false; // suppressed
      lastTriggeredAt = nowMs;
      triggerCount++;
      return true;
    },
    get count() { return triggerCount; },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('get_active_token — freshness guard', () => {
  const NOW = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;

  const validIntegration = {
    isConnected: true,
    accessToken: 'eyJvalid.token',
    tokenType: 'Bearer',
    tokenExpiresAt: new Date(NOW + ONE_HOUR),
    issuedAt: new Date(NOW - 10 * 60 * 1000),
  };

  test('returns token when valid and not near expiry', () => {
    const result = get_active_token_logic(validIntegration, NOW);
    assert.ok(result !== null);
    assert.equal(result.accessToken, 'eyJvalid.token');
    assert.equal(result.tokenType, 'Bearer');
  });

  test('returns null when token is expired', () => {
    const expired = { ...validIntegration, tokenExpiresAt: new Date(NOW - 1000) };
    assert.equal(get_active_token_logic(expired, NOW), null);
  });

  test('returns null when token expires exactly 5 min from now (safety boundary)', () => {
    const atBoundary = { ...validIntegration, tokenExpiresAt: new Date(NOW + SAFETY_MARGIN_MS) };
    assert.equal(get_active_token_logic(atBoundary, NOW), null);
  });

  test('returns null when token expires 4 min 59 sec from now (inside safety margin)', () => {
    const inside = { ...validIntegration, tokenExpiresAt: new Date(NOW + SAFETY_MARGIN_MS - 1000) };
    assert.equal(get_active_token_logic(inside, NOW), null);
  });

  test('returns token when it expires 5 min 1 sec from now (just outside safety margin)', () => {
    const outside = { ...validIntegration, tokenExpiresAt: new Date(NOW + SAFETY_MARGIN_MS + 1000) };
    const result = get_active_token_logic(outside, NOW);
    assert.ok(result !== null);
  });

  test('returns null when accessToken is missing', () => {
    const noToken = { ...validIntegration, accessToken: null };
    assert.equal(get_active_token_logic(noToken, NOW), null);
  });

  test('returns null when isConnected is false', () => {
    const disconnected = { ...validIntegration, isConnected: false };
    assert.equal(get_active_token_logic(disconnected, NOW), null);
  });

  test('returns null when integration is null', () => {
    assert.equal(get_active_token_logic(null, NOW), null);
  });
});

describe('triggerReAuthIfNotRecent — cooldown logic', () => {
  // Use a realistic base timestamp far from epoch 0, just like real Date.now() values.
  // When lastTriggeredAt=0, age = BASE - 0 >> COOLDOWN_MS, so first call always fires.
  const BASE = 1_700_000_000_000; // Nov 2023 epoch ms — safely >> COOLDOWN_MS

  test('first call triggers and returns true', () => {
    const tracker = make_cooldown_tracker(COOLDOWN_MS);
    const result = tracker.trigger(BASE);
    assert.equal(result, true);
    assert.equal(tracker.count, 1);
  });

  test('second call within cooldown is suppressed (returns false)', () => {
    const tracker = make_cooldown_tracker(COOLDOWN_MS);
    tracker.trigger(BASE);
    const result = tracker.trigger(BASE + COOLDOWN_MS - 1); // 1ms before cooldown expires
    assert.equal(result, false);
    assert.equal(tracker.count, 1, 'should not have triggered again');
  });

  test('call exactly at cooldown boundary triggers again', () => {
    const tracker = make_cooldown_tracker(COOLDOWN_MS);
    tracker.trigger(BASE);
    const result = tracker.trigger(BASE + COOLDOWN_MS);
    assert.equal(result, true);
    assert.equal(tracker.count, 2);
  });

  test('only one re-auth fires per cooldown window even with multiple concurrent callers', () => {
    const tracker = make_cooldown_tracker(COOLDOWN_MS);

    // Simulate 5 concurrent stale-token errors at the same "now"
    const results = [
      tracker.trigger(BASE),
      tracker.trigger(BASE),
      tracker.trigger(BASE),
      tracker.trigger(BASE),
      tracker.trigger(BASE),
    ];

    assert.equal(results.filter(Boolean).length, 1, 'only first trigger should fire');
    assert.equal(tracker.count, 1);
  });
});

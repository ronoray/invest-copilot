/**
 * Integration smoke test: Upstox notifier → health endpoint.
 *
 * Posts a sample notifier payload to the running server and asserts
 * that /health/upstox reflects has_token: true.
 *
 * Requires a running local server with a seeded UpstoxIntegration row
 * (isConnected: true). Run after `npm start` or `npm run dev`.
 *
 * Usage:
 *   npm run test:upstox-auth          (via package.json script)
 *   make test-upstox-auth             (via Makefile)
 *   node server/tests/smoke/upstox-auth-smoke.js
 *
 * Environment:
 *   SMOKE_BASE_URL  — server URL (default: http://localhost:3100)
 *   SMOKE_TIMEOUT   — per-request timeout ms (default: 5000)
 */

import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:3100';
const TIMEOUT  = parseInt(process.env.SMOKE_TIMEOUT || '5000', 10);

const ONE_HOUR_MS = 60 * 60 * 1000;

// Build a fake JWT with exp = 1 hour from now (passes the 5-min safety margin)
function makeFakeJwt(expMs) {
  const header  = Buffer.from('{"alg":"HS256"}').toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'SMOKETEST', exp: Math.round(expMs / 1000) })).toString('base64url');
  return `${header}.${payload}.smoke-sig`;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: TIMEOUT,
    };

    const req = lib.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timeout after ${TIMEOUT}ms`)); });
    req.on('error', reject);

    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  console.log(`\n[smoke] Target: ${BASE_URL}`);

  // 1. Verify server is reachable
  console.log('[smoke] 1/3 — Checking /health...');
  const health = await request('GET', '/health');
  assert.equal(health.status, 200, `/health returned ${health.status}`);
  console.log('[smoke]       ✓ Server is up');

  // 2. Post sample notifier payload
  const expiresAtMs = Date.now() + ONE_HOUR_MS;
  const issuedAtMs  = Date.now();

  const notifierPayload = {
    client_id:    'smoke-client-id',
    user_id:      'SMOKETEST001',
    access_token: makeFakeJwt(expiresAtMs),
    token_type:   'Bearer',
    expires_at:   String(expiresAtMs),
    issued_at:    String(issuedAtMs),
    message_type: 'access_token',
  };

  console.log('[smoke] 2/3 — Posting to /upstox/notifier...');
  const notifier = await request('POST', '/upstox/notifier', notifierPayload);
  assert.equal(notifier.status, 200, `/upstox/notifier returned ${notifier.status}`);
  assert.equal(notifier.body?.status, 'ok', `Expected status=ok, got: ${JSON.stringify(notifier.body)}`);
  console.log('[smoke]       ✓ Notifier endpoint accepted payload');

  // 3. Wait briefly for async processing, then check health
  await new Promise(r => setTimeout(r, 500));

  console.log('[smoke] 3/3 — Checking /health/upstox...');
  const upstoxHealth = await request('GET', '/health/upstox');
  assert.equal(upstoxHealth.status, 200, `/health/upstox returned ${upstoxHealth.status}`);

  const h = upstoxHealth.body;
  assert.equal(h.has_token, true, `has_token should be true, got: ${JSON.stringify(h)}`);
  assert.ok(h.expires_in_seconds > 0, `expires_in_seconds should be positive, got ${h.expires_in_seconds}`);
  assert.ok(h.expires_at_iso, 'expires_at_iso should be set');

  console.log('[smoke]       ✓ /health/upstox reports has_token: true');
  console.log(`[smoke]       ✓ Token expires in ${h.expires_in_seconds}s (${h.expires_at_iso})`);
  console.log('\n[smoke] ALL CHECKS PASSED ✅\n');
}

run().catch(err => {
  console.error('\n[smoke] FAILED ❌:', err.message);
  process.exit(1);
});

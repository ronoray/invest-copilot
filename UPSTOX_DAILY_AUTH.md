# Upstox Daily Auth

## What this is

Long-lived Upstox trading tokens are not available. Instead, the server calls the v3 Access Token Request API each morning. Upstox sends you an in-app + WhatsApp approval prompt. One tap → the token lands automatically at the notifier webhook. No browser redirect, no copy-paste.

---

## 1. Configure in Upstox My Apps

Go to **account.upstox.com → Developer → My Apps → [your app]** and set:

| Field | Value |
|---|---|
| **Redirect URL** | `https://invest.hungrytimes.in/auth/upstox/callback` (required for app creation; not used daily) |
| **Postback URL** | `https://invest.hungrytimes.in/upstox/postback` |
| **Notifier Webhook Endpoint** | `https://invest.hungrytimes.in/upstox/notifier` |

Save and wait for Upstox to validate the URLs (they send a test POST).

---

## 2. Add env vars to `/opt/invest-copilot/.env`

```env
UPSTOX_CLIENT_ID=<your-api-key>
UPSTOX_CLIENT_SECRET=<your-api-secret>
UPSTOX_BASE_URL=https://api.upstox.com        # optional, this is the default
UPSTOX_DAILY_AUTH_CRON=30 8 * * 1-5          # optional, default is 8:30 AM IST weekdays
UPSTOX_NOTIFIER_PATH=/upstox/notifier         # optional, for reference only
UPSTOX_POSTBACK_PATH=/upstox/postback         # optional, for reference only
```

Then restart: `docker compose up -d --build invest-api`

---

## 3. Run the DB migration

```bash
cd /opt/invest-copilot/server
npx prisma migrate deploy
```

Or apply manually:

```bash
psql $DATABASE_URL < prisma/migrations/20260520000000_upstox_token_store/migration.sql
```

---

## 4. Daily user flow (3 lines)

1. At **8:30 AM IST**, the server automatically calls Upstox and you receive an in-app + WhatsApp prompt.
2. Open the **Upstox app** and tap **Approve**.
3. The server receives the token, sends you a Telegram confirmation, and all Execute buttons are live for the day.

---

## 5. Manual trigger

Fire the auth request immediately without waiting for the 8:30 AM cron:

```
POST /api/upstox/request-auth   (requires JWT in Authorization header)
```

Or via the Telegram bot: `/auth` → sends the request and notifies you to approve.

---

## 6. Health check

```
GET /health/upstox
```

Returns:
```json
{
  "has_token": true,
  "expires_at_iso": "2026-05-21T00:00:00.000Z",
  "expires_in_seconds": 43200,
  "last_refresh_iso": "2026-05-20T03:12:00.000Z",
  "last_auth_request_iso": "2026-05-20T03:00:30.000Z",
  "notifier_configured": true,
  "postback_configured": true
}
```

---

## 7. If the token is stale mid-day

Possible causes: you missed the Upstox approval prompt, or the token was invalidated.

**Fix (any of the following):**

- Telegram: `/auth` or tap the re-auth button in any stale-signal message
- HTTP: `POST /api/upstox/request-auth` with your JWT
- App: tap Approve when the new prompt arrives

The server will never silently retry with a stale token — it throws `TokenStaleError` and fires one re-auth request per 30-minute window.

---

## 8. Migrated files — direct token reads removed

All Upstox token reads now go through `server/services/upstoxTokenStore.js → get_active_token()`.

| File | Change |
|---|---|
| `server/services/upstoxService.js` | `getIntegration()` now calls `get_active_token()`; throws `TokenStaleError` + triggers re-auth when stale |
| `server/services/upstoxMarketData.js` | `getToken()` now calls `get_active_token()` |
| `server/routes/upstoxCallback.js` | `/webhook/upstox/token` handler delegates to `set_token()` |

No files in this codebase read `process.env.UPSTOX_ACCESS_TOKEN` directly — the token has always been stored in the database.

---

## 9. Tests

```bash
# Unit tests (no server required)
npm run test:upstox
# or: make test-upstox

# Integration smoke (requires running server)
npm run test:upstox-auth
# or: make test-upstox-auth
```

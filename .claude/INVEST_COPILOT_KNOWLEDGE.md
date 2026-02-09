# Investment Co-Pilot — Comprehensive Knowledge Base

> This document provides full context for any AI session working on this codebase.
> Last updated: Feb 9, 2026

## Project Overview

AI-powered investment tracking for Indian stock markets (NSE/BSE). Production at https://invest.hungrytimes.in.

**Core features:**
- Multi-portfolio management (different owners, brokers, risk profiles)
- AI-driven buy/sell recommendations via Claude API
- Upstox trading integration (API order placement)
- Screenshot-based trade entry (Claude Vision)
- GST-compliant tax exports (Excel)
- Telegram bot with per-portfolio alerts, trade signals, inline button actions
- Daily earning targets (AI-computed + user-set)
- Market holiday awareness (NSE calendar)

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite + Tailwind CSS + React Router 6 |
| Backend | Node.js 20 (ES modules) + Express + Prisma ORM |
| Database | PostgreSQL 16 (Docker) |
| AI | Anthropic Claude API (`@anthropic-ai/sdk`, model: `claude-sonnet-4-20250514`) |
| Trading | Upstox API v2 (REST) |
| Notifications | Telegram Bot API (`node-telegram-bot-api`, polling mode) |
| Infrastructure | Docker Compose + Traefik (SSL) + Nginx (static) + DigitalOcean droplet |
| Deployment | Push to `main` → GitHub webhook → systemd watcher → `deploy-invest.sh` |

---

## Environment Details

- **Droplet**: DigitalOcean, user `rono`, code at `/opt/invest-copilot`
- **SSH**: `ssh do-droplet` (key: `~/.ssh/id_claude_code`, ED25519)
- **Docker**: `docker compose` (v2 plugin, NOT `docker-compose`)
- **Network**: `traefik-network` (external, shared with other projects like hungry-times)
- **No test suite or linter** is configured
- **Cannot run backend locally** — needs Docker Postgres
- **Windows dev machine** with Git Bash; paths in bash: `/c/invest-copilot/server`

---

## Architecture

### Directory Structure

```
invest-copilot/
├── client/                    # React frontend
│   ├── src/
│   │   ├── pages/             # Route pages
│   │   │   ├── Dashboard.jsx
│   │   │   ├── Portfolio.jsx
│   │   │   ├── YourPlan.jsx
│   │   │   ├── HoldingsAnalyzer.jsx    # Daily targets + trade signals
│   │   │   ├── MultiAssetRecommendations.jsx
│   │   │   ├── AIRecommendations.jsx
│   │   │   ├── AIInsights.jsx
│   │   │   ├── TaxDashboard.jsx
│   │   │   ├── Watchlist.jsx
│   │   │   └── Login.jsx
│   │   ├── components/        # Reusable components
│   │   ├── context/           # AuthContext (React Context)
│   │   ├── utils/api.js       # Fetch-based HTTP client
│   │   ├── App.jsx            # Routes + navigation
│   │   └── main.jsx           # Entry point
│   └── vite.config.js         # Dev proxy /api → localhost:3100
│
├── server/                    # Express backend (ES modules)
│   ├── index.js               # App entry, middleware, routes, cron, startup
│   ├── routes/
│   │   ├── auth.js            # Login, register, /me
│   │   ├── portfolio.js       # Holdings CRUD, price sync, capital
│   │   ├── market.js          # Price lookups, search
│   │   ├── ai.js              # AI recommendations, screenshot parsing
│   │   ├── upstox.js          # Upstox order placement
│   │   ├── tax.js             # Tax summary, Excel export
│   │   ├── dailyTarget.js     # Daily earning targets API
│   │   ├── signals.js         # Trade signals API
│   │   ├── watchlist.js       # Watchlist CRUD
│   │   ├── proposal.js        # AI proposals
│   │   └── portfolioCalc.js   # Portfolio calculations
│   ├── services/
│   │   ├── prisma.js          # Shared Prisma singleton (ALWAYS import from here)
│   │   ├── telegramBot.js     # Bot commands, callbacks, getBot() export
│   │   ├── upstoxService.js   # Upstox API client
│   │   ├── aiAnalyzer.js      # Claude API for portfolio analysis
│   │   ├── advancedScreener.js  # scanMarketForOpportunities, buildProfileBrief
│   │   ├── multiAssetRecommendations.js  # Multi-asset allocation AI
│   │   ├── dailyTargetService.js  # AI daily target computation
│   │   ├── signalGenerator.js # AI trade signal generation
│   │   ├── marketData.js      # Alpha Vantage + NSE price data
│   │   ├── taxExportService.js # Excel report (exceljs)
│   │   ├── authService.js     # JWT, password hashing
│   │   └── logger.js          # Winston logger
│   ├── jobs/
│   │   ├── telegramAlerts.js  # 3 daily alerts (9AM, 6PM, 9PM) + price monitoring
│   │   ├── signalNotifier.js  # Trade signal Telegram notifications (every 5 min)
│   │   └── marketScanner.js   # Price updates (every 5 min during market hours)
│   ├── middleware/auth.js     # JWT authenticate + optionalAuth
│   ├── utils/
│   │   └── marketHolidays.js  # NSE holiday calendar 2025-2026
│   └── prisma/
│       └── schema.prisma      # Full database schema
│
├── docker/
│   ├── Dockerfile.api
│   └── Dockerfile.client
├── docker-compose.yml
└── CLAUDE.md                  # Project instructions
```

### Data Model (Core Hierarchy)

```
User (1) → Portfolio (N) → Holdings/Trades/DailyTargets/TradeSignals
User (1) → TelegramUser (1) → AlertHistory
User (1) → UpstoxIntegration (1) → UpstoxOrders
Portfolio (1) → AlertPreference (1)
TradeSignal (1) → SignalAck (N)
```

**Key Models:**
- `User` — auth, preferences, linked to everything
- `Portfolio` — broker, capital, risk profile, investor profile (goal, experience, age)
- `Holding` — stock positions (unique per portfolio+symbol+exchange)
- `Trade` — buy/sell history (source: MANUAL, API, SCREENSHOT)
- `DailyTarget` — per-portfolio per-day earning target (AI + user)
- `TradeSignal` — AI-generated BUY/SELL with confidence, trigger, status
- `SignalAck` — acknowledgement log (ACK, SNOOZE_30M, DISMISS)
- `UpstoxIntegration` — API credentials per user (one integration per user, not per portfolio)
- `UpstoxOrder` — order tracking (PENDING, COMPLETE, REJECTED, CANCELLED)
- `TelegramUser` — linked to User, preferences, mute state

### API Patterns

**Response format:** `{ success: true, data: {...} }` or `{ error: "message" }`

**Auth:** JWT Bearer tokens in `Authorization` header. Middleware: `authenticate` (required), `optionalAuth` (optional).

**Frontend API client:**
```js
import { api } from '../utils/api';  // NOT '../api/client'
api.get('/portfolio?all=true')  // List portfolios
api.get('/portfolio')           // All holdings with summary
api.get(`/portfolio/${id}/holdings`)  // Per-portfolio holdings
api.post('/signals/generate', { portfolioId })  // Generate signals
```

**Portfolio pattern (used in Dashboard, YourPlan, HoldingsAnalyzer):**
1. Load portfolios: `api.get('/portfolio?all=true')` → `data.portfolios`
2. Portfolio selector dropdown
3. Load data for selected portfolio

---

## API Endpoints Reference

### Auth (`/api/auth`) — public
- `POST /login` → JWT token
- `POST /register` → new user
- `GET /me` → current user info

### Portfolio (`/api/portfolio`) — authenticated
- `GET /?all=true` → list all portfolios (for dropdowns)
- `GET /` → all holdings with P&L summary
- `GET /:portfolioId/holdings` → specific portfolio holdings
- `POST /` → add holding
- `PUT /:id` → update holding
- `DELETE /:id` → remove holding
- `POST /sync` → sync prices (rate-limited, 12s/stock)
- `POST /:id/update-capital` → update capital

### AI (`/api/ai`) — authenticated
- `GET /recommendations` → AI categorized recommendations
- `POST /scan` → market scan
- `GET /portfolio-plan?portfolioId=X` → investment plan
- `GET /comprehensive-analysis` → 10-section deep analysis
- `POST /parse-screenshot` → upload screenshot (multipart)
- `POST /confirm-screenshot-trade` → save extracted trades

### Daily Target (`/api/daily-target`) — authenticated
- `GET /today?portfolioId=X` → today's target with gap
- `POST /today` → update earnedActual or userTarget
- `POST /today/ai-refresh` → trigger AI target computation

### Signals (`/api/signals`) — authenticated
- `GET /?portfolioId=X&status=PENDING` → list signals
- `POST /generate` → AI generates BUY/SELL signals
- `POST /:id/ack` → ACK/SNOOZE_30M/DISMISS signal

### Upstox (`/api/upstox`) — authenticated
- `POST /place-order` → place buy/sell order
- `GET /order/:orderId` → check order status
- `DELETE /order/:orderId` → cancel order
- `GET /holdings` → live holdings from Upstox

### Tax (`/api/tax`) — authenticated
- `GET /summary`, `POST /calculate`, `GET /opportunities`
- `GET /ltcg-timer/:holdingId`, `GET /export?year=2025`

### Market (`/api/market`) — optional auth
- `GET /price/:symbol`, `GET /intraday/:symbol`, `GET /search?q=X`

---

## Telegram Bot System

### Bot Info
- Username: `@investcopilot_ronoray_bot`
- Mode: Polling (not webhook)
- Token: `TELEGRAM_BOT_TOKEN` env var

### Architecture
- `telegramBot.js` — Bot initialization, commands, callback handlers
- `telegramAlerts.js` — 3 daily cron alerts + price monitoring
- `signalNotifier.js` — Trade signal notifications every 5 min

### Critical: `getBot()` Pattern
The bot is lazily initialized. **Always use `getBot()` for sending messages**, never store the result at import time:
```js
import { getBot } from '../services/telegramBot.js';
// CORRECT:
getBot()?.sendMessage(chatId, msg);
// WRONG:
const bot = getBot(); // DON'T cache at module level
```

### Commands
| Command | Description |
|---------|-------------|
| `/start` | Link Telegram to user account |
| `/help` | Show all commands |
| `/portfolios` | List all portfolios (numbered) |
| `/portfolio N` | View portfolio #N details |
| `/portfolio` | View all holdings (legacy) |
| `/recommend N` | AI stock picks for portfolio #N |
| `/multi N` | Multi-asset allocation for #N |
| `/scan` / `/scan N` | Market scan (optionally personalized) |
| `/price SYMBOL` | Get stock price |
| `/settings` | Alert preferences |
| `/mute` / `/unmute` | Toggle alerts |

### Portfolio Numbering
Portfolios ordered by `createdAt: 'asc'`, 1-indexed. `/portfolio 1` = oldest portfolio.

### Callback Queries (Inline Buttons)
Format: `sig_ack_123`, `sig_snooze_123`, `sig_dismiss_123`
- Parsed in `callback_query` handler in `telegramBot.js`
- Updates `TradeSignal.status` and creates `SignalAck` record
- Edits message markup to show result

### Scheduled Alerts (telegramAlerts.js)
| Time (IST) | Alert | Content |
|------------|-------|---------|
| 9:00 AM | Morning Deep Dive | Market overview + per-portfolio diversification & risk |
| 9,11,13,15 | Price Alerts | Target hit / stop loss alerts |
| 6:00 PM | Evening Review | Per-portfolio technical + value + sentiment |
| 9:00 PM | Game Plan | Per-portfolio strategy + personalized watchlist |

All crons use `timezone: 'Asia/Kolkata'`, skip weekends (1-5), skip holidays via `isTradingDay()`.

### Signal Notifier (signalNotifier.js)
- Runs every 5 min during market hours (9-15 IST, Mon-Fri)
- Finds PENDING/SNOOZED signals not notified in 30 min
- Sends Telegram message with inline ACK/Snooze/Dismiss buttons
- Re-sends every 30 min until user responds

---

## Upstox Integration

### Credentials
- Stored in `UpstoxIntegration` model (per-user, NOT per-portfolio)
- API key, secret, OAuth tokens
- `isConnected` flag indicates active session

### Order Flow
```
placeOrder(userId, { symbol, exchange, transactionType, orderType, quantity, price, portfolioId })
→ Validates integration + token
→ POST /order/place to Upstox API
→ Records UpstoxOrder in DB (status: PENDING)
→ Returns { success, orderId, dbOrderId }
```
- Product: Delivery ('D'), Validity: DAY
- Instrument key format: `NSE_EQ|SYMBOL`

### Current Gap
TradeSignal and UpstoxOrder are NOT linked. When user ACKs a signal, no order is placed. This is the next feature to build: Execute button on signal → placeOrder → track result.

---

## Known Issues & Bugs

### CRITICAL: Timezone Bug (UTC vs IST)
**The Docker container runs in UTC. All `new Date()` calls return UTC time.**

Affected code:
1. **`marketHolidays.js:63`** — `date.getDay()` uses UTC day. Monday 00:00-05:30 IST = Sunday in UTC → `isTradingDay()` returns false on Monday mornings.
2. **`marketHolidays.js:68-72`** — `formatDateKey()` uses `getFullYear()`, `getMonth()`, `getDate()` in UTC → holiday lookup fails for IST dates that cross midnight.
3. **`dailyTargetService.js:91-92`** — `today.setHours(0,0,0,0)` sets midnight UTC, not IST → wrong "today" for DB queries.
4. **`signalGenerator.js:31-32`** — Same midnight UTC bug for daily target lookup.
5. **`dailyTarget.js:68`** (route) — Same midnight UTC bug.
6. **`signalGenerator.js:99`** — `expiresAt.setUTCHours(10,0,0,0)` is correct (3:30 PM IST = 10:00 UTC), but the "already past" check at line 101 could fail near midnight IST.
7. **`docker-compose.yml`** — No `TZ` environment variable set on any container.

**Fix:** Either set `TZ=Asia/Kolkata` in docker-compose.yml, OR convert all date logic to IST-aware using offset calculations.

### Signal Notifier Log is Misleading
`signalNotifier.js:111` logs "Notified X pending trade signals" but this count is signals FOUND, not successfully SENT. If telegramUser lookup fails for all, it still logs the count.

### telegramBot.js Line 703
`export default getBot();` — evaluates at import time → returns null. The named export `export { getBot }` is what should be used. The default export is broken.

### Docker Container Name Conflict
The container sometimes gets named `6497c90e18c9_invest-api` instead of `invest-api` due to recreation conflicts. This causes issues with `docker compose exec`.

### Email Service SSL Error
`smtpout.secureserver.net` connection fails with "wrong version number" — GoDaddy SMTP config issue. Not critical (Telegram is primary notification channel).

---

## Key Service Functions

### `buildProfileBrief(portfolio)` — advancedScreener.js
Builds investor profile text for AI prompts. Includes: risk profile, goal, experience, age, holdings, capital. Used by telegramAlerts and signalGenerator.

### `scanMarketForOpportunities({ portfolio, targetCount, baseAmount })` — advancedScreener.js
AI-powered market scan. Returns `{ high: [], medium: [], low: [] }` stock picks.

### `generateMultiAssetRecommendations({ portfolio, capital, riskProfile, timeHorizon })` — multiAssetRecommendations.js
AI allocation across stocks, MFs, commodities, fixed income.

### `computeAiTarget(portfolioId)` — dailyTargetService.js
Claude API computes realistic daily earning target. Returns `{ aiTarget, aiRationale, aiConfidence }`.

### `generateTradeSignals(portfolioId)` — signalGenerator.js
Claude API generates up to 5 BUY/SELL signals. Sets `expiresAt` to 3:30 PM IST.

### `placeOrder(userId, orderParams)` — upstoxService.js
Places order via Upstox API. Records in DB.

---

## Development Commands

```bash
# Backend
cd server && npm install && npx prisma generate
npx prisma migrate dev     # Run migrations
npm run dev                 # Nodemon on port 3100
npx prisma studio           # DB GUI

# Frontend
cd client && npm install
npm run dev                 # Vite on port 3101
npm run build               # Production

# Docker (production on droplet)
ssh do-droplet
cd /opt/invest-copilot
docker compose build invest-api && docker compose up -d
docker compose exec invest-api npx prisma migrate deploy
docker compose logs invest-api --tail 50
```

### Creating Prisma Migrations Locally
Since we can't run `prisma migrate dev` locally (no DB), create migration SQL manually:
1. Create dir: `server/prisma/migrations/YYYYMMDDHHMMSS_name/migration.sql`
2. Write SQL matching schema changes
3. Force-add (*.sql is gitignored): `git add -f server/prisma/migrations/*/migration.sql`
4. Push, then on server: `docker compose exec invest-api npx prisma migrate deploy`

---

## Deployment

1. `git push origin main` → GitHub webhook fires
2. Systemd watcher on droplet detects trigger
3. `deploy-invest.sh` runs: git pull → docker compose build → up -d
4. Health check: `GET /api/health`

**If auto-deploy fails:**
```bash
ssh do-droplet
cd /opt/invest-copilot
git pull origin main
docker compose build invest-api invest-web
docker compose up -d
docker compose exec invest-api npx prisma migrate deploy  # if schema changed
```

---

## Conventions

- Backend uses ES modules (`import`/`export`, NOT `require`)
- Always import Prisma from `server/services/prisma.js` (singleton)
- Cron jobs use IST timezone via `node-cron` config
- File uploads: `server/uploads/screenshots/` via multer
- API responses: `{ success: true, data: {...} }` or `{ error: "message" }`
- Frontend state: AuthContext (React Context), no Redux/Zustand used currently
- All pages follow: load portfolios → selector → load data for selected

---

## Feature History

| Phase | Features |
|-------|----------|
| 1 | Core: auth, holdings CRUD, market data, AI recommendations |
| 2-3 | Multi-portfolio, capital management |
| 4-6 | Dashboard rewrite, Upstox trading, screenshot analysis, tax export |
| 7 | Portfolio CRUD, completeness alerts, multi-asset recommendations |
| 8 | Market holiday calendar, per-portfolio Telegram alerts, new bot commands |
| 9 | Holdings Analyzer, daily targets, trade signals, signal notifier, Telegram inline buttons |

---

## Pending / Next Features

1. **Timezone fix** — All date logic uses UTC, must use IST (critical bug)
2. **Upstox Execute via Telegram** — ACK button → placeOrder → track result
3. **Signal ↔ UpstoxOrder link** — Add `upstoxOrderId` to TradeSignal
4. **Auto-deploy fix** — Webhook trigger detection unreliable
5. **NSE holidays 2027+** — `marketHolidays.js` needs annual update

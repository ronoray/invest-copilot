# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Investment Co-Pilot: AI-powered investment tracking for Indian stock markets (NSE/BSE). Provides multi-portfolio management, AI-driven buy/sell recommendations via Claude API, Upstox trading integration, screenshot-based trade entry (Claude Vision), GST-compliant tax exports, and Telegram alerts. Production at https://invest.hungrytimes.in.

## Development Commands

### Backend (server/)
```bash
cd server
npm install
npx prisma generate          # Generate Prisma client
npx prisma migrate dev       # Run database migrations
npm run dev                  # Start with nodemon on port 3100
npm start                    # Production start
npx prisma studio            # Database GUI
```

### Frontend (client/)
```bash
cd client
npm install
npm run dev                  # Vite dev server on port 3101
npm run build                # Production build
```

### Database (Docker)
```bash
docker-compose up -d invest-postgres   # Start PostgreSQL 16
```

### Production Deployment
Push to `main` triggers GitHub webhook → systemd watcher → `deploy-invest.sh` (Docker rebuild + restart). Health check: `GET /api/health`.

**No test suite or linter is configured.**

## Architecture

### Stack
- **Frontend**: React 18 + Vite + Tailwind CSS + React Query + Zustand + React Router 6
- **Backend**: Node.js (ES modules) + Express + Prisma ORM + PostgreSQL 16
- **AI**: Anthropic Claude API (`@anthropic-ai/sdk`) — analysis, recommendations, screenshot parsing (Vision)
- **Trading**: Upstox API integration for order placement
- **Infrastructure**: Docker Compose + Traefik (SSL) + Nginx (static) + DigitalOcean

### Client-Server Communication
- REST API with JSON. Frontend at port 3101 proxies `/api` to backend at port 3100 (via vite.config.js).
- Auth: JWT Bearer tokens stored in localStorage. Backend `authenticate` middleware validates tokens.
- API responses follow `{ success: true, data: {...} }` or `{ error: "message" }` pattern.
- File uploads use multipart/form-data (multer on backend).
- CORS allows `invest.hungrytimes.in` and `localhost:3101`.

### Data Model (Prisma)
Core hierarchy: **User → Portfolio → Holdings/Trades**. Each user can have multiple portfolios (per broker/owner). Key models in `server/prisma/schema.prisma`:
- `User` - auth, preferences, relations to all entities
- `Portfolio` - broker, capital management, risk profile, market preferences
- `Holding` - stock positions (unique per portfolio+symbol+exchange)
- `Trade` - buy/sell history with source tracking (MANUAL, API, SCREENSHOT)
- `Proposal` - AI-generated buy/sell/hold recommendations
- `UpstoxIntegration` / `UpstoxOrder` - Upstox API credentials and order tracking
- `TradeScreenshot` - uploaded screenshots with AI-extracted trade data
- `CapitalHistory` - tracks capital changes per portfolio
- `TelegramUser` / `AlertPreference` - notification configuration per portfolio
- `TaxRecord` - per-user per-FY tax tracking

### Backend Structure
- **Routes** (`server/routes/`): Express routers:
  - `auth.js` - login, register, token refresh
  - `portfolio.js` - holdings CRUD, sync prices, capital management
  - `market.js` - price lookups, search
  - `ai.js` - AI recommendations, portfolio plan, comprehensive analysis, screenshot parsing
  - `upstox.js` - Upstox order placement, status, cancellation, holdings sync
  - `tax.js` - tax summary, calculation, opportunities, Excel export
  - `watchlist.js` - watchlist CRUD
  - `proposal.js` - AI proposals
  - `portfolioCalc.js` - portfolio calculations
- **Services** (`server/services/`): Business logic layer:
  - `aiAnalyzer.js` - Claude API integration for portfolio analysis
  - `upstoxService.js` - Upstox API client (placeOrder, getOrderStatus, cancelOrder, getHoldings)
  - `taxExportService.js` - Excel report generation (exceljs) with 4 sheets
  - `marketData.js` - Alpha Vantage + NSE scraping for price data
  - `portfolioCalculator.js` - P&L and metrics computation
  - `authService.js` - JWT generation, password hashing, login logic
  - `telegramBot.js` - Telegram bot setup and commands
  - `prisma.js` - Shared Prisma client instance (import from here, don't create new instances)
- **Jobs** (`server/jobs/`): Cron jobs via `node-cron` (IST timezone). Market scanner every 5 min during market hours; morning/evening Telegram alerts. Only active when `NODE_ENV=production` or `ENABLE_CRON=true`.
- **Middleware** (`server/middleware/auth.js`): JWT verification and rate limiting

### Frontend Structure
- **Pages** (`client/src/pages/`): Dashboard, Portfolio, YourPlan, AIRecommendations, AIInsights, TaxDashboard, Watchlist, Login
  - `Dashboard.jsx` - Real-time portfolio overview with portfolio selector, holdings table, AI insights, market status, quick actions
  - `YourPlan.jsx` - AI investment plan with Upstox buy buttons (for API-enabled portfolios), screenshot upload with editable review + confirm
  - `TaxDashboard.jsx` - LTCG/STCG tracking with Excel export download
  - `Login.jsx` - Authentication (no credentials displayed)
- **Components** (`client/src/components/`): CapitalChangeModal, etc.
- **State**: AuthContext (React Context) for user/auth state, React Query for server data, Zustand for local state
- **API client** (`client/src/utils/api.js`): fetch-based HTTP client with automatic Bearer token injection

### External APIs
- **Alpha Vantage**: Market data (rate-limited)
- **Anthropic Claude**: AI analysis, recommendations, and Vision API for screenshot parsing
- **Upstox API**: Order placement and holdings sync (for API-enabled portfolios)
- **Telegram Bot API**: Push notifications
- **GoDaddy SMTP**: Email notifications (Nodemailer)

## API Endpoints

### Auth (`/api/auth`)
- `POST /login` - Login, returns JWT
- `POST /register` - Register new user
- `GET /me` - Current user info

### Portfolio (`/api/portfolio`) — authenticated
- `GET /?all=true` - List all portfolios (for dropdown)
- `GET /` - All holdings with P&L summary (includes portfolioId, portfolioName per holding)
- `GET /:portfolioId/holdings` - Holdings for specific portfolio
- `POST /` - Add holding
- `PUT /:id` - Update holding
- `DELETE /:id` - Remove holding
- `POST /sync` - Sync all prices (rate-limited, 12s per stock)
- `POST /:id/update-capital` - Update portfolio capital

### AI (`/api/ai`) — authenticated
- `GET /recommendations` - Get AI recommendations (categorized: high/medium/low)
- `POST /scan` - Run market scan for opportunities
- `GET /portfolio-plan?portfolioId=1` - AI investment plan for portfolio
- `GET /comprehensive-analysis` - 10-section deep analysis via Claude
- `POST /parse-screenshot` - Upload trade screenshot (multipart), extract via Claude Vision
- `POST /confirm-screenshot-trade` - Confirm and save extracted trades to portfolio

### Upstox (`/api/upstox`) — authenticated
- `POST /place-order` - Place buy/sell order via Upstox
- `GET /order/:orderId` - Check order status
- `DELETE /order/:orderId` - Cancel order
- `GET /holdings` - Fetch live holdings from Upstox

### Tax (`/api/tax`) — authenticated
- `GET /summary` - Tax breakdown (LTCG/STCG)
- `POST /calculate` - Calculate tax for a trade
- `GET /opportunities` - Tax optimization opportunities
- `GET /ltcg-timer/:holdingId` - Time remaining to LTCG
- `GET /export?year=2025` - Download Excel tax report (4 sheets: All Trades, Portfolio Summary, Tax Summary, Quarterly)

### Market (`/api/market`) — optional auth
- `GET /price/:symbol` - Current price
- `GET /intraday/:symbol` - 5-min candles
- `GET /search?q=query` - Search stocks

### Watchlist (`/api/watchlist`) — authenticated
- `GET /` - Get watchlist
- `POST /` - Add to watchlist
- `DELETE /:id` - Remove item

## Key Conventions
- Backend uses ES modules (`"type": "module"` in package.json) — use `import`/`export`, not `require`
- Always import Prisma client from `server/services/prisma.js` (shared singleton)
- Database schema changes require running `npx prisma migrate dev` then `npx prisma generate`
- Docker Compose uses Traefik labels for routing; API is behind `/api` path prefix
- Cron jobs use IST timezone (Indian Standard Time) for market hours alignment
- File uploads go to `server/uploads/screenshots/` via multer
- Dashboard and YourPlan follow same pattern: load portfolios → selector → load data for selected portfolio

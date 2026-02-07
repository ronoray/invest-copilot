# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Investment Co-Pilot: AI-powered investment tracking for Indian stock markets (NSE/BSE). Provides portfolio management, AI-driven buy/sell recommendations via Claude API, and Telegram alerts. Production at https://invest.hungrytimes.in.

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
- **AI**: Anthropic Claude API (`@anthropic-ai/sdk`)
- **Infrastructure**: Docker Compose + Traefik (SSL) + Nginx (static) + DigitalOcean

### Client-Server Communication
- REST API with JSON. Frontend at port 3101 proxies `/api` to backend at port 3100 (via vite.config.js).
- Auth: JWT Bearer tokens stored in localStorage. Backend `authenticate` middleware validates tokens.
- API responses follow `{ success: true, data: {...} }` or `{ error: "message" }` pattern.
- CORS allows `invest.hungrytimes.in` and `localhost:3101`.

### Data Model (Prisma)
Core hierarchy: **User → Portfolio → Holdings/Trades**. Each user can have multiple portfolios (per broker/owner). Key models in `server/prisma/schema.prisma`:
- `User` - auth, preferences, relations to all entities
- `Portfolio` - broker, capital management, risk profile, market preferences
- `Holding` - stock positions (unique per portfolio+symbol+exchange)
- `Trade` - buy/sell history with source tracking (MANUAL, API, SCREENSHOT)
- `Proposal` - AI-generated buy/sell/hold recommendations
- `TelegramUser` / `AlertPreference` - notification configuration per portfolio

### Backend Structure
- **Routes** (`server/routes/`): Express routers for auth, portfolio, market, ai, watchlist, tax, plan, deploy
- **Services** (`server/services/`): Business logic layer. Key services:
  - `aiAnalyzer.js` - Claude API integration for portfolio analysis
  - `marketData.js` - Alpha Vantage + NSE scraping for price data
  - `portfolioCalculator.js` - P&L and metrics computation
  - `authService.js` - JWT generation, password hashing, login logic
  - `telegramBot.js` - Telegram bot setup and commands
  - `prisma.js` - Shared Prisma client instance (import from here, don't create new instances)
- **Jobs** (`server/jobs/`): Cron jobs via `node-cron` (IST timezone). Market scanner every 5 min during market hours; morning/evening Telegram alerts. Only active when `NODE_ENV=production` or `ENABLE_CRON=true`.
- **Middleware** (`server/middleware/auth.js`): JWT verification and rate limiting

### Frontend Structure
- **Pages** (`client/src/pages/`): Dashboard, Portfolio, YourPlan, AIRecommendations, AIInsights, TaxDashboard, Watchlist, Login
- **State**: AuthContext (React Context) for user/auth state, React Query for server data, Zustand for local state
- **API client** (`client/src/utils/api.js`): fetch-based HTTP client with automatic Bearer token injection

### External APIs
- **Alpha Vantage**: Market data (rate-limited)
- **Anthropic Claude**: AI analysis and recommendations
- **Telegram Bot API**: Push notifications
- **GoDaddy SMTP**: Email notifications (Nodemailer)

## Key Conventions
- Backend uses ES modules (`"type": "module"` in package.json) — use `import`/`export`, not `require`
- Always import Prisma client from `server/services/prisma.js` (shared singleton)
- Database schema changes require running `npx prisma migrate dev` then `npx prisma generate`
- Docker Compose uses Traefik labels for routing; API is behind `/api` path prefix
- Cron jobs use IST timezone (Indian Standard Time) for market hours alignment

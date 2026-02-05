# Investment Co-Pilot - Complete System Architecture

**Last Updated**: 2026-02-05  
**Status**: Production - Core features operational, alerts system needs debugging

---

## Table of Contents
1. [System Overview](#system-overview)
2. [Tech Stack](#tech-stack)
3. [Infrastructure](#infrastructure)
4. [Database Schema](#database-schema)
5. [API Endpoints](#api-endpoints)
6. [File Structure](#file-structure)
7. [Claude API Integration](#claude-api-integration)
8. [Telegram Bot](#telegram-bot)
9. [Cron Jobs & Automation](#cron-jobs--automation)
10. [Deployment Pipeline](#deployment-pipeline)
11. [Environment Configuration](#environment-configuration)
12. [Current System Status](#current-system-status)

---

## System Overview

Investment Co-Pilot is an AI-powered investment tracking and recommendation system that:
- Tracks stock portfolios with real-time P&L calculation
- Generates AI-powered investment recommendations using Claude API
- Delivers personalized morning/evening market alerts via Telegram
- Supports multiple portfolios (planned) with different market preferences (India NSE, US markets)
- Scans markets for buy/sell opportunities using technical indicators

**Core Capabilities:**
- Portfolio Management (holdings, trades, P&L tracking)
- AI-Powered Analysis (Claude API integration)
- Market Scanning (automated technical analysis)
- Alert System (Telegram notifications)
- Tax Tracking (capital gains, dividend tracking)

---

## Tech Stack

### Backend
- **Runtime**: Node.js 20 (LTS)
- **Framework**: Express.js
- **Database**: PostgreSQL 16 (Alpine)
- **ORM**: Prisma 5.22.0
- **Authentication**: JWT tokens (access + refresh)
- **Security**: Helmet, bcrypt, rate limiting

### Frontend
- **Framework**: React 18
- **Build Tool**: Vite 5.4
- **Routing**: React Router
- **HTTP Client**: Axios
- **Styling**: Tailwind CSS (assumed based on modern React setup)

### Infrastructure
- **Containerization**: Docker + Docker Compose
- **Reverse Proxy**: Traefik (with Let's Encrypt SSL)
- **Web Server**: Nginx (for frontend static files)
- **Hosting**: DigitalOcean Droplet (Ubuntu 24)
- **Domain**: invest.hungrytimes.in
- **SSL**: Cloudflare + Let's Encrypt

### External Services
- **AI Analysis**: Claude API (Anthropic)
- **Market Data**: Alpha Vantage API (with NSE web scraping fallback)
- **Messaging**: Telegram Bot API
- **Email**: GoDaddy SMTP
- **SMS**: MSG91 (configured but disabled)
- **WhatsApp**: MSG91 (configured but disabled)

---

## Infrastructure

### Docker Architecture
```
┌─────────────────────────────────────────────┐
│              Traefik (Reverse Proxy)         │
│           invest.hungrytimes.in              │
└───────────────┬─────────────────────────────┘
                │
        ┌───────┴───────┐
        │               │
┌───────▼──────┐ ┌─────▼────────┐
│  invest-web  │ │  invest-api  │
│   (Nginx)    │ │  (Node.js)   │
│   Port 80    │ │  Port 3100   │
└──────────────┘ └──────┬───────┘
                        │
                ┌───────▼────────┐
                │ invest-postgres│
                │  (PostgreSQL)  │
                │   Port 5432    │
                └────────────────┘
```

### File System Layout

**On Droplet (`/opt/invest-copilot`):**
```
/opt/invest-copilot/
├── client/               # React frontend source
├── server/               # Node.js backend source
│   ├── index.js          # Main server entry
│   ├── routes/           # API route handlers
│   ├── services/         # Business logic
│   ├── middleware/       # Auth, validation
│   ├── jobs/             # Cron job implementations
│   └── prisma/           # Database schema & migrations
├── docker/
│   ├── Dockerfile.api    # Backend container
│   ├── Dockerfile.client # Frontend container
│   └── nginx.conf        # Nginx configuration
├── docker-compose.yml    # Container orchestration
├── deploy-invest.sh      # Deployment script
├── .env                  # Environment variables
└── DEPLOYED_SHA          # Last deployed commit

/var/log/invest-deploy.log  # Deployment logs
/tmp/invest-deploy-trigger.json  # Webhook trigger file (ephemeral)
```

**On Windows Dev Machine:**
```
C:\invest-copilot\
├── (same structure as droplet)
└── .git/                 # Git repository
```

### Network Configuration

- **External Access**: `https://invest.hungrytimes.in`
- **Cloudflare**: DNS + DDoS protection
- **Traefik Routes**:
  - `/` → invest-web (frontend)
  - `/api/*` → invest-api (backend)
- **Traefik Network**: All containers on shared `traefik-network`

---

## Database Schema

**Database**: `investcopilot` (PostgreSQL 16)  
**Schema Management**: Prisma migrations

### Core Tables

#### **User**
```prisma
model User {
  id              Int       @id @default(autoincrement())
  email           String    @unique
  phone           String?   @unique
  password        String
  name            String
  role            String    @default("user")  // admin, user
  isActive        Boolean   @default(true)
  emailVerified   Boolean   @default(false)
  phoneVerified   Boolean   @default(false)
  telegramChatId  String?   @unique
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  
  // Relations
  holdings        Holding[]
  trades          Trade[]
  watchlist       Watchlist[]
  proposals       Proposal[]
  taxRecords      TaxRecord[]
}
```

#### **Holding**
```prisma
model Holding {
  id            Int      @id @default(autoincrement())
  userId        Int
  symbol        String
  quantity      Int
  avgPrice      Decimal  @db.Decimal(10, 2)
  currentPrice  Decimal  @db.Decimal(10, 2)  // Updated by market scanner
  exchange      String   @default("NSE")  // NSE, BSE, NASDAQ, NYSE
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  
  user          User     @relation(fields: [userId], references: [id])
  @@index([userId, symbol])
}
```

#### **Trade**
```prisma
model Trade {
  id            Int      @id @default(autoincrement())
  userId        Int
  symbol        String
  type          String   // BUY, SELL
  quantity      Int
  price         Decimal  @db.Decimal(10, 2)
  fees          Decimal? @db.Decimal(10, 2)
  profit        Decimal? @db.Decimal(10, 2)  // For SELL trades
  executedAt    DateTime
  notes         String?
  createdAt     DateTime @default(now())
  
  user          User     @relation(fields: [userId], references: [id])
  @@index([userId, symbol, executedAt])
}
```

#### **Watchlist**
```prisma
model Watchlist {
  id          Int      @id @default(autoincrement())
  userId      Int
  symbol      String
  targetPrice Decimal? @db.Decimal(10, 2)
  stopLoss    Decimal? @db.Decimal(10, 2)
  notes       String?
  createdAt   DateTime @default(now())
  
  user        User     @relation(fields: [userId], references: [id])
  @@unique([userId, symbol])
}
```

#### **Proposal** (AI Recommendations)
```prisma
model Proposal {
  id              Int      @id @default(autoincrement())
  userId          Int
  symbol          String
  action          String   // BUY, SELL, HOLD
  targetPrice     Decimal  @db.Decimal(10, 2)
  stopLoss        Decimal  @db.Decimal(10, 2)
  reasoning       String   @db.Text  // Claude AI analysis
  confidence      String   // HIGH, MEDIUM, LOW
  timeHorizon     String   // SHORT, MEDIUM, LONG
  riskCategory    String   // HIGH, MEDIUM, LOW
  status          String   @default("PENDING")  // PENDING, ACCEPTED, REJECTED
  createdAt       DateTime @default(now())
  expiresAt       DateTime?
  
  user            User     @relation(fields: [userId], references: [id])
  @@index([userId, status, createdAt])
}
```

#### **Config**
```prisma
model Config {
  id              Int      @id @default(autoincrement())
  key             String   @unique
  value           String   @db.Text
  startingCapital Decimal? @db.Decimal(12, 2)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

#### **TaxRecord**
```prisma
model TaxRecord {
  id            Int      @id @default(autoincrement())
  userId        Int
  financialYear String   // e.g., "2025-26"
  type          String   // STCG, LTCG, DIVIDEND
  amount        Decimal  @db.Decimal(10, 2)
  taxAmount     Decimal  @db.Decimal(10, 2)
  createdAt     DateTime @default(now())
  
  user          User     @relation(fields: [userId], references: [id])
  @@index([userId, financialYear])
}
```

**Key Relationships:**
- User → Holdings (1:N)
- User → Trades (1:N)
- User → Watchlist (1:N)
- User → Proposals (1:N)
- User → TaxRecords (1:N)

---

## API Endpoints

**Base URL**: `https://invest.hungrytimes.in/api`

### Authentication (`/api/auth`)
- `POST /register` - Create new account
- `POST /login` - Login with email/password
- `POST /logout` - Logout and invalidate tokens
- `POST /refresh` - Refresh access token
- `GET /me` - Get current user profile (requires auth)

### Portfolio (`/api/portfolio`)
All endpoints require authentication.

- `GET /summary` - Portfolio overview (holdings, P&L, value)
- `GET /holdings` - List all holdings
- `POST /holdings` - Add new holding
- `PUT /holdings/:id` - Update holding
- `DELETE /holdings/:id` - Remove holding
- `GET /trades` - Trade history
- `POST /trades` - Record new trade
- `GET /performance` - Performance metrics over time

### Portfolio Calculator (`/api/portfolio-calc`)
- `GET /summary` - Complete portfolio snapshot
- `GET /reinvestment` - Reinvestment suggestions
- `POST /allocation` - Calculate allocation (risk-based)
- `POST /transaction` - Record deposit/withdrawal

### Market Data (`/api/market`)
- `GET /quote/:symbol` - Real-time stock quote
- `GET /search` - Search stocks by name/symbol
- `GET /trending` - Trending stocks
- `GET /scan` - Market scan results (buy signals)

### AI Proposals (`/api/proposals`)
- `GET /` - List AI recommendations
- `GET /:id` - Get specific proposal
- `POST /:id/accept` - Accept recommendation
- `POST /:id/reject` - Reject recommendation

### Watchlist (`/api/watchlist`)
- `GET /` - List watched stocks
- `POST /` - Add to watchlist
- `PUT /:id` - Update watchlist item
- `DELETE /:id` - Remove from watchlist

### AI Analysis (`/api/ai`)
- `POST /portfolio-plan` - Generate investment plan
- `POST /analyze-stock` - Analyze specific stock
- `POST /market-outlook` - Get market overview

### Tax (`/api/tax`)
- `GET /summary/:year` - Tax summary for financial year
- `GET /records` - All tax records
- `POST /calculate` - Calculate tax liability

### Deployment (`/api/deploy`)
- `POST /webhook` - GitHub webhook (no auth required)
- `POST /trigger` - Manual deployment trigger (requires auth)

### Health Check
- `GET /health` - API health status
- `GET /api/health` - Detailed service health

---

## File Structure

### Backend (`/opt/invest-copilot/server/`)
```
server/
├── index.js                    # Main Express server
├── package.json                # Dependencies
├── prisma/
│   ├── schema.prisma           # Database schema
│   └── migrations/             # Database migrations
├── routes/
│   ├── auth.js                 # Authentication routes
│   ├── portfolio.js            # Portfolio CRUD
│   ├── portfolioCalc.js        # Portfolio calculations
│   ├── market.js               # Market data routes
│   ├── proposal.js             # AI proposals
│   ├── watchlist.js            # Watchlist routes
│   ├── ai.js                   # AI analysis routes
│   └── tax.js                  # Tax calculations
├── services/
│   ├── authService.js          # JWT, password hashing
│   ├── portfolioCalculator.js  # Portfolio metrics
│   ├── marketService.js        # Market data fetching
│   ├── aiService.js            # 🔧 Claude API integration
│   ├── telegramBot.js          # 🔧 Telegram bot setup
│   ├── logger.js               # Winston logging
│   ├── emailService.js         # Email notifications
│   ├── smsService.js           # SMS notifications (disabled)
│   ├── prisma.js               # ✅ Shared Prisma client
│   └── deploy-webhook.js       # ✅ Deployment webhook handler
├── middleware/
│   ├── auth.js                 # JWT verification
│   ├── validation.js           # Input validation
│   └── errorHandler.js         # Error handling
├── jobs/
│   ├── marketScanner.js        # 🔧 Market scanning cron
│   └── telegramAlerts.js       # 🔧 Alert delivery cron
└── logs/                       # Application logs
```

### Frontend (`/opt/invest-copilot/client/`)
```
client/
├── src/
│   ├── App.jsx                 # Main React app
│   ├── main.jsx                # React entry point
│   ├── api.js                  # API client wrapper
│   ├── components/             # React components
│   │   ├── Dashboard.jsx       # Main dashboard
│   │   ├── Portfolio.jsx       # Portfolio view
│   │   ├── Holdings.jsx        # Holdings table
│   │   ├── Trades.jsx          # Trade history
│   │   ├── Watchlist.jsx       # Watchlist view
│   │   ├── Proposals.jsx       # AI recommendations
│   │   ├── MarketScan.jsx      # Market scanner results
│   │   └── Login.jsx           # Auth forms
│   ├── hooks/                  # Custom React hooks
│   └── utils/                  # Helper functions
├── index.html                  # HTML template
├── vite.config.js              # Vite configuration
└── package.json                # Dependencies
```

---

## Claude API Integration

**Status**: 🔧 Configured but not sending alerts

### Configuration

**Environment Variables:**
```bash
CLAUDE_API_KEY=sk-ant-xxx  # Anthropic API key
```

**Service File**: `server/services/aiService.js`

### Current Implementation
```javascript
// server/services/aiService.js
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

export async function generatePortfolioPlan(portfolio, reinvestmentCapacity) {
  const prompt = `
    Analyze this portfolio and provide investment recommendations:
    
    Portfolio Summary:
    - Current Value: ₹${portfolio.currentValue}
    - Total Invested: ₹${portfolio.totalInvested}
    - Unrealized P&L: ₹${portfolio.unrealizedPL} (${portfolio.totalPLPercent}%)
    - Available to Reinvest: ₹${reinvestmentCapacity}
    
    Holdings:
    ${portfolio.holdings.map(h => `- ${h.symbol}: ${h.quantity} shares @ ₹${h.avgPrice}`).join('\n')}
    
    Provide:
    1. Portfolio health assessment
    2. Specific stock recommendations (buy/sell/hold)
    3. Risk diversification suggestions
    4. Actionable next steps
  `;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  return message.content[0].text;
}

export async function analyzeStock(symbol, currentPrice, marketData) {
  // Similar implementation for stock analysis
}
```

**Usage Points:**
- `/api/ai/portfolio-plan` - Manual portfolio analysis
- `/api/ai/analyze-stock` - Manual stock analysis
- Cron jobs (morning/evening) - 🔧 Should auto-generate but not working

### Issues

**Problem**: AI analysis API endpoints work when called manually, but automated cron jobs are not triggering Claude API calls.

**Symptoms:**
- Manual API calls to `/api/ai/*` return Claude analysis ✅
- Cron jobs run on schedule ✅
- But morning/evening alerts not sent ❌

**Likely Causes:**
1. Cron job not calling AI service properly
2. Error in alert generation logic (fails silently)
3. Missing error handling in cron implementation

---

## Telegram Bot

**Status**: 🔧 Configured but alerts not sending

### Configuration

**Environment Variables:**
```bash
TELEGRAM_BOT_TOKEN=7908584378:AAF...  # Bot token from @BotFather
TELEGRAM_ADMIN_ID=1234567890          # Your Telegram user ID
ENABLE_TELEGRAM_NOTIFICATIONS=true
```

**Bot Username**: `@YourInvestCopilot_bot` (example)

### Implementation

**Service File**: `server/services/telegramBot.js`
```javascript
import TelegramBot from 'node-telegram-bot-api';
import logger from './logger.js';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Bot commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Welcome to Investment Co-Pilot! 🚀');
});

bot.onText(/\/portfolio/, async (msg) => {
  // Fetch and send portfolio summary
});

bot.onText(/\/watchlist/, async (msg) => {
  // Send watchlist
});

export async function sendAlert(chatId, message) {
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    logger.info(`Alert sent to ${chatId}`);
  } catch (error) {
    logger.error('Failed to send alert:', error);
  }
}

export function initTelegramBot() {
  logger.info('Telegram bot initialized');
}
```

### Registered Commands

- `/start` - Welcome message
- `/portfolio` - Portfolio summary
- `/watchlist` - Watchlist
- `/help` - Available commands

### Alert Format (Planned)

**Morning Alert (9:00 AM IST):**
```
🌅 Good Morning!

📊 Your Portfolio Summary:
Current Value: ₹1,50,000 (+2.3%)
Today's P&L: +₹3,450

🎯 Top Picks for Today:
- RELIANCE - Strong buy signal (RSI: 32)
- TCS - Hold, near resistance
- HDFCBANK - Consider taking profit

⚠️ Watchlist Alerts:
- INFY reached target price ₹1,450

💡 Market Outlook:
Bullish sentiment, Nifty trending up...

[Powered by Claude AI]
```

**Evening Alert (6:00 PM IST):**
```
🌆 Market Wrap-Up

📈 Today's Performance:
Your Portfolio: +1.8%
Nifty 50: +0.5%
You outperformed market by 1.3% 🎉

📊 Holdings Update:
Winners: RELIANCE (+3.2%), TCS (+1.5%)
Losers: PAYTM (-2.1%)

🔍 AI Insights:
Technical analysis suggests...

💼 Action Items for Tomorrow:
1. Consider booking profit in RELIANCE
2. Watch for HDFC dip entry

[Powered by Claude AI]
```

---

## Cron Jobs & Automation

**Status**: ✅ Cron jobs running | 🔧 But alerts not triggering

### Configured Jobs

**Location**: `server/jobs/`

#### 1. Market Scanner (`marketScanner.js`)

**Schedule**: Every 5 minutes during market hours (9:15 AM - 3:30 PM IST, Mon-Fri)

**Cron Expression**: `*/5 9-15 * * 1-5`

**Functions:**
- Scans watchlist for price alerts
- Updates current prices in holdings
- Generates buy/sell signals based on technical indicators
- Identifies market opportunities

**Current Behavior** (from logs):
```
✅ Scanner runs successfully
✅ Fetches market data
✅ Updates holdings prices
❌ Not triggering AI analysis
❌ Not sending alerts
```

**Implementation**:
```javascript
// server/jobs/marketScanner.js
import cron from 'node-cron';
import { scanMarket } from '../services/marketService.js';
import logger from '../services/logger.js';

export function initMarketScanner() {
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    logger.info('Running market scanner...');
    await scanMarket();
  }, {
    timezone: 'Asia/Kolkata'
  });
}
```

#### 2. Telegram Alerts (`telegramAlerts.js`)

**Schedules:**
- Morning Digest: `0 9 * * 1-5` (9:00 AM IST, Mon-Fri)
- Evening Summary: `0 18 * * 1-5` (6:00 PM IST, Mon-Fri)

**Functions:**
- Morning: Portfolio summary + AI market outlook + top picks
- Evening: Day's performance + market wrap + tomorrow's action items

**Current Status**: 🔧 **NOT SENDING ALERTS**

**Implementation**:
```javascript
// server/jobs/telegramAlerts.js
import cron from 'node-cron';
import { sendMorningDigest, sendEveningDigest } from '../services/alertService.js';
import logger from '../services/logger.js';

export function initTelegramAlerts() {
  // Morning digest
  cron.schedule('0 9 * * 1-5', async () => {
    logger.info('Sending morning digest...');
    await sendMorningDigest();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Evening digest
  cron.schedule('0 18 * * 1-5', async () => {
    logger.info('Sending evening digest...');
    await sendEveningDigest();
  }, {
    timezone: 'Asia/Kolkata'
  });
}
```

### Cron Initialization

**Location**: `server/index.js`
```javascript
if (process.env.NODE_ENV === 'production' || process.env.ENABLE_CRON === 'true') {
  // Market scanner - every 5 minutes during market hours
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    try {
      logger.info('Running market scanner...');
      await scanMarket();
    } catch (error) {
      logger.error('Market scanner error:', error);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  logger.info('Cron jobs initialized');
}
```

**Current State**: Cron jobs ARE initializing and running (confirmed in logs), but alert functions are not executing properly.

---

## Deployment Pipeline

**Status**: ✅ FULLY OPERATIONAL

### Workflow
```
Developer (Windows)
    ↓ git push origin main
GitHub Repository
    ↓ Webhook POST
invest.hungrytimes.in/api/deploy/webhook
    ↓ Write trigger file
/tmp/invest-deploy-trigger.json
    ↓ Detected by systemd watcher (every 5s)
/opt/invest-copilot/deploy-invest.sh
    ↓
Git pull → Docker build → Container restart → Health check
    ↓
✅ Deployment Complete
```

### Components

#### 1. GitHub Webhook

**URL**: `https://invest.hungrytimes.in/api/deploy/webhook`  
**Secret**: Configured in `.env` as `GITHUB_WEBHOOK_SECRET`  
**Events**: Push to `main` branch

#### 2. Webhook Handler

**File**: `server/services/deploy-webhook.js`
```javascript
export async function handleDeployWebhook(req, res) {
  // Verify signature
  // Check branch === 'main'
  // Write trigger file to /host-tmp/invest-deploy-trigger.json
  // Return success
}
```

#### 3. Systemd Watcher

**Service**: `/etc/systemd/system/invest-deploy-watcher.service`

**Function**: Polls for trigger file every 5 seconds, executes deployment script when detected.

**Status**: `sudo systemctl status invest-deploy-watcher`

#### 4. Deployment Script

**File**: `/opt/invest-copilot/deploy-invest.sh`

**Steps:**
1. Git fetch & compare SHAs
2. Exit if already at latest commit
3. Git reset --hard origin/main
4. Docker compose build (no cache)
5. Docker compose down
6. Docker compose up -d
7. Health check (wait up to 120s)
8. Save deployed SHA
9. Log success/failure

**Logs**: `/var/log/invest-deploy.log`

### Testing Deployment
```bash
# On Windows
echo "# Test" >> README.md
git add README.md
git commit -m "Test auto-deploy"
git push origin main

# On Droplet (watch deployment)
tail -f /var/log/invest-deploy.log
```

**Expected**: Deployment completes in ~2-3 minutes.

---

## Environment Configuration

**File**: `/opt/invest-copilot/.env`

### Critical Variables
```bash
# Database
DATABASE_URL=postgresql://investuser:PASSWORD@invest-postgres:5432/investcopilot

# JWT Secrets
JWT_SECRET=your-jwt-secret
REFRESH_TOKEN_SECRET=your-refresh-secret

# Admin Account
ADMIN_EMAIL=admin@hungrytimes.in
ADMIN_PASSWORD=secure-password
ADMIN_PHONE=+919876543210
ADMIN_NAME=Admin

# API Keys
CLAUDE_API_KEY=sk-ant-xxx                    # ✅ Configured
ALPHA_VANTAGE_KEY=your-alpha-vantage-key     # ✅ Configured
TELEGRAM_BOT_TOKEN=7908584378:AAF...         # ✅ Configured
TELEGRAM_ADMIN_ID=1234567890                 # ✅ Configured

# Email (GoDaddy)
EMAIL_HOST=smtpout.secureserver.net
EMAIL_PORT=587
EMAIL_USER=noreply@hungrytimes.in
EMAIL_PASSWORD=email-password
EMAIL_FROM_NAME=Investment Co-Pilot
EMAIL_FROM_ADDRESS=noreply@hungrytimes.in

# Notifications
ENABLE_EMAIL_NOTIFICATIONS=true
ENABLE_SMS_NOTIFICATIONS=false
ENABLE_WHATSAPP_NOTIFICATIONS=false
ENABLE_TELEGRAM_NOTIFICATIONS=true           # ✅ Enabled

# Deployment
GITHUB_WEBHOOK_SECRET=81e22653a3f0e757...    # ✅ Configured
DEPLOY_BRANCH=main

# Features
ENABLE_CRON=true                             # ✅ Enabled
NODE_ENV=production

# URLs
FRONTEND_URL=https://invest.hungrytimes.in
BACKEND_URL=https://invest.hungrytimes.in/api
ALLOWED_ORIGINS=https://invest.hungrytimes.in,http://localhost:3101
```

### Security Notes

- All secrets stored in `.env` (not committed to Git)
- `.env` file permissions: `600` (read/write owner only)
- JWT secrets should be 256-bit random strings
- GitHub webhook secret should be cryptographically random

---

## Current System Status

### ✅ Working Components

- [x] Docker containerization & orchestration
- [x] Traefik reverse proxy with SSL
- [x] Database (PostgreSQL) with Prisma ORM
- [x] User authentication (JWT)
- [x] Portfolio management API
- [x] Holdings & trades tracking
- [x] P&L calculation
- [x] Watchlist functionality
- [x] Market data fetching (Alpha Vantage + NSE scraping)
- [x] GitHub webhook deployment
- [x] Automated CI/CD pipeline
- [x] Systemd deployment watcher
- [x] Health check endpoint
- [x] Frontend React app
- [x] API endpoint structure
- [x] Cron job scheduling (runs on schedule)

### 🔧 Configured But Broken

- [ ] **Claude API alert generation** - API key configured, cron runs, but alerts not generated
- [ ] **Telegram morning alerts** - Bot configured, schedule set, but not sending
- [ ] **Telegram evening alerts** - Same issue as morning
- [ ] **AI-powered portfolio analysis automation** - Manual API calls work, cron doesn't trigger
- [ ] **Market scanner AI integration** - Scanner runs, but doesn't call Claude for analysis

### ❌ Missing Features

- [ ] Mobile responsive tabs (UI broken on mobile)
- [ ] Multi-portfolio support (architecture doesn't support multiple portfolios per user)
- [ ] US market integration (only NSE/BSE supported)
- [ ] Portfolio-specific alert customization
- [ ] Risk profile configuration per portfolio
- [ ] US market data sources (currently Alpha Vantage + NSE scraping only)
- [ ] Portfolio comparison view
- [ ] Export functionality (CSV, PDF reports)

### 📝 Technical Debt

- [ ] Remove `version: '3.8'` from docker-compose.yml (obsolete warning)
- [ ] Upgrade npm packages (security vulnerabilities in dependencies)
- [ ] Add comprehensive error logging for cron jobs
- [ ] Implement retry logic for API failures
- [ ] Add database backup automation
- [ ] Set up monitoring/alerting for system health

---

## Debugging Access Points

### Check System Status
```bash
# On Droplet

# Container logs
docker logs invest-api -f
docker logs invest-postgres -f
docker logs invest-web -f

# Deployment logs
tail -f /var/log/invest-deploy.log

# Systemd services
sudo systemctl status invest-deploy-watcher

# Database access
docker exec -it invest-postgres psql -U investuser -d investcopilot

# Check environment variables in container
docker exec invest-api env | grep CLAUDE
docker exec invest-api env | grep TELEGRAM
docker exec invest-api env | grep ENABLE_CRON
```

### Test API Endpoints
```bash
# Health check
curl https://invest.hungrytimes.in/api/health

# Login (get token)
curl -X POST https://invest.hungrytimes.in/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hungrytimes.in","password":"your-password"}'

# Test AI analysis (requires auth token)
curl -X POST https://invest.hungrytimes.in/api/ai/portfolio-plan \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

### Check Cron Job Execution
```bash
# Check if cron jobs are running (look for market scanner logs)
docker logs invest-api --since 1h | grep "Running market scanner"
docker logs invest-api --since 1h | grep "Sending morning digest"
docker logs invest-api --since 1h | grep "Sending evening digest"
```

---

## Next Steps for New Claude Session

When pasting this architecture doc into a new Claude window:

1. **Read the TODO.md file** for prioritized task list
2. **Scan critical files** to understand current implementation:
   - `server/services/aiService.js`
   - `server/jobs/telegramAlerts.js`
   - `server/jobs/marketScanner.js`
3. **Identify why alerts aren't sending** despite cron running
4. **Plan multi-portfolio architecture** for future scalability
5. **Design US market integration** approach

---

**Last Updated**: 2026-02-05  
**Maintained By**: Rono  
**Version**: 1.0
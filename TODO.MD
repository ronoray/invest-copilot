# Investment Co-Pilot - Task Roadmap

**Last Updated**: 2026-02-05  
**Priority Levels**: 🔴 CRITICAL | 🟡 IMPORTANT | 🟢 NICE-TO-HAVE | 🔵 TECHNICAL DEBT

---

## 🔴 CRITICAL (Broken But Should Work)

These features are configured and scheduled but not functioning properly. Fix immediately.

### Alert System Issues

- [ ] **Fix Claude API integration in cron jobs**
  - [x] Claude API key configured ✅
  - [x] Cron jobs running on schedule ✅
  - [ ] Debug why AI analysis not triggered by cron
  - [ ] Add error logging to catch silent failures
  - [ ] Test manual vs automated Claude API calls
  - [ ] Verify API call flow: Cron → Service → Claude → Response
  - **File**: `server/jobs/telegramAlerts.js`, `server/services/aiService.js`
  - **Expected Behavior**: Morning/evening crons should call Claude API for analysis
  - **Current Issue**: Cron runs but doesn't execute AI service calls

- [ ] **Fix Telegram morning alerts (9:00 AM IST)**
  - [x] Telegram bot configured ✅
  - [x] Cron schedule set ✅
  - [x] Admin chat ID configured ✅
  - [ ] Debug why `sendMorningDigest()` not executing
  - [ ] Verify alert service is called by cron
  - [ ] Check if Telegram API calls are being made
  - [ ] Add logging to trace execution path
  - **File**: `server/jobs/telegramAlerts.js`
  - **Expected**: Daily at 9 AM with portfolio summary + AI insights
  - **Current**: Cron runs but no message sent

- [ ] **Fix Telegram evening alerts (6:00 PM IST)**
  - [ ] Same debugging approach as morning alerts
  - [ ] Verify evening digest logic
  - [ ] Test evening alert generation manually
  - **File**: `server/jobs/telegramAlerts.js`
  - **Expected**: Daily at 6 PM with day's performance + tomorrow's action items
  - **Current**: Cron runs but no message sent

- [ ] **Enhance Claude API analysis depth**
  - [ ] Ensure prompts request detailed, actionable insights
  - [ ] Include technical indicators in analysis (RSI, MACD, volume)
  - [ ] Add market sentiment analysis
  - [ ] Format response for easy understanding (bullet points, emojis)
  - [ ] Include confidence levels and risk warnings
  - **File**: `server/services/aiService.js`
  - **Goal**: Deep AI analysis presented in simple, digestible format

### Market Scanner Integration

- [ ] **Connect market scanner to Claude AI**
  - [x] Scanner runs every 5 minutes ✅
  - [x] Fetches market data successfully ✅
  - [ ] Add Claude AI analysis to scanner results
  - [ ] Generate buy/sell recommendations with reasoning
  - [ ] Store AI insights in Proposal table
  - [ ] Send alerts for high-confidence signals
  - **File**: `server/jobs/marketScanner.js`
  - **Expected**: Scanner identifies opportunities, Claude analyzes them, alerts sent
  - **Current**: Scanner only updates prices, no AI analysis

---

## 🟡 IMPORTANT (Missing Core Features)

These are essential features needed for production readiness.

### Multi-Portfolio Architecture

- [ ] **Design multi-portfolio system**
  - [ ] Plan database schema changes (Portfolio table)
  - [ ] Each portfolio has: name, currency, market preference (NSE/US/both)
  - [ ] User can have multiple portfolios
  - [ ] Holdings/Trades/Watchlist linked to specific portfolio
  - [ ] Example: "India Growth Portfolio", "US Tech Portfolio", "Conservative India Portfolio"
  - **Impact**: Major schema change, requires migration

- [ ] **Implement portfolio switching UI**
  - [ ] Portfolio selector dropdown in header
  - [ ] Create new portfolio form
  - [ ] Portfolio settings page (name, market, risk profile)
  - [ ] Dashboard filtered by selected portfolio
  - **File**: `client/src/components/Portfolio.jsx`

- [ ] **Portfolio-specific alerts**
  - [ ] Morning alert personalized per portfolio
  - [ ] Filter recommendations by portfolio's market preference
  - [ ] Separate P&L tracking per portfolio
  - [ ] "Your India portfolio gained 2%, US portfolio down 0.5%"
  - **File**: `server/jobs/telegramAlerts.js`

- [ ] **Risk profile per portfolio**
  - [ ] Add risk_profile field: CONSERVATIVE, BALANCED, AGGRESSIVE
  - [ ] Customize AI recommendations based on risk profile
  - [ ] Conservative: Focus on blue chips, dividends
  - [ ] Aggressive: High-growth stocks, short-term trades
  - **File**: Database schema, `server/services/aiService.js`

### US Market Integration

- [ ] **Add US market data sources**
  - [ ] Research US market data APIs (Alpha Vantage already supports US)
  - [ ] Add NYSE, NASDAQ symbol support
  - [ ] Handle USD currency conversion
  - [ ] Display both INR and USD values
  - **File**: `server/services/marketService.js`

- [ ] **US market hours support**
  - [ ] US market hours: 9:30 AM - 4:00 PM EST (7:00 PM - 1:30 AM IST)
  - [ ] Update cron jobs to handle both market timezones
  - [ ] Separate scanners for NSE and US markets
  - **File**: `server/jobs/marketScanner.js`

- [ ] **Cross-market portfolio analysis**
  - [ ] Compare NSE vs US performance
  - [ ] Currency risk analysis
  - [ ] Recommend diversification across markets
  - **File**: `server/services/aiService.js`

- [ ] **US-specific features**
  - [ ] Support US tax implications (capital gains different rules)
  - [ ] Handle fractional shares (common in US)
  - [ ] US dividend tracking (different tax treatment)
  - **File**: `server/routes/tax.js`, database schema

### Mobile Responsiveness

- [ ] **Fix mobile tabs**
  - [ ] Investigate current mobile UI issues
  - [ ] Test on actual mobile devices (iOS/Android)
  - [ ] Fix navigation tabs on mobile viewport
  - [ ] Ensure touch-friendly buttons/links
  - **File**: `client/src/components/*`, `client/src/App.jsx`

- [ ] **Mobile-optimized dashboard**
  - [ ] Responsive portfolio summary cards
  - [ ] Mobile-friendly tables (horizontal scroll or cards)
  - [ ] Collapsible sections for holdings/trades
  - [ ] Touch gestures for actions (swipe to delete, etc.)

- [ ] **Progressive Web App (PWA) features**
  - [ ] Add web manifest
  - [ ] Service worker for offline access
  - [ ] Install prompt for "Add to Home Screen"
  - [ ] Push notifications support (future)

### Alert Customization

- [ ] **User alert preferences**
  - [ ] Add preferences table: alert_frequency, alert_time, alert_types
  - [ ] Let user choose alert timing (e.g., 8 AM instead of 9 AM)
  - [ ] Toggle alert types: morning digest, evening summary, price alerts, buy signals
  - [ ] Quiet hours setting
  - **File**: Database schema, `server/routes/user.js`

- [ ] **Custom alert templates**
  - [ ] Let user customize alert format
  - [ ] Choose verbosity: brief, standard, detailed
  - [ ] Select which metrics to include
  - [ ] Language preference (future: support Hindi, etc.)

---

## 🟢 NICE-TO-HAVE (Enhancements)

These improve user experience but aren't critical.

### Reporting & Export

- [ ] **PDF portfolio reports**
  - [ ] Generate monthly performance reports
  - [ ] Charts: P&L over time, allocation breakdown
  - [ ] Tax summary for financial year
  - [ ] Use library like `pdfkit` or `puppeteer`
  - **File**: New `server/services/reportService.js`

- [ ] **CSV export**
  - [ ] Export holdings as CSV
  - [ ] Export trade history as CSV
  - [ ] Import trades from CSV (reverse feature)
  - **File**: `server/routes/portfolio.js`

- [ ] **Excel export**
  - [ ] Use `exceljs` library
  - [ ] Format with colors, formulas
  - [ ] Multiple sheets: Holdings, Trades, P&L

### Visualization

- [ ] **Portfolio charts**
  - [ ] P&L graph over time
  - [ ] Allocation pie chart (sector-wise)
  - [ ] Stock performance comparison
  - [ ] Use Chart.js or Recharts
  - **File**: `client/src/components/Charts.jsx`

- [ ] **Interactive watchlist**
  - [ ] Price alerts with visual indicators
  - [ ] Add notes to watchlist items
  - [ ] Set multiple price targets
  - **File**: `client/src/components/Watchlist.jsx`

### Social Features

- [ ] **Share portfolio performance**
  - [ ] Generate shareable link (anonymized)
  - [ ] "My portfolio gained 15% this month!"
  - [ ] Social media preview cards

- [ ] **Compare with friends** (Optional, privacy-focused)
  - [ ] Opt-in leaderboard
  - [ ] Anonymous comparison "You're in top 20% of users"

### Advanced Analysis

- [ ] **Backtesting**
  - [ ] Test strategies against historical data
  - [ ] "What if I bought RELIANCE 6 months ago?"
  - **File**: New `server/services/backtestService.js`

- [ ] **Options trading support**
  - [ ] Track options positions
  - [ ] Greeks calculation
  - [ ] Options strategies analyzer

---

## 🔵 TECHNICAL DEBT

Clean-up tasks to improve code quality and maintainability.

### Code Quality

- [ ] **Remove docker-compose version warning**
  - [ ] Delete line 1: `version: '3.8'` from `docker-compose.yml`
  - [ ] This is obsolete in Docker Compose v2
  - **File**: `docker-compose.yml`
  - **Impact**: Removes annoying warning in logs

- [ ] **Upgrade npm dependencies**
  - [ ] Run `npm audit` in both `server/` and `client/`
  - [ ] Address 7 vulnerabilities in backend (4 moderate, 1 high, 2 critical)
  - [ ] Address 2 moderate vulnerabilities in frontend
  - [ ] Update packages: `npm update`
  - **Files**: `server/package.json`, `client/package.json`

- [ ] **Add comprehensive error logging**
  - [ ] Add try-catch blocks in cron jobs
  - [ ] Log errors to separate error log file
  - [ ] Send critical errors to admin via Telegram
  - [ ] Set up error monitoring (Sentry or similar)
  - **Files**: All `server/jobs/*.js` files

- [ ] **Implement retry logic**
  - [ ] Retry failed API calls (Claude, Alpha Vantage)
  - [ ] Exponential backoff for rate limits
  - [ ] Use library like `axios-retry`
  - **File**: `server/services/marketService.js`, `server/services/aiService.js`

### Infrastructure

- [ ] **Database backup automation**
  - [ ] Add cron job to backup PostgreSQL daily
  - [ ] Store backups in `/backups` volume
  - [ ] Implement backup rotation (keep last 30 days)
  - [ ] Test restore process
  - **File**: New `backup-database.sh` script

- [ ] **Monitoring & alerting**
  - [ ] Set up Prometheus for metrics
  - [ ] Grafana dashboards for visualization
  - [ ] Alert on high error rates
  - [ ] Alert on service downtime
  - **New**: Monitoring stack

- [ ] **Load testing**
  - [ ] Test API performance under load
  - [ ] Identify bottlenecks
  - [ ] Optimize slow queries
  - **Tool**: k6 or Apache JMeter

### Documentation

- [ ] **API documentation**
  - [ ] Generate OpenAPI/Swagger docs
  - [ ] Document request/response formats
  - [ ] Add example requests
  - **Tool**: Swagger UI or Postman

- [ ] **Developer onboarding guide**
  - [ ] Setup instructions for new developers
  - [ ] Local development environment setup
  - [ ] Testing procedures
  - **File**: `CONTRIBUTING.md`

---

## Completed Tasks ✅

*(Move completed items here with completion date)*

- [x] Set up Docker containerization ✅ 2026-02-03
- [x] Implement CI/CD pipeline ✅ 2026-02-05
- [x] Configure Traefik reverse proxy ✅ 2026-02-03
- [x] Set up PostgreSQL database ✅ 2026-02-03
- [x] Create authentication system ✅ 2026-02-03
- [x] Build portfolio tracking API ✅ 2026-02-04
- [x] Integrate Claude API (configured) ✅ 2026-02-04
- [x] Set up Telegram bot ✅ 2026-02-04
- [x] Configure cron job scheduler ✅ 2026-02-04
- [x] Implement market scanner ✅ 2026-02-04
- [x] Create deployment automation ✅ 2026-02-05
- [x] Fix Prisma shared instance ✅ 2026-02-05
- [x] Fix GitHub webhook integration ✅ 2026-02-05

---

## How to Use This File

### Marking Tasks Complete

1. **On Windows**, edit `TODO.md`
2. **Change `[ ]` to `[x]`**:
```markdown
   - [x] Fix Claude API alerts ✅ COMPLETED 2026-02-05
```
3. **Move to "Completed Tasks" section**
4. **Commit and push**:
```bash
   git add TODO.md
   git commit -m "✅ Fixed Claude API alerts"
   git push origin main
```
5. **Auto-deploys** via CI/CD! 🚀

### Adding New Tasks

- Add under appropriate priority section
- Include clear acceptance criteria
- Note affected files
- Add context for future Claude sessions

### Priority Definitions

- **🔴 CRITICAL**: System broken, user impact, immediate fix required
- **🟡 IMPORTANT**: Core feature missing, needed for v1.0
- **🟢 NICE-TO-HAVE**: Enhancement, improves UX, not blocking
- **🔵 TECHNICAL DEBT**: Code quality, not user-facing

---

## Current Sprint Focus

**Week of 2026-02-05:**

1. 🔴 Debug and fix Telegram alert system
2. 🔴 Connect Claude API to cron jobs
3. 🔴 Verify alerts are sent with deep AI analysis
4. 🟡 Fix mobile responsive tabs
5. 🟡 Plan multi-portfolio architecture

**Success Criteria:**
- Receive morning alert at 9 AM with AI insights
- Receive evening alert at 6 PM with portfolio summary
- Mobile tabs functional on iPhone/Android
- Architecture document for multi-portfolio ready

---

**Last Updated**: 2026-02-05  
**Maintained By**: Rono  
**Version**: 1.0  
**Next Review**: After completing CRITICAL tasks
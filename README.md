# Investment Co-Pilot

AI-powered investment assistant for Indian stock markets (NSE/BSE).

**Production**: https://invest.hungrytimes.in
**Windows Dev Directory**: `C:\invest-copilot`
**Production Directory**: `/opt/invest-copilot`

## Features

- **Multi-Portfolio Management**: Track multiple portfolios per broker/owner (SBI Securities, HDFC, Upstox) with individual capital management
- **Real-Time Dashboard**: Portfolio overview with holdings table, P&L tracking, portfolio selector, market status (IST-based)
- **AI Investment Plans**: Claude-powered portfolio analysis, buy/sell recommendations, risk-categorized allocation
- **Upstox Trading**: Direct order placement via Upstox API for API-enabled portfolios
- **Screenshot Trade Entry**: Upload brokerage screenshots, AI extracts trade data (Claude Vision), review/edit, confirm to save
- **Tax Dashboard**: LTCG/STCG tracking, tax optimization opportunities, GST-compliant Excel export (4 sheets)
- **Market Scanner**: Automated 5-minute scans during trading hours (9:15 AM - 3:30 PM IST)
- **Telegram Alerts**: Morning/evening digests, price change alerts, buy/sell signals
- **Watchlist**: Price alerts and monitoring

## Tech Stack

**Backend:**
- Node.js 20 + Express (Port 3100)
- PostgreSQL 16 + Prisma ORM
- Anthropic Claude API (analysis + Vision)
- Upstox API (trading)
- Multer (file uploads) + ExcelJS (tax reports)

**Frontend:**
- React 18 + Vite (Dev Port 3101)
- TailwindCSS + Lucide Icons
- React Router 6
- Recharts for visualizations

**Infrastructure:**
- Docker + Docker Compose
- Traefik reverse proxy (shared with Hungry Times)
- DigitalOcean Droplet
- Cloudflare DNS + SSL

## Port Configuration

| Service | Port |
|---------|------|
| Backend API | 3100 |
| Frontend Dev | 3101 |
| PostgreSQL (Docker) | 5432 |

## Quick Start (Local Development)

### Prerequisites
- Node.js 20+
- Docker & Docker Compose
- Git

### 1. Clone & Setup
```bash
git clone <your-repo-url> C:\invest-copilot
cd C:\invest-copilot
copy .env.example .env
# Edit .env with your credentials
```

Required environment variables:
```env
DB_PASSWORD=your_secure_password
ALPHA_VANTAGE_KEY=your_api_key
CLAUDE_API_KEY=your_api_key
PORT=3100
```

### 2. Start Database
```bash
docker-compose up -d invest-postgres
```

### 3. Backend
```bash
cd server
npm install
npx prisma migrate dev
npx prisma generate
npm run dev
```

### 4. Frontend
```bash
cd client
npm install
npm run dev
```

Visit: http://localhost:3101

## Production Deployment

Push to `main` triggers auto-deploy via GitHub webhook:

```bash
git add .
git commit -m "your changes"
git push origin main
```

Deploy script: `deploy-invest.sh` (Docker rebuild + restart)
Health check: `GET /api/health`

### Manual Deploy
```bash
ssh rono@64.227.137.98
cd /opt/invest-copilot
sudo ./scripts/deploy.sh
```

## API Endpoints

### Auth (`/api/auth`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/login` | Login, returns JWT |
| POST | `/register` | Register new user |
| GET | `/me` | Current user info |

### Portfolio (`/api/portfolio`) — authenticated
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/?all=true` | List all portfolios (for dropdown) |
| GET | `/` | All holdings with P&L summary + portfolio info |
| GET | `/:portfolioId/holdings` | Holdings for specific portfolio |
| POST | `/` | Add holding |
| PUT | `/:id` | Update holding |
| DELETE | `/:id` | Remove holding |
| POST | `/sync` | Sync all prices |
| POST | `/:id/update-capital` | Update portfolio capital |

### AI (`/api/ai`) — authenticated
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/recommendations` | AI recommendations (high/medium/low) |
| POST | `/scan` | Run market scan for opportunities |
| GET | `/portfolio-plan?portfolioId=1` | AI investment plan |
| GET | `/comprehensive-analysis` | 10-section deep analysis |
| POST | `/parse-screenshot` | Upload screenshot, extract trades (Claude Vision) |
| POST | `/confirm-screenshot-trade` | Confirm and save extracted trades |

### Upstox (`/api/upstox`) — authenticated
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/place-order` | Place buy/sell order |
| GET | `/order/:orderId` | Check order status |
| DELETE | `/order/:orderId` | Cancel order |
| GET | `/holdings` | Fetch live Upstox holdings |

### Tax (`/api/tax`) — authenticated
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/summary` | Tax breakdown (LTCG/STCG) |
| POST | `/calculate` | Calculate tax for a trade |
| GET | `/opportunities` | Tax optimization opportunities |
| GET | `/ltcg-timer/:holdingId` | Time remaining to LTCG |
| GET | `/export?year=2025` | Download Excel tax report |

### Market (`/api/market`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/price/:symbol` | Current price |
| GET | `/intraday/:symbol` | 5-min candles |
| GET | `/search?q=query` | Search stocks |

### Watchlist (`/api/watchlist`) — authenticated
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get watchlist |
| POST | `/` | Add to watchlist |
| DELETE | `/:id` | Remove item |

## Database Schema

Key models (see `server/prisma/schema.prisma`):

| Model | Description |
|-------|-------------|
| User | Auth, preferences, relations |
| Portfolio | Broker, capital, risk profile |
| Holding | Stock positions (per portfolio+symbol+exchange) |
| Trade | Buy/sell history (MANUAL, API, SCREENSHOT) |
| Proposal | AI recommendations |
| UpstoxIntegration | Upstox API credentials |
| UpstoxOrder | Order tracking |
| TradeScreenshot | Screenshot uploads + AI extraction |
| CapitalHistory | Capital change audit trail |
| TelegramUser | Telegram bot users |
| AlertPreference | Per-portfolio alert settings |
| TaxRecord | Per-FY tax records |

## Common Tasks

### View Logs
```bash
docker-compose logs -f invest-api
docker-compose logs -f invest-web
```

### Database Shell
```bash
docker-compose exec invest-postgres psql -U investuser investcopilot
```

### Restart Services
```bash
docker-compose restart invest-api
```

### Backup Database
```bash
docker-compose exec invest-postgres pg_dump -U investuser investcopilot > backup.sql
```

## Domain Structure
```
hungrytimes.in domain:
├── ops.hungrytimes.in      → Hungry Times Ops Panel
├── hungrytimes.in          → Hungry Times Website
└── invest.hungrytimes.in   → Investment Co-Pilot
```

## Completed Phases

- **Phase 1**: Portfolio tracking, market data, watchlist, Docker deployment
- **Phase 2**: Multi-portfolio architecture, capital management, AI portfolio plans
- **Phase 3**: Telegram alerts, advanced market scanner
- **Phase 4**: Upstox trading integration (place/cancel/status orders)
- **Phase 5**: Screenshot trade entry via Claude Vision (upload, AI extract, editable review, confirm)
- **Phase 6**: GST-compliant tax export (Excel with 4 sheets: All Trades, Portfolio Summary, Tax Summary, Quarterly)

## Author

Ronobir Ray (Rono)
Kolkata, West Bengal, India

---

**Built to complement the Hungry Times ecosystem**

# Investment Co-Pilot System

AI-powered investment assistant for Indian stock markets (NSE/BSE).

**Windows Development Directory**: `C:\invest-copilot`  
**Production Directory**: `/opt/invest-copilot`

## 🎯 Features

- **Portfolio Tracking**: Real-time portfolio monitoring with P&L calculations
- **Market Data**: Live price updates via Alpha Vantage & NSE APIs
- **Watchlist**: Price alerts and monitoring for stocks
- **AI Recommendations**: (Phase 2) Claude-powered buy/sell proposals
- **Automated Scanning**: 5-minute market scans during trading hours
- **Clawdbot Integration**: (Phase 3) Telegram/WhatsApp notifications

## 🏗️ Tech Stack

**Backend:**
- Node.js 20 + Express (Port 3100)
- PostgreSQL 16 + Prisma ORM
- Bull Queue for background jobs
- Alpha Vantage API for market data

**Frontend:**
- React 18 + Vite (Dev Port 3101)
- TailwindCSS
- React Query
- Recharts for visualizations

**Infrastructure:**
- Docker + Docker Compose
- Traefik reverse proxy (shared with Hungry Times)
- DigitalOcean Droplet (64.227.137.98)
- Cloudflare DNS + SSL

## 📊 Port Configuration

**Investment Co-Pilot:**
- Backend API: 3100
- Frontend Dev: 3101
- PostgreSQL: 5432 (Docker internal)

**Hungry Times System (No conflicts):**
- Backend: 5000
- Ops Panel: 5173
- Website: 5174
- Reserved: 5175

## 🚀 Quick Start (Local Development)

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- Git

### 1. Clone Repository

```bash
git clone <your-repo-url> C:\invest-copilot
cd C:\invest-copilot
```

### 2. Setup Environment Variables

```bash
copy .env.example .env
# Edit .env with your credentials
```

Required variables:
```env
DB_PASSWORD=your_secure_password
ALPHA_VANTAGE_KEY=your_api_key  # Get free at https://www.alphavantage.co
CLAUDE_API_KEY=your_api_key     # Get at https://console.anthropic.com
PORT=3100
```

### 3. Start Database

```bash
docker-compose up -d invest-postgres
```

### 4. Install Dependencies & Run Migrations

**Backend:**
```bash
cd server
npm install
npx prisma migrate dev
npx prisma generate
npm run dev
```

**Frontend:**
```bash
cd client
npm install
npm run dev
```

Visit: http://localhost:3101

## 📦 Production Deployment

### On Your Windows Machine

1. Push to GitHub:
```bash
git add .
git commit -m "Initial setup"
git push origin main
```

### On Your Droplet (First Time)

```bash
# Clone repository
sudo mkdir -p /opt/invest-copilot
cd /opt/invest-copilot
sudo git clone <your-repo-url> .

# Setup environment
sudo cp .env.example .env
sudo nano .env  # Add production credentials

# Make scripts executable
sudo chmod +x scripts/deploy.sh

# Deploy
sudo ./scripts/deploy.sh
```

### Subsequent Deployments

```bash
ssh rono@64.227.137.98
cd /opt/invest-copilot
sudo ./scripts/deploy.sh
```

The system will be available at: `https://invest.hungrytimes.in`

## 🗄️ Database Schema

Key tables:
- `Holding` - Current portfolio
- `Trade` - Execution history
- `Watchlist` - Stocks to monitor
- `Proposal` - AI recommendations
- `MarketData` - 5-min price candles
- `Alert` - Price notifications
- `Journal` - Decision logs

## 🔧 Configuration

### Traefik Labels (Shared with Hungry Times)

The docker-compose.yml includes Traefik labels for:
- `invest.hungrytimes.in` → Frontend
- `invest.hungrytimes.in/api` → Backend API

Both use the external `traefik-network` shared with your Hungry Times system.

### Market Scanner

Runs automatically every 5 minutes (9:15 AM - 3:30 PM IST):
- Updates portfolio prices
- Checks watchlist alerts
- Scans for opportunities (Phase 2)

## 📊 API Endpoints

### Portfolio
- `GET /api/portfolio` - Get all holdings with P&L
- `POST /api/portfolio` - Add holding
- `PUT /api/portfolio/:id` - Update holding
- `DELETE /api/portfolio/:id` - Remove holding
- `POST /api/portfolio/sync` - Sync all prices

### Market Data
- `GET /api/market/price/:symbol` - Current price
- `GET /api/market/intraday/:symbol` - 5-min candles
- `GET /api/market/search?q=query` - Search stocks

### Watchlist
- `GET /api/watchlist` - Get watchlist
- `POST /api/watchlist` - Add to watchlist
- `PUT /api/watchlist/:id` - Update item
- `DELETE /api/watchlist/:id` - Remove item
- `GET /api/watchlist/signals` - Check alerts

### Proposals
- `GET /api/proposals` - Get all proposals
- `POST /api/proposals` - Create proposal
- `PUT /api/proposals/:id/approve` - Approve
- `PUT /api/proposals/:id/reject` - Reject

## 🔐 Security

- PostgreSQL credentials in `.env`
- Cloudflare SSL termination (shared)
- Traefik routing (shared)
- No public ports exposed

## 📝 Common Tasks

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

### Restore Database
```bash
docker-compose exec -T invest-postgres psql -U investuser investcopilot < backup.sql
```

## 🐛 Troubleshooting

### API Not Starting
```bash
docker-compose logs invest-api
# Check database connection
docker-compose exec invest-postgres pg_isready
```

### Frontend Build Fails
```bash
cd C:\invest-copilot\client
rmdir /s /q node_modules
del package-lock.json
npm install
npm run build
```

### Port Conflicts
```bash
# Windows - Check what's using port 3100
netstat -ano | findstr :3100

# Linux - Check what's using port 3100
lsof -i :3100
```

## 🎯 Roadmap

**Phase 1 (Current):**
- ✅ Portfolio tracking
- ✅ Market data integration
- ✅ Watchlist management
- ✅ Basic UI
- ✅ Docker deployment

**Phase 2 (Next):**
- [ ] AI-powered proposals (Claude API)
- [ ] Technical indicators (RSI, MACD)
- [ ] Telegram/WhatsApp notifications
- [ ] Trade journal

**Phase 3 (Future):**
- [ ] SBI Securities API integration
- [ ] Clawdbot integration
- [ ] Advanced charting
- [ ] Performance analytics
- [ ] Multi-user support

## 🔄 Integration with Hungry Times

### Shared Infrastructure
- **Traefik Network**: Both systems use `traefik-network`
- **Reverse Proxy**: Shared Traefik container
- **SSL**: Cloudflare SSL termination
- **Droplet**: Same server (64.227.137.98)

### Domain Structure
```
hungrytimes.in domain:
├── ops.hungrytimes.in      → Hungry Times Ops Panel
├── hungrytimes.in          → Hungry Times Website
└── invest.hungrytimes.in   → Investment Co-Pilot
```

### Port Isolation
The systems use completely different ports to avoid conflicts.

## 📄 License

Personal project - All rights reserved

## 👤 Author

Ronobir Ray (Rono)  
Kolkata, West Bengal, India

---

**Built with ❤️ to complement the Hungry Times ecosystem**

## 📚 Additional Documentation

- `QUICKSTART.md` - Quick setup guide
- `PROJECT_SUMMARY.md` - Detailed project overview
- `.env.example` - Environment variables template

## 🎓 Getting Started Checklist

- [ ] Clone repo to `C:\invest-copilot`
- [ ] Get Alpha Vantage API key
- [ ] Setup `.env` file
- [ ] Test locally (ports 3100/3101)
- [ ] Push to GitHub
- [ ] Deploy to droplet
- [ ] Configure Cloudflare DNS
- [ ] Add your actual SBI Securities holdings
- [ ] Setup watchlist
- [ ] Test market data sync

**Ready to track your investments? Let's go! 📈**

# Auto-deploy test - # CI/CD Test
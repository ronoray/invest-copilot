# Investment Co-Pilot - Project Setup (Retuned for Your System)

## What's Been Created

A complete full-stack investment tracking system integrated with your existing Hungry Times infrastructure.

## 🎯 Key Changes from Original

### 1. Windows Directory
- **Original**: Generic path
- **Yours**: `C:\invest-copilot`

### 2. Port Configuration
**Your Hungry Times System (No conflicts):**
- Backend: 5000
- Ops Panel: 5173
- Website: 5174
- Reserved: 5175

**Investment Co-Pilot (New ports):**
- Backend API: 3100
- Frontend Dev: 3101

### 3. Portfolio Data
**Removed example stocks** (RELIANCE, TCS, INFY were just examples)

**Your actual SBI Securities portfolio:**
- Portfolio Value: ₹4,480.84
- Investment: ₹2,169.46  
- Unrealized P&L: ₹2,311.40 (106.54%)
- Today's P&L: -₹89.88 (-1.97%)
- Realized P&L: ₹918.80

System starts with **empty portfolio** - you'll add your actual holdings.

### 4. Infrastructure Integration
Seamlessly integrates with your existing:
- Traefik reverse proxy (shared network)
- Cloudflare DNS & SSL
- Droplet (64.227.137.98)
- Similar deployment pattern to Hungry Times

## 📁 Project Structure

```
C:\invest-copilot\
├── server\                     # Backend API (Port 3100)
│   ├── prisma\
│   │   └── schema.prisma       # PostgreSQL schema
│   ├── routes\                 # API endpoints
│   │   ├── portfolio.js        # Portfolio CRUD
│   │   ├── market.js           # Market data
│   │   ├── watchlist.js        # Watchlist management
│   │   └── proposal.js         # AI recommendations
│   ├── services\
│   │   ├── marketData.js       # Alpha Vantage + NSE scraper
│   │   └── logger.js           # Winston logging
│   ├── jobs\
│   │   └── marketScanner.js    # 5-min cron job
│   ├── index.js                # Express server
│   └── package.json
│
├── client\                      # React Frontend (Port 3101)
│   ├── src\
│   │   ├── pages\
│   │   │   ├── Dashboard.jsx
│   │   │   ├── Portfolio.jsx   # Main portfolio view
│   │   │   ├── Watchlist.jsx
│   │   │   └── Proposals.jsx
│   │   ├── api\
│   │   │   └── client.js       # Axios API client
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── package.json
│   └── vite.config.js          # Port 3101
│
├── docker\                      # Docker configs
│   ├── Dockerfile.api
│   ├── Dockerfile.client
│   └── nginx.conf
│
├── scripts\
│   └── deploy.sh               # Deployment script
│
├── docker-compose.yml           # Uses traefik-network
├── .env.example
├── README.md
├── QUICKSTART.md
└── .gitignore
```

## 🎯 What Works Out of the Box

### Backend ✅
- Express API on port 3100
- PostgreSQL database (separate from Hungry Times SQLite)
- Portfolio CRUD operations
- Market data fetching (Alpha Vantage + NSE)
- Watchlist management
- Automated price updates (5-min cron)
- P&L calculations

### Frontend ✅
- Portfolio dashboard
- Real-time P&L display
- Price sync functionality
- Responsive Tailwind design
- Dev server on port 3101

### Infrastructure ✅
- Docker containers
- Shared Traefik network
- PostgreSQL 16 container
- Deployment script
- Database migrations

## 🚀 Your Development Workflow

### 1. Local Development (Windows)

```bash
# Terminal 1 - Backend
cd C:\invest-copilot\server
npm install
npx prisma generate
npm run dev  # Port 3100

# Terminal 2 - Frontend  
cd C:\invest-copilot\client
npm install
npm run dev  # Port 3101
```

### 2. Test Locally

- Backend: http://localhost:3100/api/health
- Frontend: http://localhost:3101
- No conflicts with Hungry Times (different ports)

### 3. Push to GitHub

```bash
git add .
git commit -m "Your changes"
git push origin main
```

### 4. Deploy to Droplet

```bash
ssh rono@64.227.137.98
cd /opt/invest-copilot
sudo ./scripts/deploy.sh
```

**Follows same pattern as your Hungry Times deployment!**

## 🔧 First Time Setup Steps

### Step 1: Create GitHub Repository (5 minutes)

```bash
cd C:\invest-copilot
git init
git add .
git commit -m "Initial commit: Investment Co-Pilot"
git remote add origin git@github.com:yourusername/invest-copilot.git
git push -u origin main
```

### Step 2: Get API Keys (10 minutes)

**Alpha Vantage (Required):**
1. Visit: https://www.alphavantage.co/support/#api-key
2. Get free key (2 minutes)
3. 500 calls/day, 5 calls/min

**Anthropic Claude (Optional - Phase 2):**
1. Visit: https://console.anthropic.com
2. Get API key for AI features

### Step 3: Local Setup (15 minutes)

```bash
cd C:\invest-copilot

# Setup environment
copy .env.example .env
# Edit .env:
# - Add Alpha Vantage key
# - Set strong DB password
# - PORT=3100

# Start PostgreSQL
docker-compose up -d invest-postgres

# Backend
cd server
npm install
npx prisma migrate dev --name init
npm run dev

# Frontend (new terminal)
cd client
npm install
npm run dev
```

Visit: http://localhost:3101

### Step 4: Deploy to Droplet (10 minutes)

```bash
ssh rono@64.227.137.98

# Clone
sudo mkdir -p /opt/invest-copilot
cd /opt/invest-copilot
sudo git clone git@github.com:yourusername/invest-copilot.git .

# Configure
sudo cp .env.example .env
sudo nano .env  # Add production credentials

# Deploy
sudo chmod +x scripts/deploy.sh
sudo ./scripts/deploy.sh
```

### Step 5: Configure Cloudflare (5 minutes)

Add DNS record:
- Type: A
- Name: invest
- Content: 64.227.137.98  
- Proxy: On (orange cloud)
- TTL: Auto

Result: `invest.hungrytimes.in` → Your investment system

## 📊 Adding Your Actual Holdings

**Your portfolio summary** (from screenshot):
- Total: ₹4,480.84
- Invested: ₹2,169.46
- Unrealized: +₹2,311.40 (106.54%)

To add holdings, use the API:

```bash
# Add a stock
curl -X POST https://invest.hungrytimes.in/api/portfolio \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "YOURSYMBOL",
    "exchange": "NSE",
    "quantity": 10,
    "avgPrice": 150.50
  }'
```

Or directly in database:
```bash
docker-compose exec invest-postgres psql -U investuser investcopilot

INSERT INTO "Holding" (symbol, exchange, quantity, "avgPrice", "currentPrice", "createdAt", "updatedAt")
VALUES ('YOURSYMBOL', 'NSE', 10, 150.50, 150.50, NOW(), NOW());
```

The system will auto-fetch current prices on sync.

## 🔄 Integration Details

### Shared with Hungry Times
- Traefik reverse proxy
- traefik-network Docker network
- Cloudflare SSL/DNS
- Same droplet server
- Similar deployment pattern

### Separate from Hungry Times
- PostgreSQL database (vs SQLite)
- Different ports (3100/3101 vs 5000/5173/5174)
- Separate Docker containers
- Independent deployments
- Own domain: invest.hungrytimes.in

### Domain Structure
```
hungrytimes.in:
├── hungrytimes.in          → Restaurant Website
├── ops.hungrytimes.in      → Restaurant Ops Panel
└── invest.hungrytimes.in   → Investment System (NEW)
```

## 🎨 Phase 1 vs Phase 2 vs Phase 3

### Phase 1 (Current - Ready to Use)
- ✅ Portfolio tracking
- ✅ Market data (Alpha Vantage + NSE)
- ✅ Watchlist
- ✅ Manual stock entry
- ✅ P&L calculations
- ✅ Price sync

### Phase 2 (2-4 hours to add)
- [ ] Claude API integration
- [ ] AI-powered proposals
- [ ] Technical indicators
- [ ] Auto-recommendations

### Phase 3 (4-8 hours to add)
- [ ] Clawdbot integration (like Hungry Times)
- [ ] Telegram notifications
- [ ] WhatsApp alerts
- [ ] SBI Securities API

## 💡 Next Actions

### Immediate (Today)
1. [ ] Create GitHub repo
2. [ ] Get Alpha Vantage key
3. [ ] Test locally on Windows
4. [ ] Deploy to droplet
5. [ ] Add Cloudflare DNS

### This Week
6. [ ] Add your actual holdings
7. [ ] Configure watchlist
8. [ ] Test price sync
9. [ ] Create backup strategy

### Phase 2 (Optional)
10. [ ] Add AI recommendations
11. [ ] Integrate Claude API
12. [ ] Add technical indicators

## ⚠️ Important Notes

### No Example Data
The system starts **empty**. The stocks mentioned in the original markdown (RELIANCE, TCS, INFY) were just examples. Add your real holdings.

### Port Conflicts Avoided
Carefully chosen ports (3100, 3101) don't conflict with:
- Hungry Times backend (5000)
- Hungry Times ops-web (5173)
- Hungry Times website (5174)
- Your reserved port (5175)

### Alpha Vantage Limits
- Free tier: 500 calls/day, 5 calls/min
- System auto-delays 12s between calls
- Sufficient for personal use

### Database Choice
- **PostgreSQL** (not SQLite like Hungry Times)
- Reason: Investment data needs JSONB, better scaling
- Ready for multi-user (future business)

## 🎯 Success Criteria

You'll know it's working when:
- [ ] Local dev works on ports 3100/3101
- [ ] No port conflicts with Hungry Times
- [ ] Can add holdings via API
- [ ] Prices auto-update
- [ ] https://invest.hungrytimes.in loads
- [ ] Portfolio shows your real data

## 📚 Documentation Reference

- `README.md` - Full technical documentation
- `QUICKSTART.md` - Quick setup commands
- `.env.example` - Environment variables template
- `server/prisma/schema.prisma` - Database schema

## ✅ Pre-Flight Checklist

Before deploying:
- [ ] GitHub repo created
- [ ] Alpha Vantage API key obtained
- [ ] .env file configured locally
- [ ] Tested on Windows (ports 3100/3101)
- [ ] No conflicts with Hungry Times ports
- [ ] Git pushed to GitHub
- [ ] Droplet SSH access confirmed
- [ ] Cloudflare DNS access confirmed

**Estimated Time to Live System**: 45-60 minutes

---

**You now have a production-ready investment tracking system that complements your Hungry Times infrastructure! 🚀**

**Windows Dev**: C:\invest-copilot  
**Production**: /opt/invest-copilot  
**Domain**: invest.hungrytimes.in

**Ready to start? Begin with QUICKSTART.md! 📈**

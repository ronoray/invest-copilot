# Quick Start Guide - Investment Co-Pilot

## Your Workflow (Windows → Git → Droplet)

**Windows Directory**: `C:\invest-copilot`

### Step 1: Local Development (Windows)

```bash
# Clone and setup
git clone <your-repo-url> C:\invest-copilot
cd C:\invest-copilot

# Setup environment
cp .env.example .env
# Edit .env with your API keys

# Install and run backend
cd server
npm install
npx prisma generate
npm run dev  # Runs on http://localhost:3100

# Install and run frontend (new terminal)
cd client
npm install
npm run dev  # Runs on http://localhost:3101
```

**Ports Used:**
- Backend API: 3100
- Frontend Dev: 3101
- PostgreSQL: 5432 (internal Docker)

**Note**: These ports avoid conflicts with your Hungry Times system (5000, 5173, 5174, 5175)

### Step 2: Push to GitHub

```bash
git add .
git commit -m "Your changes"
git push origin main
```

### Step 3: Deploy to Droplet

SSH into your droplet and run:
```bash
cd /opt/invest-copilot
sudo ./scripts/deploy.sh
```

That's it! Your app is live at `https://invest.hungrytimes.in`

## First Time Setup on Droplet

Only needed once:

```bash
# Clone repo
sudo mkdir -p /opt/invest-copilot
cd /opt/invest-copilot
sudo git clone <your-repo-url> .

# Setup environment
sudo cp .env.example .env
sudo nano .env  # Add your production credentials

# Make deploy script executable
sudo chmod +x scripts/deploy.sh

# Run first deployment
sudo ./scripts/deploy.sh
```

## Get API Keys

### Alpha Vantage (Market Data)
1. Visit: https://www.alphavantage.co/support/#api-key
2. Get free API key (500 calls/day)
3. Add to `.env`: `ALPHA_VANTAGE_KEY=your_key_here`

### Anthropic Claude (AI Features - Phase 2)
1. Visit: https://console.anthropic.com
2. Create account and get API key
3. Add to `.env`: `CLAUDE_API_KEY=your_key_here`

## Essential Commands

### Local Development (Windows)
```bash
# Backend
cd C:\invest-copilot\server
npm run dev          # Start API server (port 3100)
npx prisma studio    # Database GUI (port 5555)

# Frontend
cd C:\invest-copilot\client
npm run dev          # Start dev server (port 3101)
npm run build        # Build for production
```

### Production (on Droplet)
```bash
cd /opt/invest-copilot

sudo ./scripts/deploy.sh                     # Deploy latest
docker-compose logs -f invest-api            # View API logs
docker-compose logs -f invest-web            # View frontend logs
docker-compose restart invest-api            # Restart API
docker-compose down                          # Stop all services
docker-compose up -d                         # Start all services
```

### Database Access
```bash
# On droplet
docker-compose exec invest-postgres psql -U investuser investcopilot

# Common queries
\dt                           # List tables
SELECT * FROM "Holding";      # View portfolio
SELECT * FROM "Watchlist";    # View watchlist
```

## Integration with Hungry Times System

### Port Separation
```
Hungry Times:
- Backend: 5000
- Ops Panel Dev: 5173  
- Website Dev: 5174
- (Reserved): 5175

Investment Co-Pilot:
- Backend: 3100
- Frontend Dev: 3101
```

### Shared Infrastructure
Both systems use:
- Same Traefik reverse proxy
- Same external traefik-network
- Same droplet (64.227.137.98)
- Same Cloudflare DNS & SSL

### Domain Setup
- Hungry Times Ops: `ops.hungrytimes.in`
- Hungry Times Website: `hungrytimes.in`  
- Investment Co-Pilot: `invest.hungrytimes.in`

## Adding Your Current Holdings

**Your actual portfolio** (from SBI Securities):
- Portfolio Value: ₹4,480.84
- Investment: ₹2,169.46
- Unrealized P&L: ₹2,311.40 (106.54%)

To add your holdings, either:

1. **Via API** (from Windows):
```bash
curl -X POST http://localhost:3100/api/portfolio \
  -H "Content-Type: application/json" \
  -d '{"symbol":"YOURSYMBOL","exchange":"NSE","quantity":1,"avgPrice":100}'
```

2. **Via Database** (on droplet):
```bash
docker-compose exec invest-postgres psql -U investuser investcopilot

INSERT INTO "Holding" (symbol, exchange, quantity, "avgPrice", "currentPrice", "createdAt", "updatedAt")
VALUES ('YOURSYMBOL', 'NSE', 1, 100.00, 100.00, NOW(), NOW());
```

**Note**: The example stocks (RELIANCE, TCS, INFY) mentioned in the original doc were just examples. Start with an empty portfolio and add your actual holdings.

## Troubleshooting

### Problem: Port already in use
```bash
# Check what's using port 3100
netstat -ano | findstr :3100  # Windows
lsof -i :3100                 # Linux

# Kill process or change port in .env
```

### Problem: API won't start
```bash
docker-compose logs invest-api
# Check if PostgreSQL is ready
docker-compose exec invest-postgres pg_isready
```

### Problem: Frontend shows blank page
```bash
# Check browser console for errors
# Verify API_BASE in vite.config.js
# Rebuild frontend
cd C:\invest-copilot\client
npm run build
```

## Next Steps

1. **Setup local environment** in C:\invest-copilot
2. **Get Alpha Vantage API key**
3. **Test locally** on ports 3100/3101
4. **Push to GitHub**
5. **Deploy to droplet**
6. **Add your actual SBI Securities holdings**
7. **Configure watchlist**
8. **Test market data sync**

## Important Notes

- Alpha Vantage free tier: 5 calls/min, 500/day
- Market scanner runs every 5 min (9:15 AM - 3:30 PM IST)
- All prices in Indian Rupees (₹)
- Supports NSE and BSE stocks
- PostgreSQL for scalability (not SQLite)

## Need Help?

Check the full README.md for detailed documentation or refer to your Hungry Times system documentation for deployment patterns.

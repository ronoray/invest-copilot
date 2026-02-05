# Upstox API Integration Guide

## Step 1: Get Upstox API Credentials

### Free API Access from Upstox

1. **Login to Upstox Developer Portal**
   - Go to: https://api.upstox.com/
   - Login with your Upstox account (Ronobir Ray)

2. **Create New App**
   - Click "My Apps" → "Create App"
   - App Name: `Investment Co-Pilot`
   - Redirect URL: `https://invest.hungrytimes.in/api/upstox/callback`
   - Click "Create"

3. **Get API Credentials**
   You'll receive:
   - **API Key** (Client ID)
   - **API Secret** (Client Secret)

   Save these securely!

---

## Step 2: Add Credentials to .env

**On your droplet:**

```bash
nano /opt/invest-copilot/.env
```

**Add these lines:**

```bash
# Upstox API Configuration
UPSTOX_API_KEY=your_api_key_here
UPSTOX_API_SECRET=your_api_secret_here
UPSTOX_REDIRECT_URI=https://invest.hungrytimes.in/api/upstox/callback
```

Save and exit: `Ctrl+X`, `Y`, `Enter`

---

## Step 3: Install Upstox SDK

```bash
ssh rono@64.227.137.98
cd /opt/invest-copilot/server
npm install upstox-js-sdk --save
```

---

## Step 4: Create Upstox Service

**Create file: `server/services/upstoxService.js`**

```javascript
import axios from 'axios';
import logger from './logger.js';

const UPSTOX_API_URL = 'https://api.upstox.com/v2';

class UpstoxService {
  constructor() {
    this.apiKey = process.env.UPSTOX_API_KEY;
    this.apiSecret = process.env.UPSTOX_API_SECRET;
    this.redirectUri = process.env.UPSTOX_REDIRECT_URI;
    this.accessToken = null;
  }

  /**
   * Generate login URL for OAuth
   */
  getLoginUrl() {
    return `https://api.upstox.com/v2/login/authorization/dialog?` +
           `response_type=code&` +
           `client_id=${this.apiKey}&` +
           `redirect_uri=${this.redirectUri}`;
  }

  /**
   * Exchange auth code for access token
   */
  async getAccessToken(authCode) {
    try {
      const response = await axios.post(
        `${UPSTOX_API_URL}/login/authorization/token`,
        {
          code: authCode,
          client_id: this.apiKey,
          client_secret: this.apiSecret,
          redirect_uri: this.redirectUri,
          grant_type: 'authorization_code'
        },
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );

      this.accessToken = response.data.access_token;
      logger.info('Upstox access token obtained');
      
      return this.accessToken;
    } catch (error) {
      logger.error('Upstox token error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get user profile
   */
  async getProfile() {
    try {
      const response = await axios.get(
        `${UPSTOX_API_URL}/user/profile`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      return response.data.data;
    } catch (error) {
      logger.error('Upstox profile error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get holdings (current positions)
   */
  async getHoldings() {
    try {
      const response = await axios.get(
        `${UPSTOX_API_URL}/portfolio/long-term-holdings`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      return response.data.data;
    } catch (error) {
      logger.error('Upstox holdings error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get positions (intraday trades)
   */
  async getPositions() {
    try {
      const response = await axios.get(
        `${UPSTOX_API_URL}/portfolio/short-term-positions`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      return response.data.data;
    } catch (error) {
      logger.error('Upstox positions error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get funds (available balance)
   */
  async getFunds() {
    try {
      const response = await axios.get(
        `${UPSTOX_API_URL}/user/get-funds-and-margin`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      return response.data.data;
    } catch (error) {
      logger.error('Upstox funds error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Place order
   */
  async placeOrder(orderData) {
    try {
      const response = await axios.post(
        `${UPSTOX_API_URL}/order/place`,
        {
          quantity: orderData.quantity,
          product: orderData.product || 'D', // D = Delivery, I = Intraday
          validity: orderData.validity || 'DAY',
          price: orderData.price,
          tag: 'InvestmentCoPilot',
          instrument_token: orderData.instrumentToken,
          order_type: orderData.orderType || 'LIMIT', // LIMIT, MARKET, SL, SL-M
          transaction_type: orderData.transactionType, // BUY, SELL
          disclosed_quantity: 0,
          trigger_price: orderData.triggerPrice || 0,
          is_amo: false
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      logger.info(`Order placed: ${orderData.transactionType} ${orderData.quantity} of ${orderData.symbol}`);
      
      return response.data.data;
    } catch (error) {
      logger.error('Upstox order error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get order history
   */
  async getOrders() {
    try {
      const response = await axios.get(
        `${UPSTOX_API_URL}/order/retrieve-all`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      return response.data.data;
    } catch (error) {
      logger.error('Upstox orders error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId) {
    try {
      const response = await axios.delete(
        `${UPSTOX_API_URL}/order/cancel`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json'
          },
          data: {
            order_id: orderId
          }
        }
      );

      logger.info(`Order cancelled: ${orderId}`);
      
      return response.data;
    } catch (error) {
      logger.error('Upstox cancel error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Modify order
   */
  async modifyOrder(orderId, modifications) {
    try {
      const response = await axios.put(
        `${UPSTOX_API_URL}/order/modify`,
        {
          order_id: orderId,
          ...modifications
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      logger.info(`Order modified: ${orderId}`);
      
      return response.data;
    } catch (error) {
      logger.error('Upstox modify error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get market quote
   */
  async getQuote(symbol, exchange = 'NSE') {
    try {
      const instrumentKey = `${exchange}_EQ|${symbol}`;
      
      const response = await axios.get(
        `${UPSTOX_API_URL}/market-quote/quotes`,
        {
          params: {
            instrument_key: instrumentKey
          },
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      return response.data.data[instrumentKey];
    } catch (error) {
      logger.error(`Upstox quote error for ${symbol}:`, error.response?.data || error.message);
      throw error;
    }
  }
}

export default new UpstoxService();
```

---

## Step 5: Create Upstox Routes

**Create file: `server/routes/upstox.js`**

```javascript
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import upstoxService from '../services/upstoxService.js';
import prisma from '../services/prisma.js';
import logger from '../services/logger.js';

const router = express.Router();

/**
 * GET /api/upstox/auth
 * Initiate OAuth flow
 */
router.get('/auth', authenticate, (req, res) => {
  try {
    const loginUrl = upstoxService.getLoginUrl();
    res.json({ loginUrl });
  } catch (error) {
    logger.error('Upstox auth error:', error);
    res.status(500).json({ error: 'Failed to generate login URL' });
  }
});

/**
 * GET /api/upstox/callback
 * OAuth callback
 */
router.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code) {
      return res.status(400).json({ error: 'Authorization code missing' });
    }
    
    const accessToken = await upstoxService.getAccessToken(code);
    
    // Store token in database for the user
    // TODO: Associate with logged-in user
    
    res.redirect('https://invest.hungrytimes.in/settings?upstox=connected');
  } catch (error) {
    logger.error('Upstox callback error:', error);
    res.status(500).json({ error: 'Failed to authenticate with Upstox' });
  }
});

/**
 * GET /api/upstox/profile
 * Get Upstox user profile
 */
router.get('/profile', authenticate, async (req, res) => {
  try {
    const profile = await upstoxService.getProfile();
    res.json(profile);
  } catch (error) {
    logger.error('Upstox profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * GET /api/upstox/holdings
 * Get current holdings
 */
router.get('/holdings', authenticate, async (req, res) => {
  try {
    const holdings = await upstoxService.getHoldings();
    res.json(holdings);
  } catch (error) {
    logger.error('Upstox holdings error:', error);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
});

/**
 * GET /api/upstox/funds
 * Get available funds
 */
router.get('/funds', authenticate, async (req, res) => {
  try {
    const funds = await upstoxService.getFunds();
    res.json(funds);
  } catch (error) {
    logger.error('Upstox funds error:', error);
    res.status(500).json({ error: 'Failed to fetch funds' });
  }
});

/**
 * POST /api/upstox/order
 * Place order
 */
router.post('/order', authenticate, async (req, res) => {
  try {
    const { symbol, quantity, price, transactionType, orderType } = req.body;
    
    const orderData = {
      symbol,
      quantity,
      price,
      transactionType, // BUY or SELL
      orderType, // LIMIT or MARKET
      product: 'D', // Delivery
      validity: 'DAY'
    };
    
    const result = await upstoxService.placeOrder(orderData);
    
    res.json({
      success: true,
      orderId: result.order_id,
      message: `Order placed: ${transactionType} ${quantity} ${symbol} @ ₹${price}`
    });
  } catch (error) {
    logger.error('Upstox order error:', error);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

/**
 * GET /api/upstox/orders
 * Get order history
 */
router.get('/orders', authenticate, async (req, res) => {
  try {
    const orders = await upstoxService.getOrders();
    res.json(orders);
  } catch (error) {
    logger.error('Upstox orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * POST /api/upstox/sync-holdings
 * Sync Upstox holdings to Investment Co-Pilot database
 */
router.post('/sync-holdings', authenticate, async (req, res) => {
  try {
    const upstoxHoldings = await upstoxService.getHoldings();
    
    // Clear existing holdings
    await prisma.holding.deleteMany({
      where: { userId: req.user.id }
    });
    
    // Insert Upstox holdings
    const holdings = upstoxHoldings.map(h => ({
      userId: req.user.id,
      symbol: h.trading_symbol,
      quantity: h.quantity,
      avgPrice: h.average_price,
      currentPrice: h.last_price,
      exchange: h.exchange
    }));
    
    await prisma.holding.createMany({ data: holdings });
    
    logger.info(`Synced ${holdings.length} holdings from Upstox`);
    
    res.json({
      success: true,
      synced: holdings.length,
      message: 'Holdings synced successfully'
    });
  } catch (error) {
    logger.error('Upstox sync error:', error);
    res.status(500).json({ error: 'Failed to sync holdings' });
  }
});

export default router;
```

---

## Step 6: Register Upstox Routes

**Edit `server/index.js`:**

```javascript
// Add import
import upstoxRoutes from './routes/upstox.js';

// Register route
app.use('/api/upstox', authenticate, upstoxRoutes);
```

---

## Step 7: Test Upstox Integration

```bash
# 1. Restart containers
cd /opt/invest-copilot
docker-compose restart invest-api

# 2. Get login URL
curl https://invest.hungrytimes.in/api/upstox/auth \
  -H "Authorization: Bearer YOUR_TOKEN"

# 3. Visit the URL, authorize, you'll be redirected back

# 4. Test API
curl https://invest.hungrytimes.in/api/upstox/holdings \
  -H "Authorization: Bearer YOUR_TOKEN"

# 5. Sync holdings
curl -X POST https://invest.hungrytimes.in/api/upstox/sync-holdings \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Features Enabled

✅ **View Holdings** - See all Upstox positions
✅ **Place Orders** - Buy/Sell directly from app
✅ **Track Orders** - Monitor order status
✅ **Sync Data** - Auto-sync with Investment Co-Pilot
✅ **Real-time Quotes** - Live market data
✅ **Fund Management** - Check available balance

---

## Unified Dashboard (3 Demat Accounts)

To show all 3 accounts in one dashboard:

1. **Upstox (Ronobir Ray)** - API integrated ✅
2. **SBI Securities (Mahua Banerjee)** - Manual entry or CSV import
3. **HDFC Securities (Ronobir Ray)** - Manual entry or CSV import

**Implementation:**

```javascript
// Add account field to holdings table
await prisma.holding.updateMany({
  where: { userId: 1 },
  data: { account: 'UPSTOX_RONOBIR' }
});

// Then filter by account in dashboard
const upstoxHoldings = await prisma.holding.findMany({
  where: { userId: 1, account: 'UPSTOX_RONOBIR' }
});

const sbiHoldings = await prisma.holding.findMany({
  where: { userId: 1, account: 'SBI_MAHUA' }
});

const hdfcHoldings = await prisma.holding.findMany({
  where: { userId: 1, account: 'HDFC_RONOBIR' }
});
```

---

## Rate Limits

Upstox API limits:
- **Market Data**: 60 requests/minute
- **Order Placement**: 10 orders/second
- **Historical Data**: 100 requests/minute

---

## Next Steps

1. Get API credentials from Upstox developer portal
2. Add to `.env`
3. Create service and routes files
4. Register routes in `index.js`
5. Test authentication flow
6. Sync holdings
7. Start placing orders! 🚀
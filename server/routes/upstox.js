import express from 'express';
import { placeOrder, getOrderStatus, cancelOrder, getHoldings, getAuthorizationUrl, exchangeCodeForToken } from '../services/upstoxService.js';
import logger from '../services/logger.js';

const router = express.Router();

// ============================================
// PUBLIC ROUTES (no JWT required — Upstox redirects here)
// ============================================

// These are mounted at /api/upstox/callback BEFORE the authenticate middleware
// See index.js for routing setup

/**
 * GET /api/upstox/authorize
 * Get the Upstox OAuth login URL (authenticated — needs JWT)
 */
router.get('/authorize', async (req, res) => {
  try {
    const userId = req.userId;
    const authUrl = await getAuthorizationUrl(userId);
    res.json({ authUrl });
  } catch (error) {
    logger.error('Upstox authorize error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to generate auth URL' });
  }
});

/**
 * POST /api/upstox/place-order
 * Place a buy/sell order via Upstox
 */
router.post('/place-order', async (req, res) => {
  try {
    const userId = req.userId;
    const { symbol, exchange, transactionType, orderType, quantity, price, triggerPrice, portfolioId } = req.body;

    if (!symbol || !transactionType || !quantity) {
      return res.status(400).json({ error: 'symbol, transactionType, and quantity are required' });
    }

    if (!['BUY', 'SELL'].includes(transactionType)) {
      return res.status(400).json({ error: 'transactionType must be BUY or SELL' });
    }

    if (quantity <= 0) {
      return res.status(400).json({ error: 'quantity must be positive' });
    }

    const result = await placeOrder(userId, {
      symbol,
      exchange,
      transactionType,
      orderType,
      quantity,
      price,
      triggerPrice,
      portfolioId
    });

    res.json(result);
  } catch (error) {
    logger.error('Place order error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to place order' });
  }
});

/**
 * GET /api/upstox/order/:orderId
 * Check order status
 */
router.get('/order/:orderId', async (req, res) => {
  try {
    const userId = req.userId;
    const { orderId } = req.params;

    const result = await getOrderStatus(userId, orderId);
    res.json(result);
  } catch (error) {
    logger.error('Order status error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to get order status' });
  }
});

/**
 * DELETE /api/upstox/order/:orderId
 * Cancel an order
 */
router.delete('/order/:orderId', async (req, res) => {
  try {
    const userId = req.userId;
    const { orderId } = req.params;

    const result = await cancelOrder(userId, orderId);
    res.json(result);
  } catch (error) {
    logger.error('Cancel order error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to cancel order' });
  }
});

/**
 * GET /api/upstox/holdings
 * Fetch live holdings from Upstox
 */
router.get('/holdings', async (req, res) => {
  try {
    const userId = req.userId;
    const result = await getHoldings(userId);
    res.json(result);
  } catch (error) {
    logger.error('Upstox holdings error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch holdings' });
  }
});

export default router;

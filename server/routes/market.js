import express from 'express';
import { getCurrentPrice, getIntradayData, searchSymbols } from '../services/marketData.js';
import logger from '../services/logger.js';

const router = express.Router();

/**
 * GET /api/market/price/:symbol - Get current price
 */
router.get('/price/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { exchange = 'NSE' } = req.query;

    const priceData = await getCurrentPrice(symbol, exchange);
    res.json(priceData);
  } catch (error) {
    logger.error('Price fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch price' });
  }
});

/**
 * GET /api/market/intraday/:symbol - Get 5-min candles
 */
router.get('/intraday/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { exchange = 'NSE' } = req.query;

    const candles = await getIntradayData(symbol, exchange);
    res.json(candles);
  } catch (error) {
    logger.error('Intraday data error:', error);
    res.status(500).json({ error: 'Failed to fetch intraday data' });
  }
});

/**
 * GET /api/market/search?q=query - Search symbols
 */
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query too short' });
    }

    const results = await searchSymbols(q);
    res.json(results);
  } catch (error) {
    logger.error('Symbol search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;

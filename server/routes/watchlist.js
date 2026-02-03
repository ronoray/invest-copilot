import express from 'express';
import { PrismaClient } from '@prisma/client';
import { getCurrentPrice } from '../services/marketData.js';
import logger from '../services/logger.js';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /api/watchlist - Get all watchlist stocks
 */
router.get('/', async (req, res) => {
  try {
    const watchlist = await prisma.watchlist.findMany({
      orderBy: { addedAt: 'desc' }
    });

    res.json(watchlist);
  } catch (error) {
    logger.error('Watchlist fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

/**
 * POST /api/watchlist - Add to watchlist
 */
router.post('/', async (req, res) => {
  try {
    const { symbol, exchange = 'NSE', targetPrice, stopLoss, notes } = req.body;

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol required' });
    }

    const item = await prisma.watchlist.create({
      data: {
        symbol,
        exchange,
        targetPrice: targetPrice || null,
        stopLoss: stopLoss || null,
        notes: notes || null
      }
    });

    logger.info(`Added to watchlist: ${symbol}`);
    res.status(201).json(item);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Stock already in watchlist' });
    }
    logger.error('Add to watchlist error:', error);
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

/**
 * PUT /api/watchlist/:id - Update watchlist item
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { targetPrice, stopLoss, notes } = req.body;

    const item = await prisma.watchlist.update({
      where: { id: parseInt(id) },
      data: {
        ...(targetPrice !== undefined && { targetPrice }),
        ...(stopLoss !== undefined && { stopLoss }),
        ...(notes !== undefined && { notes })
      }
    });

    res.json(item);
  } catch (error) {
    logger.error('Update watchlist error:', error);
    res.status(500).json({ error: 'Failed to update watchlist' });
  }
});

/**
 * DELETE /api/watchlist/:id - Remove from watchlist
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.watchlist.delete({
      where: { id: parseInt(id) }
    });

    logger.info(`Removed from watchlist ID: ${id}`);
    res.json({ message: 'Removed from watchlist' });
  } catch (error) {
    logger.error('Delete from watchlist error:', error);
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
});

/**
 * GET /api/watchlist/signals - Check for price alerts
 */
router.get('/signals', async (req, res) => {
  try {
    const watchlist = await prisma.watchlist.findMany();
    const signals = [];

    for (const stock of watchlist) {
      try {
        const priceData = await getCurrentPrice(stock.symbol, stock.exchange);
        
        const signal = {
          symbol: stock.symbol,
          currentPrice: priceData.price,
          change: priceData.change,
          changePercent: priceData.changePercent,
          alerts: []
        };

        // Check target hit
        if (stock.targetPrice && priceData.price >= stock.targetPrice) {
          signal.alerts.push({
            type: 'TARGET_HIT',
            message: `Target of ₹${stock.targetPrice} reached`
          });
        }

        // Check stop loss
        if (stock.stopLoss && priceData.price <= stock.stopLoss) {
          signal.alerts.push({
            type: 'STOP_LOSS_HIT',
            message: `Stop loss of ₹${stock.stopLoss} triggered`
          });
        }

        if (signal.alerts.length > 0) {
          signals.push(signal);
        }

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 12000));
      } catch (error) {
        logger.error(`Signal check failed for ${stock.symbol}`);
      }
    }

    res.json(signals);
  } catch (error) {
    logger.error('Signals check error:', error);
    res.status(500).json({ error: 'Failed to check signals' });
  }
});

export default router;

import express from 'express';
import { PrismaClient } from '@prisma/client';
import { getCurrentPrice } from '../services/marketData.js';
import logger from '../services/logger.js';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /api/portfolio - Get all holdings with P&L
 */
router.get('/', async (req, res) => {
  try {
    const holdings = await prisma.holding.findMany({
      orderBy: { symbol: 'asc' }
    });

    // Calculate P&L for each holding
    const portfolio = holdings.map(h => {
      const investedAmount = Number(h.avgPrice) * h.quantity;
      const currentValue = Number(h.currentPrice) * h.quantity;
      const unrealizedPL = currentValue - investedAmount;
      const plPercent = (unrealizedPL / investedAmount) * 100;

      return {
        id: h.id,
        symbol: h.symbol,
        exchange: h.exchange,
        quantity: h.quantity,
        avgPrice: Number(h.avgPrice),
        currentPrice: Number(h.currentPrice),
        investedAmount,
        currentValue,
        unrealizedPL,
        plPercent: plPercent.toFixed(2),
        updatedAt: h.updatedAt
      };
    });

    // Calculate totals
    const totalInvested = portfolio.reduce((sum, h) => sum + h.investedAmount, 0);
    const totalCurrent = portfolio.reduce((sum, h) => sum + h.currentValue, 0);
    const totalUnrealizedPL = totalCurrent - totalInvested;
    const totalPLPercent = ((totalUnrealizedPL / totalInvested) * 100).toFixed(2);

    res.json({
      holdings: portfolio,
      summary: {
        totalInvested,
        totalCurrent,
        unrealizedPL: totalUnrealizedPL,
        plPercent: totalPLPercent
      }
    });
  } catch (error) {
    logger.error('Portfolio fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch portfolio' });
  }
});

/**
 * POST /api/portfolio - Add new holding
 */
router.post('/', async (req, res) => {
  try {
    const { symbol, exchange = 'NSE', quantity, avgPrice } = req.body;

    // Validate input
    if (!symbol || !quantity || !avgPrice) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get current price
    const priceData = await getCurrentPrice(symbol, exchange);

    // Check if holding exists
    const existing = await prisma.holding.findUnique({
      where: {
        symbol_exchange: { symbol, exchange }
      }
    });

    let holding;

    if (existing) {
      // Update average price with new purchase
      const totalQty = existing.quantity + quantity;
      const newAvgPrice = (
        (Number(existing.avgPrice) * existing.quantity) + 
        (avgPrice * quantity)
      ) / totalQty;

      holding = await prisma.holding.update({
        where: { id: existing.id },
        data: {
          quantity: totalQty,
          avgPrice: newAvgPrice,
          currentPrice: priceData.price
        }
      });
    } else {
      // Create new holding
      holding = await prisma.holding.create({
        data: {
          symbol,
          exchange,
          quantity,
          avgPrice,
          currentPrice: priceData.price
        }
      });
    }

    logger.info(`Added/updated holding: ${symbol} x${quantity}`);
    res.status(201).json(holding);
  } catch (error) {
    logger.error('Add holding error:', error);
    res.status(500).json({ error: 'Failed to add holding' });
  }
});

/**
 * PUT /api/portfolio/:id - Update holding
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, avgPrice } = req.body;

    const holding = await prisma.holding.update({
      where: { id: parseInt(id) },
      data: {
        ...(quantity && { quantity }),
        ...(avgPrice && { avgPrice })
      }
    });

    res.json(holding);
  } catch (error) {
    logger.error('Update holding error:', error);
    res.status(500).json({ error: 'Failed to update holding' });
  }
});

/**
 * DELETE /api/portfolio/:id - Remove holding
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.holding.delete({
      where: { id: parseInt(id) }
    });

    logger.info(`Deleted holding ID: ${id}`);
    res.json({ message: 'Holding deleted' });
  } catch (error) {
    logger.error('Delete holding error:', error);
    res.status(500).json({ error: 'Failed to delete holding' });
  }
});

/**
 * POST /api/portfolio/sync - Sync all prices
 */
router.post('/sync', async (req, res) => {
  try {
    const holdings = await prisma.holding.findMany();
    const updates = [];

    for (const holding of holdings) {
      try {
        const priceData = await getCurrentPrice(holding.symbol, holding.exchange);
        
        await prisma.holding.update({
          where: { id: holding.id },
          data: { currentPrice: priceData.price }
        });

        updates.push({
          symbol: holding.symbol,
          oldPrice: Number(holding.currentPrice),
          newPrice: priceData.price
        });

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 12000));
      } catch (error) {
        logger.error(`Sync failed for ${holding.symbol}:`, error.message);
      }
    }

    logger.info(`Synced ${updates.length} holdings`);
    res.json({ updated: updates });
  } catch (error) {
    logger.error('Portfolio sync error:', error);
    res.status(500).json({ error: 'Failed to sync portfolio' });
  }
});

export default router;

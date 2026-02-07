import express from 'express';
import { PrismaClient } from '@prisma/client';
import { getCurrentPrice } from '../services/marketData.js';
import logger from '../services/logger.js';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /api/portfolio?all=true - Get all portfolios list (for dropdown)
 * GET /api/portfolio - Get holdings summary (existing functionality)
 */
router.get('/', async (req, res) => {
  try {
    const { all } = req.query;
    // const userId = req.userId; // UNCOMMENT when authenticate middleware is added

    // ==================== NEW: Portfolio list for dropdown ====================
    if (all === 'true') {
      const portfolios = await prisma.portfolio.findMany({
        where: {
          // userId, // UNCOMMENT when authenticate middleware is added
          isActive: true
        },
        select: {
          id: true,
          name: true,
          ownerName: true,
          broker: true,
          startingCapital: true,
          currentValue: true,
          availableCash: true,
          markets: true,
          currency: true,
          apiEnabled: true,
          riskProfile: true
        },
        orderBy: {
          id: 'asc'
        }
      });

      return res.json({
        success: true,
        portfolios: portfolios.map(p => ({
          id: p.id,
          name: p.name,
          ownerName: p.ownerName,
          broker: p.broker,
          startingCapital: parseFloat(p.startingCapital),
          currentValue: parseFloat(p.currentValue),
          availableCash: parseFloat(p.availableCash),
          markets: p.markets,
          currency: p.currency,
          apiEnabled: p.apiEnabled,
          riskProfile: p.riskProfile,
          displayName: `${p.name} (${p.ownerName})`
        }))
      });
    }
    const holdings = await prisma.holding.findMany({
      include: {
        portfolio: {
          select: { id: true, name: true, ownerName: true, broker: true }
        }
      },
      orderBy: { symbol: 'asc' }
    });

    // Calculate P&L for each holding
    const portfolio = holdings.map(h => {
      const investedAmount = Number(h.avgPrice) * h.quantity;
      const currentValue = Number(h.currentPrice) * h.quantity;
      const unrealizedPL = currentValue - investedAmount;
      const plPercent = investedAmount > 0 ? (unrealizedPL / investedAmount) * 100 : 0;

      return {
        id: h.id,
        portfolioId: h.portfolioId,
        portfolioName: h.portfolio?.name || 'Unknown',
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

/**
 * GET /api/portfolio/:portfolioId/holdings - Get holdings for specific portfolio
 */
router.get('/:portfolioId/holdings', async (req, res) => {
  try {
    const { portfolioId } = req.params;
    // const userId = req.userId; // UNCOMMENT when authenticate middleware is added

    // Verify portfolio exists
    const portfolio = await prisma.portfolio.findFirst({
      where: { 
        id: parseInt(portfolioId),
        // userId // UNCOMMENT when authenticate middleware is added
      }
    });

    if (!portfolio) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    const holdings = await prisma.holding.findMany({
      where: {
        portfolioId: parseInt(portfolioId)
      },
      orderBy: { symbol: 'asc' }
    });

    // Calculate P&L
    const holdingsWithPL = holdings.map(h => {
      const investedAmount = Number(h.avgPrice) * h.quantity;
      const currentValue = Number(h.currentPrice) * h.quantity;
      const unrealizedPL = currentValue - investedAmount;
      const plPercent = investedAmount > 0 ? (unrealizedPL / investedAmount) * 100 : 0;

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

    res.json({
      success: true,
      portfolioId: portfolio.id,
      portfolioName: portfolio.name,
      holdings: holdingsWithPL
    });
  } catch (error) {
    logger.error('Holdings fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
});

/**
 * POST /api/portfolio/:id/update-capital - Update portfolio capital (PHASE 3)
 */
router.post('/:id/update-capital', async (req, res) => {
  try {
    const { id } = req.params;
    const { newCapital, reason } = req.body;
    const userId = req.userId;

    // Validate
    if (!newCapital || newCapital < 1000) {
      return res.status(400).json({ error: 'Invalid capital amount (min ₹1,000)' });
    }

    // Verify portfolio
    const portfolio = await prisma.portfolio.findFirst({
      where: { 
        id: parseInt(id),
        // userId // UNCOMMENT when authenticate middleware is added
      }
    });

    if (!portfolio) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    const oldCapital = parseFloat(portfolio.startingCapital);
    const difference = newCapital - oldCapital;

    // Update portfolio
    const updated = await prisma.portfolio.update({
      where: { id: parseInt(id) },
      data: {
        startingCapital: newCapital,
        availableCash: {
          increment: difference
        }
      }
    });

    // Record in history
    const history = await prisma.capitalHistory.create({
      data: {
        portfolioId: parseInt(id),
        oldCapital,
        newCapital,
        reason: reason || `Capital ${difference > 0 ? 'increased' : 'decreased'} by ₹${Math.abs(difference).toLocaleString('en-IN')}`,
        changedBy: 'admin@hungrytimes.in'
      }
    });

    logger.info(`Capital updated for portfolio ${id}: ₹${oldCapital} → ₹${newCapital}`);

    res.json({
      success: true,
      portfolio: {
        id: updated.id,
        name: updated.name,
        startingCapital: parseFloat(updated.startingCapital),
        availableCash: parseFloat(updated.availableCash),
        currentValue: parseFloat(updated.currentValue)
      },
      history
    });
  } catch (error) {
    logger.error('Update capital error:', error);
    res.status(500).json({ error: 'Failed to update capital' });
  }
});

export default router;

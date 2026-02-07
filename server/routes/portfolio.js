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
          riskProfile: true,
          investmentGoal: true,
          investmentExperience: true,
          monthlyIncome: true,
          age: true,
          notes: true,
          syncEnabled: true
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
          investmentGoal: p.investmentGoal,
          investmentExperience: p.investmentExperience,
          monthlyIncome: p.monthlyIncome ? parseFloat(p.monthlyIncome) : null,
          age: p.age,
          notes: p.notes,
          syncEnabled: p.syncEnabled,
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

/**
 * POST /api/portfolio/create - Create new portfolio
 */
router.post('/create', async (req, res) => {
  try {
    const {
      name, ownerName, broker,
      startingCapital = 10000,
      riskProfile = 'BALANCED',
      markets = ['NSE'],
      apiEnabled = false,
      notes,
      investmentGoal,
      investmentExperience,
      monthlyIncome,
      age
    } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Portfolio name is required' });
    }
    if (!ownerName || !ownerName.trim()) {
      return res.status(400).json({ error: 'Owner name is required' });
    }
    if (!broker || !broker.trim()) {
      return res.status(400).json({ error: 'Broker is required' });
    }
    if (startingCapital < 1000) {
      return res.status(400).json({ error: 'Starting capital must be at least ₹1,000' });
    }

    const VALID_BROKERS = ['SBI_SECURITIES', 'HDFC_SECURITIES', 'UPSTOX', 'ZERODHA', 'GROWW', 'ANGEL_ONE', 'ICICI_DIRECT', 'KOTAK_SECURITIES', 'MOTILAL_OSWAL', '5PAISA', 'OTHER'];
    if (!VALID_BROKERS.includes(broker)) {
      return res.status(400).json({ error: 'Invalid broker' });
    }

    // Get userId from auth if available
    const userId = req.userId || 1;

    const portfolio = await prisma.portfolio.create({
      data: {
        userId,
        name: name.trim(),
        ownerName: ownerName.trim(),
        broker,
        startingCapital,
        availableCash: startingCapital,
        riskProfile,
        markets,
        apiEnabled,
        notes: notes || null,
        investmentGoal: investmentGoal || null,
        investmentExperience: investmentExperience || null,
        monthlyIncome: monthlyIncome || null,
        age: age || null
      }
    });

    // Record initial capital
    await prisma.capitalHistory.create({
      data: {
        portfolioId: portfolio.id,
        oldCapital: 0,
        newCapital: startingCapital,
        reason: 'Initial capital',
        changedBy: 'user'
      }
    });

    logger.info(`Created portfolio: ${portfolio.name} (ID: ${portfolio.id})`);

    res.status(201).json({
      success: true,
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        ownerName: portfolio.ownerName,
        broker: portfolio.broker,
        startingCapital: parseFloat(portfolio.startingCapital),
        availableCash: parseFloat(portfolio.availableCash),
        riskProfile: portfolio.riskProfile,
        markets: portfolio.markets,
        apiEnabled: portfolio.apiEnabled,
        investmentGoal: portfolio.investmentGoal,
        investmentExperience: portfolio.investmentExperience,
        monthlyIncome: portfolio.monthlyIncome ? parseFloat(portfolio.monthlyIncome) : null,
        age: portfolio.age
      }
    });
  } catch (error) {
    logger.error('Create portfolio error:', error);
    res.status(500).json({ error: 'Failed to create portfolio' });
  }
});

/**
 * PUT /api/portfolio/:id/settings - Update portfolio settings
 */
router.put('/:id/settings', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, ownerName, broker, riskProfile, markets,
      apiEnabled, syncEnabled, notes,
      investmentGoal, investmentExperience, monthlyIncome, age
    } = req.body;

    // Verify portfolio exists
    const existing = await prisma.portfolio.findFirst({
      where: { id: parseInt(id) }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    const VALID_BROKERS = ['SBI_SECURITIES', 'HDFC_SECURITIES', 'UPSTOX', 'ZERODHA', 'GROWW', 'ANGEL_ONE', 'ICICI_DIRECT', 'KOTAK_SECURITIES', 'MOTILAL_OSWAL', '5PAISA', 'OTHER'];
    if (broker && !VALID_BROKERS.includes(broker)) {
      return res.status(400).json({ error: 'Invalid broker' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (ownerName !== undefined) updateData.ownerName = ownerName.trim();
    if (broker !== undefined) updateData.broker = broker;
    if (riskProfile !== undefined) updateData.riskProfile = riskProfile;
    if (markets !== undefined) updateData.markets = markets;
    if (apiEnabled !== undefined) updateData.apiEnabled = apiEnabled;
    if (syncEnabled !== undefined) updateData.syncEnabled = syncEnabled;
    if (notes !== undefined) updateData.notes = notes || null;
    if (investmentGoal !== undefined) updateData.investmentGoal = investmentGoal || null;
    if (investmentExperience !== undefined) updateData.investmentExperience = investmentExperience || null;
    if (monthlyIncome !== undefined) updateData.monthlyIncome = monthlyIncome || null;
    if (age !== undefined) updateData.age = age || null;

    const updated = await prisma.portfolio.update({
      where: { id: parseInt(id) },
      data: updateData
    });

    logger.info(`Updated portfolio settings: ${updated.name} (ID: ${updated.id})`);

    res.json({
      success: true,
      portfolio: {
        id: updated.id,
        name: updated.name,
        ownerName: updated.ownerName,
        broker: updated.broker,
        riskProfile: updated.riskProfile,
        markets: updated.markets,
        apiEnabled: updated.apiEnabled,
        investmentGoal: updated.investmentGoal,
        investmentExperience: updated.investmentExperience,
        monthlyIncome: updated.monthlyIncome ? parseFloat(updated.monthlyIncome) : null,
        age: updated.age,
        notes: updated.notes
      }
    });
  } catch (error) {
    logger.error('Update portfolio settings error:', error);
    res.status(500).json({ error: 'Failed to update portfolio settings' });
  }
});

/**
 * DELETE /api/portfolio/:id - Soft delete portfolio
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.portfolio.findFirst({
      where: { id: parseInt(id) }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    // Prevent deleting the last active portfolio
    const activeCount = await prisma.portfolio.count({
      where: { isActive: true }
    });

    if (activeCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last active portfolio' });
    }

    await prisma.portfolio.update({
      where: { id: parseInt(id) },
      data: { isActive: false }
    });

    logger.info(`Soft-deleted portfolio: ${existing.name} (ID: ${id})`);

    res.json({ success: true, message: 'Portfolio deleted' });
  } catch (error) {
    logger.error('Delete portfolio error:', error);
    res.status(500).json({ error: 'Failed to delete portfolio' });
  }
});

export default router;

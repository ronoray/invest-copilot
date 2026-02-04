import express from 'express';
import { calculatePortfolioTax, calculateTaxOnTrade, monthsUntilLTCG } from '../services/taxCalculator.js';
import { PrismaClient } from '@prisma/client';
import logger from '../services/logger.js';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /api/tax/summary
 * Get complete tax breakdown for portfolio
 */
router.get('/summary', async (req, res) => {
  try {
    // Fetch all holdings
    const holdings = await prisma.holding.findMany({
      include: {
        latestPrice: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    // Transform to format needed for tax calculation
    const holdingsData = holdings.map(h => ({
      id: h.id,
      stock: h.symbol,
      quantity: h.quantity,
      investedValue: h.avgPrice * h.quantity,
      currentValue: (h.latestPrice[0]?.price || h.avgPrice) * h.quantity,
      purchaseDate: h.createdAt,
    }));

    // Fetch realized trades for current FY
    const currentFYStart = new Date(new Date().getFullYear(), 3, 1); // April 1
    const realizedTrades = await prisma.trade.findMany({
      where: {
        type: 'SELL',
        executedAt: {
          gte: currentFYStart,
        },
      },
    });

    // Transform realized trades
    const realizedData = realizedTrades.map(t => ({
      gain: t.profit || 0,
      purchaseDate: t.createdAt,
    }));

    // Calculate tax
    const taxSummary = calculatePortfolioTax(holdingsData, realizedData);

    res.json(taxSummary);
  } catch (error) {
    logger.error('Error calculating tax summary:', error);
    res.status(500).json({ error: 'Failed to calculate tax' });
  }
});

/**
 * POST /api/tax/calculate
 * Calculate tax for a specific trade
 * Body: { gain, purchaseDate, ltcgUsed }
 */
router.post('/calculate', async (req, res) => {
  try {
    const { gain, purchaseDate, ltcgUsed = 0 } = req.body;

    if (!gain || !purchaseDate) {
      return res.status(400).json({ error: 'gain and purchaseDate are required' });
    }

    const taxCalc = calculateTaxOnTrade(parseFloat(gain), new Date(purchaseDate), ltcgUsed);

    res.json(taxCalc);
  } catch (error) {
    logger.error('Error calculating tax:', error);
    res.status(500).json({ error: 'Tax calculation failed' });
  }
});

/**
 * GET /api/tax/opportunities
 * Get tax optimization opportunities
 */
router.get('/opportunities', async (req, res) => {
  try {
    // Get complete tax summary (includes opportunities)
    const holdings = await prisma.holding.findMany({
      include: {
        latestPrice: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const holdingsData = holdings.map(h => ({
      id: h.id,
      stock: h.symbol,
      quantity: h.quantity,
      investedValue: h.avgPrice * h.quantity,
      currentValue: (h.latestPrice[0]?.price || h.avgPrice) * h.quantity,
      purchaseDate: h.createdAt,
    }));

    const taxSummary = calculatePortfolioTax(holdingsData, []);

    res.json({
      opportunities: taxSummary.opportunities,
      remainingExemption: taxSummary.ltcg.exemptRemaining,
    });
  } catch (error) {
    logger.error('Error fetching tax opportunities:', error);
    res.status(500).json({ error: 'Failed to fetch opportunities' });
  }
});

/**
 * GET /api/tax/ltcg-timer/:holdingId
 * Get time remaining to LTCG for a specific holding
 */
router.get('/ltcg-timer/:holdingId', async (req, res) => {
  try {
    const holding = await prisma.holding.findUnique({
      where: { id: parseInt(req.params.holdingId) },
    });

    if (!holding) {
      return res.status(404).json({ error: 'Holding not found' });
    }

    const monthsRemaining = monthsUntilLTCG(holding.createdAt);

    res.json({
      holdingId: holding.id,
      symbol: holding.symbol,
      purchaseDate: holding.createdAt,
      monthsRemaining,
      willBeLTCGOn: new Date(new Date(holding.createdAt).setMonth(new Date(holding.createdAt).getMonth() + 12)),
      isAlreadyLTCG: monthsRemaining === 0,
    });
  } catch (error) {
    logger.error('Error calculating LTCG timer:', error);
    res.status(500).json({ error: 'Failed to calculate timer' });
  }
});

export default router;
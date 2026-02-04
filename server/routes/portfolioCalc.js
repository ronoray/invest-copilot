import express from 'express';
import { 
  calculatePortfolioSummary, 
  getReinvestmentSuggestions
} from '../services/portfolioCalculator.js';
import logger from '../services/logger.js';

const router = express.Router();

/**
 * GET /api/portfolio-calc/summary
 * Get complete portfolio money summary
 */
router.get('/summary', async (req, res) => {
  try {
    const summary = await calculatePortfolioSummary();
    res.json(summary);
  } catch (error) {
    logger.error('Portfolio summary error:', error);
    res.status(500).json({ error: 'Failed to get portfolio summary' });
  }
});

/**
 * GET /api/portfolio-calc/reinvestment
 * Get reinvestment capacity and suggestions
 */
router.get('/reinvestment', async (req, res) => {
  try {
    const suggestions = await getReinvestmentSuggestions();
    res.json(suggestions);
  } catch (error) {
    logger.error('Reinvestment suggestions error:', error);
    res.status(500).json({ error: 'Failed to get reinvestment suggestions' });
  }
});

export default router;
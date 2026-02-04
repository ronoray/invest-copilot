import express from 'express';
import { scanMarketForOpportunities } from '../services/advancedScreener.js';
import { calculatePortfolioSummary, getReinvestmentSuggestions } from '../services/portfolioCalculator.js';
import logger from '../services/logger.js';

const router = express.Router();

/**
 * GET /api/ai/recommendations
 * Returns empty on initial load
 */
router.get('/recommendations', async (req, res) => {
  try {
    res.json({
      categorized: {
        high: [],
        medium: [],
        low: []
      }
    });
  } catch (error) {
    logger.error('Recommendations error:', error);
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

/**
 * POST /api/ai/scan
 * Advanced market scan with real price data
 */
router.post('/scan', async (req, res) => {
  try {
    const { baseAmount = 10000, perCategory = 5 } = req.body;
    
    logger.info(`Starting advanced market scan - amount: ₹${baseAmount}`);
    
    // Get portfolio context
    let portfolioSummary;
    try {
      portfolioSummary = await calculatePortfolioSummary();
    } catch (error) {
      logger.warn('Portfolio unavailable, using default');
      portfolioSummary = { reinvestmentCapacity: baseAmount };
    }
    
    // Run real scanner
    const opportunities = await scanMarketForOpportunities({
      targetCount: { 
        high: perCategory, 
        medium: perCategory, 
        low: perCategory 
      },
      baseAmount: portfolioSummary.reinvestmentCapacity || baseAmount
    });
    
    const total = 
      opportunities.high.length + 
      opportunities.medium.length + 
      opportunities.low.length;
    
    logger.info(`Scan complete: Found ${total} opportunities`);
    
    res.json({
      success: true,
      opportunities,
      summary: {
        total,
        highRisk: opportunities.high.length,
        mediumRisk: opportunities.medium.length,
        lowRisk: opportunities.low.length,
        availableCapital: portfolioSummary.reinvestmentCapacity || baseAmount
      },
      scannedAt: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Market scan error:', error);
    res.status(500).json({ 
      error: 'Market scan failed', 
      message: error.message 
    });
  }
});

/**
 * GET /api/ai/portfolio-plan
 * Generate personalized investment plan
 */
router.get('/portfolio-plan', async (req, res) => {
  try {
    logger.info('Generating portfolio plan...');
    
    // Get portfolio metrics
    const summary = await calculatePortfolioSummary();
    const reinvestment = await getReinvestmentSuggestions();
    
    // Scan for opportunities
    const opportunities = await scanMarketForOpportunities({
      targetCount: { high: 3, medium: 3, low: 3 },
      baseAmount: reinvestment.recommendedAmount || 10000
    });
    
    const allStocks = [
      ...opportunities.high, 
      ...opportunities.medium, 
      ...opportunities.low
    ];
    
    const totalInvestment = allStocks.reduce(
      (sum, s) => sum + (s.suggestedAmount || 0), 
      0
    );
    
    // Calculate expected outcomes
    let bestCase = 0, likelyCase = 0, worstCase = 0;
    allStocks.forEach(stock => {
      const best = stock.targetPrice / stock.price;
      const worst = stock.stopLoss / stock.price;
      
      bestCase += stock.suggestedAmount * best;
      likelyCase += stock.suggestedAmount * ((best + 1) / 2);
      worstCase += stock.suggestedAmount * worst;
    });
    
    res.json({
      portfolio: summary,
      reinvestment,
      plan: {
        totalInvestment,
        stocks: allStocks,
        allocation: {
          highRisk: opportunities.high.reduce((sum, s) => sum + (s.suggestedAmount || 0), 0),
          mediumRisk: opportunities.medium.reduce((sum, s) => sum + (s.suggestedAmount || 0), 0),
          lowRisk: opportunities.low.reduce((sum, s) => sum + (s.suggestedAmount || 0), 0)
        },
        expectedOutcomes: {
          bestCase: Math.round(bestCase),
          bestCasePercent: Math.round(((bestCase - totalInvestment) / totalInvestment) * 100),
          likelyCase: Math.round(likelyCase),
          likelyCasePercent: Math.round(((likelyCase - totalInvestment) / totalInvestment) * 100),
          worstCase: Math.round(worstCase),
          worstCasePercent: Math.round(((worstCase - totalInvestment) / totalInvestment) * 100)
        }
      }
    });
    
    logger.info('Portfolio plan generated successfully');
    
  } catch (error) {
    logger.error('Portfolio plan error:', error);
    res.status(500).json({ 
      error: 'Failed to generate plan', 
      message: error.message 
    });
  }
});

export default router;
import express from 'express';
import { scanMarketForOpportunities } from '../services/advancedScreener.js';
import prisma from '../services/prisma.js';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../services/logger.js';

const router = express.Router();

// Initialize Claude API client
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Safe portfolio summary - never crashes
 */
async function getSafePortfolioSummary() {
  try {
    const holdings = await prisma.holding.findMany();
    
    if (!holdings || holdings.length === 0) {
      return {
        totalValue: 0,
        totalInvested: 0,
        totalProfitLoss: 0,
        profitLossPercent: 0,
        holdings: [],
        totalStocks: 0,
        reinvestmentCapacity: 10000
      };
    }

    let totalValue = 0;
    let totalInvested = 0;

    holdings.forEach(h => {
      const invested = h.quantity * parseFloat(h.avgPrice);
      const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
      totalInvested += invested;
      totalValue += current;
    });

    const totalPL = totalValue - totalInvested;
    const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

    return {
      totalValue,
      totalInvested,
      totalProfitLoss: totalPL,
      profitLossPercent: totalPLPercent,
      holdings: holdings.map(h => ({
        symbol: h.symbol,
        quantity: h.quantity,
        avgPrice: parseFloat(h.avgPrice),
        currentPrice: parseFloat(h.currentPrice || h.avgPrice)
      })),
      totalStocks: holdings.length,
      reinvestmentCapacity: Math.max(10000, totalValue * 0.1)
    };
  } catch (error) {
    logger.error('Portfolio summary error:', error);
    return {
      totalValue: 0,
      totalInvested: 0,
      totalProfitLoss: 0,
      profitLossPercent: 0,
      holdings: [],
      totalStocks: 0,
      reinvestmentCapacity: 10000
    };
  }
}

/**
 * GET /api/ai/recommendations
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
 */
router.post('/scan', async (req, res) => {
  try {
    const { baseAmount = 10000, perCategory = 5 } = req.body;
    
    logger.info(`Starting market scan - amount: ₹${baseAmount}`);
    
    const portfolio = await getSafePortfolioSummary();
    
    const opportunities = await scanMarketForOpportunities({
      targetCount: { 
        high: perCategory, 
        medium: perCategory, 
        low: perCategory 
      },
      baseAmount: portfolio.reinvestmentCapacity || baseAmount
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
        availableCapital: portfolio.reinvestmentCapacity || baseAmount
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
 */
router.get('/portfolio-plan', async (req, res) => {
  try {
    logger.info('Generating portfolio plan...');
    
    // Get portfolio safely
    const summary = await getSafePortfolioSummary();
    
    // Scan for opportunities
    const opportunities = await scanMarketForOpportunities({
      targetCount: { high: 3, medium: 3, low: 3 },
      baseAmount: summary.reinvestmentCapacity || 10000
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
    
    // Get AI insights
    let aiInsights = null;
    try {
      logger.info('Calling Claude API...');
      
      const prompt = `You are a friendly investment advisor. Analyze this portfolio plan:

**Current Portfolio:**
- Value: ₹${summary.totalValue}
- Invested: ₹${summary.totalInvested}
- P&L: ₹${summary.totalProfitLoss} (${summary.profitLossPercent?.toFixed(2)}%)
- Holdings: ${summary.totalStocks} stocks

**Proposed Plan:**
- Investment: ₹${totalInvestment}
- Stocks: ${allStocks.map(s => s.symbol).join(', ')}
- High=${opportunities.high.length}, Medium=${opportunities.medium.length}, Low=${opportunities.low.length}

Return ONLY JSON (no markdown):
{
  "overallRating": "EXCELLENT|GOOD|MODERATE|RISKY",
  "confidence": 75,
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "warnings": ["warning 1", "warning 2"],
  "actionItems": ["action 1", "action 2"],
  "personalizedAdvice": "2-3 sentences",
  "riskAssessment": "1-2 sentences"
}`;

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      });

      const responseText = message.content[0].text;
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        aiInsights = JSON.parse(jsonMatch[0]);
        logger.info('Claude AI analysis completed');
      }
    } catch (aiError) {
      logger.error('Claude API error:', aiError.message);
      aiInsights = {
        overallRating: 'MODERATE',
        confidence: 70,
        keyInsights: ['Market scan completed', 'Diversified allocation', 'Review each stock'],
        warnings: ['AI analysis temporarily unavailable'],
        actionItems: ['Review stocks', 'Set stop losses', 'Monitor regularly'],
        personalizedAdvice: 'Solid plan with balanced risk. Review details carefully.',
        riskAssessment: 'Balanced portfolio with mixed risk levels.'
      };
    }
    
    res.json({
      portfolio: summary,
      reinvestment: {
        recommendedAmount: summary.reinvestmentCapacity,
        reasoning: 'Based on available capital and risk profile',
        strategy: 'BALANCED'
      },
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
      },
      aiInsights
    });
    
    logger.info('Portfolio plan generated successfully');
    
  } catch (error) {
    logger.error('Portfolio plan error:', error.message);
    logger.error('Stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to generate plan', 
      message: error.message
    });
  }
});

export default router;
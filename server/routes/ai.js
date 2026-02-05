import express from 'express';
import { scanMarketForOpportunities } from '../services/advancedScreener.js';
import { calculatePortfolioSummary, getReinvestmentSuggestions } from '../services/portfolioCalculator.js';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../services/logger.js';

const router = express.Router();

// Initialize Claude API client
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

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
 * Generate personalized investment plan with Claude AI insights
 */
router.get('/portfolio-plan', async (req, res) => {
  try {
    logger.info('Generating portfolio plan...');
    
    // Get portfolio metrics (handle empty portfolio and errors gracefully)
    let summary = {
      totalValue: 0,
      totalInvested: 0,
      totalProfitLoss: 0,
      profitLossPercent: 0,
      holdings: [],
      totalStocks: 0
    };
    
    let reinvestment = {
      recommendedAmount: 10000,
      reasoning: 'Starting fresh portfolio',
      strategy: 'BALANCED'
    };
    
    try {
      summary = await calculatePortfolioSummary();
      reinvestment = await getReinvestmentSuggestions();
      logger.info('Portfolio metrics loaded successfully');
    } catch (error) {
      logger.warn('Portfolio calculation failed, using defaults:', error.message);
      // Defaults already set above
    }
    
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
    
    // ✅ NOW ADD CLAUDE AI ANALYSIS
    let aiInsights = null;
    try {
      logger.info('Calling Claude API for portfolio insights...');
      
      const prompt = `You are a friendly investment advisor. Analyze this portfolio plan and provide simple, actionable insights.

**Current Portfolio:**
- Total Value: ₹${summary.totalValue}
- Invested: ₹${summary.totalInvested}
- P&L: ₹${summary.totalProfitLoss} (${summary.profitLossPercent?.toFixed(2)}%)
- Holdings: ${summary.holdings?.length || 0} stocks

**Proposed Plan:**
- Investment Amount: ₹${totalInvestment}
- Stocks: ${allStocks.map(s => `${s.symbol} (₹${s.suggestedAmount})`).join(', ')}
- Risk Distribution: High=${opportunities.high.length}, Medium=${opportunities.medium.length}, Low=${opportunities.low.length}

**Expected Returns:**
- Best Case: ₹${Math.round(bestCase)} (+${Math.round(((bestCase - totalInvestment) / totalInvestment) * 100)}%)
- Likely Case: ₹${Math.round(likelyCase)} (+${Math.round(((likelyCase - totalInvestment) / totalInvestment) * 100)}%)
- Worst Case: ₹${Math.round(worstCase)} (${Math.round(((worstCase - totalInvestment) / totalInvestment) * 100)}%)

Return ONLY this JSON (no markdown, no extra text):
{
  "overallRating": "EXCELLENT|GOOD|MODERATE|RISKY",
  "confidence": 0-100,
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "warnings": ["warning 1", "warning 2"],
  "actionItems": ["action 1", "action 2", "action 3"],
  "personalizedAdvice": "2-3 sentences of friendly advice like talking to a friend",
  "riskAssessment": "1-2 sentences about risk level"
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
        logger.info('Claude AI analysis completed successfully');
      } else {
        logger.warn('Failed to parse Claude response, using fallback');
      }
    } catch (aiError) {
      logger.error('Claude API error:', aiError);
      // Continue without AI insights rather than failing entire request
      aiInsights = {
        overallRating: 'MODERATE',
        confidence: 70,
        keyInsights: ['Market scan completed successfully', 'Diversified risk allocation', 'Consider your risk tolerance'],
        warnings: ['AI analysis temporarily unavailable'],
        actionItems: ['Review each stock recommendation', 'Set stop losses', 'Monitor regularly'],
        personalizedAdvice: 'Solid plan with balanced risk. Review details and invest within your comfort zone.',
        riskAssessment: 'Balanced portfolio with mix of high, medium, and low risk stocks.'
      };
    }
    
    const response = {
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
      },
      aiInsights // ✅ AI-powered insights added!
    };
    
    logger.info('Portfolio plan generated successfully with AI insights');
    res.json(response);
    
  } catch (error) {
    logger.error('Portfolio plan error:', error);
    res.status(500).json({ 
      error: 'Failed to generate plan', 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

export default router;
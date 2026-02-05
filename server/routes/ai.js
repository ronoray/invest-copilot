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
 * 10 COMPREHENSIVE ANALYSIS PROMPTS
 * Each provides deep, actionable insights
 */
const COMPREHENSIVE_PROMPTS = {
  marketAnalysis: (capital, stocks) => `
## 1. MARKET ANALYSIS
Analyze the current stock market environment with a focus on ₹${capital} capital. 
Identify short-term and long-term trends, key support and resistance levels, and emerging patterns. 
Factor in recent earnings, macroeconomic news, and industry developments for ${stocks || 'NSE/BSE top stocks'}.
Suggest 3-5 specific investment opportunities with entry points and reasoning.`,

  portfolioDiversification: (holdings) => `
## 2. PORTFOLIO DIVERSIFICATION  
Current holdings: ${holdings || 'None yet - starting fresh'}

Evaluate concentration risk and suggest diversification strategies:
- 3 new sectors to consider
- 2-3 specific stocks per sector
- Asset allocation percentages
- How each addition reduces portfolio risk`,

  riskManagement: (strategy) => `
## 3. RISK MANAGEMENT
Effective risk management for ${strategy} strategy:
- Stop-loss placement rules (percentage-based)
- Position sizing formula (% of portfolio per trade)
- Diversification guidelines
- Risk-to-reward ratios (minimum 1:2)
Provide specific examples with INR amounts.`,

  technicalAnalysis: (stocks) => `
## 4. TECHNICAL ANALYSIS
Full technical analysis of: ${stocks || 'Top NSE stocks'}

For each stock:
- Price action (support/resistance)
- Volume patterns
- Moving averages (50-day, 200-day)
- RSI (overbought/oversold)
- MACD (momentum)
- Bollinger Bands

BUY/SELL/HOLD with entry/exit points.`,

  economicIndicators: (stocks) => `
## 5. ECONOMIC INDICATORS
How key indicators influence ${stocks || 'Indian markets'}:
- RBI interest rates
- Inflation (CPI/WPI)
- GDP growth
- FII flows
- USD-INR exchange rate
- Crude oil prices

Positioning strategies for upcoming releases.`,

  valueInvesting: (companies) => `
## 6. VALUE INVESTING
Analyze ${companies || 'top NSE companies'} using value principles:
- P/E ratio vs industry
- P/B ratio
- Debt-to-equity
- ROE
- Dividend yield
- Free cash flow
- Competitive moat

Undervalued/overvalued with buy/pass recommendations.`,

  marketSentiment: (stocks) => `
## 7. MARKET SENTIMENT
Assess sentiment for ${stocks || 'Indian markets'}:
- News trends (bullish/bearish)
- Analyst ratings
- Social media sentiment
- Put/call ratios
- FII/DII activity
- India VIX

How to use sentiment for timing.`,

  earningsReports: (companies) => `
## 8. EARNINGS ANALYSIS
Recent earnings for ${companies || 'major NSE companies'}:
- Revenue growth (YoY, QoQ)
- Net profit margins
- EPS
- Forward guidance
- Management commentary
- Segment performance

BEAT/MEET/MISS expectations. Price movement prediction.`,

  growthVsDividend: () => `
## 9. GROWTH VS DIVIDEND
Compare strategies:

**Growth Stocks** (Tech, Pharma):
- High growth potential
- Reinvest profits
- Higher volatility
- Long-term wealth building

**Dividend Stocks** (Banks, Utilities):
- Stable income
- Regular payouts
- Lower volatility
- Income generation

2-3 stocks per category with allocation %.`,

  globalEvents: (stocks) => `
## 10. GLOBAL EVENTS
How global events impact ${stocks || 'Indian markets'}:
- US Federal Reserve policy
- China economic data
- Geopolitical tensions
- Supply chain issues
- Commodity prices

Hedging strategies:
- Sector diversification
- Gold/commodities
- Cash reserves
- Defensive stocks`
};

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
 * EXISTING FUNCTIONALITY - PRESERVED
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
 * EXISTING FUNCTIONALITY - PRESERVED
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
 * EXISTING FUNCTIONALITY - PRESERVED
 */
router.get('/portfolio-plan', async (req, res) => {
  try {
    logger.info('Generating portfolio plan...');
    
    const summary = await getSafePortfolioSummary();
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
    
    let bestCase = 0, likelyCase = 0, worstCase = 0;
    allStocks.forEach(stock => {
      const best = stock.targetPrice / stock.price;
      const worst = stock.stopLoss / stock.price;
      
      bestCase += stock.suggestedAmount * best;
      likelyCase += stock.suggestedAmount * ((best + 1) / 2);
      worstCase += stock.suggestedAmount * worst;
    });
    
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
    res.status(500).json({ 
      error: 'Failed to generate plan', 
      message: error.message
    });
  }
});

/**
 * GET /api/ai/comprehensive-analysis
 * NEW: 10-SECTION COMPREHENSIVE ANALYSIS
 */
router.get('/comprehensive-analysis', async (req, res) => {
  try {
    logger.info('Generating 10-section comprehensive analysis...');
    
    const summary = await getSafePortfolioSummary();
    const holdingsList = summary.holdings.length > 0
      ? summary.holdings.map(h => `${h.symbol} (${h.quantity} shares @ ₹${h.avgPrice})`).join(', ')
      : 'No holdings yet';
    const stockSymbols = summary.holdings.map(h => h.symbol).join(', ') || 'NSE top stocks';
    
    const prompt = `You are an expert investment advisor. Provide comprehensive analysis.

**PORTFOLIO:**
- Capital: ₹${summary.totalValue || 10000}
- Holdings: ${holdingsList}
- P&L: ₹${summary.totalProfitLoss} (${summary.profitLossPercent?.toFixed(2)}%)

${COMPREHENSIVE_PROMPTS.marketAnalysis(summary.totalValue || 10000, stockSymbols)}
${COMPREHENSIVE_PROMPTS.portfolioDiversification(holdingsList)}
${COMPREHENSIVE_PROMPTS.riskManagement('balanced growth')}
${COMPREHENSIVE_PROMPTS.technicalAnalysis(stockSymbols)}
${COMPREHENSIVE_PROMPTS.economicIndicators(stockSymbols)}
${COMPREHENSIVE_PROMPTS.valueInvesting(stockSymbols)}
${COMPREHENSIVE_PROMPTS.marketSentiment(stockSymbols)}
${COMPREHENSIVE_PROMPTS.earningsReports(stockSymbols)}
${COMPREHENSIVE_PROMPTS.growthVsDividend()}
${COMPREHENSIVE_PROMPTS.globalEvents(stockSymbols)}

**FORMAT:**
- Clear headers with emojis
- Specific stock tickers (CAPS)
- Bullet points
- Confidence: HIGH 🟢 / MEDIUM 🟡 / LOW 🔴
- Time: SHORT/MEDIUM/LONG
- Risk: LOW/MODERATE/HIGH
- Use ₹ for prices`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const analysis = message.content[0].text;
    
    logger.info(`Comprehensive analysis complete (${analysis.length} chars)`);
    
    res.json({
      success: true,
      analysis,
      generatedAt: new Date(),
      sectionsCount: 10
    });
    
  } catch (error) {
    logger.error('Comprehensive analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate analysis',
      details: error.message
    });
  }
});

/**
 * GET /api/ai/plan/snapshot
 * NEW: PORTFOLIO SNAPSHOT FOR PLAN PAGE
 */
router.get('/plan/snapshot', async (req, res) => {
  try {
    const config = await prisma.config.findFirst({
      where: { key: 'starting_capital' }
    });
    
    const startingCapital = parseFloat(config?.startingCapital || 0);
    const summary = await getSafePortfolioSummary();
    
    const availableCash = startingCapital - summary.totalInvested;
    
    res.json({
      startingCapital: parseFloat(startingCapital.toFixed(2)),
      currentlyInvested: parseFloat(summary.totalInvested.toFixed(2)),
      availableCash: parseFloat(availableCash.toFixed(2)),
      currentValue: parseFloat(summary.totalValue.toFixed(2)),
      totalPnL: parseFloat(summary.totalProfitLoss.toFixed(2)),
      totalPnLPercent: parseFloat(summary.profitLossPercent.toFixed(2))
    });
    
  } catch (error) {
    logger.error('Plan snapshot error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch snapshot',
      details: error.message 
    });
  }
});

/**
 * POST /api/ai/plan/update-capital
 * NEW: UPDATE STARTING CAPITAL
 */
router.post('/plan/update-capital', async (req, res) => {
  try {
    const { capital } = req.body;
    
    if (!capital || capital <= 0) {
      return res.status(400).json({ error: 'Invalid capital amount' });
    }
    
    const config = await prisma.config.upsert({
      where: { key: 'starting_capital' },
      update: {
        value: capital.toString(),
        startingCapital: parseFloat(capital)
      },
      create: {
        key: 'starting_capital',
        value: capital.toString(),
        startingCapital: parseFloat(capital)
      }
    });
    
    res.json({
      message: 'Starting capital updated',
      capital: parseFloat(config.startingCapital)
    });
    
  } catch (error) {
    logger.error('Update capital error:', error);
    res.status(500).json({ 
      error: 'Failed to update capital',
      details: error.message 
    });
  }
});

export default router;
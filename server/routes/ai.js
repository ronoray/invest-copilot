import express from 'express';
import multer from 'multer';
import { readFileSync, mkdirSync } from 'fs';
import path from 'path';
import { scanMarketForOpportunities } from '../services/advancedScreener.js';
import prisma from '../services/prisma.js';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../services/logger.js';
import crypto from 'crypto';

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
 * Get portfolio summary with capital management data
 * @param {number} portfolioId - Optional portfolio ID to filter by
 * @param {number} userId - User ID for authorization
 * @returns {object} Portfolio summary with startingCapital, availableCash, etc.
 */
async function getSafePortfolioSummary(portfolioId = null, userId = null) {
  try {
    // Build query filters
    const whereClause = {};
    if (userId) whereClause.userId = userId;
    if (portfolioId) whereClause.id = portfolioId;

    // Fetch portfolio(s) - NEW: Include Portfolio model data
    const portfolios = await prisma.portfolio.findMany({
      where: whereClause,
      include: {
        holdings: true
      }
    });

    if (!portfolios || portfolios.length === 0) {
      logger.warn('No portfolios found');
      return {
        portfolioId: null,
        portfolioName: null,
        ownerName: null,
        broker: null,
        startingCapital: 10000,
        availableCash: 10000,
        currentValue: 0,
        totalInvested: 0,
        totalProfitLoss: 0,
        profitLossPercent: 0,
        holdings: [],
        totalStocks: 0,
        reinvestmentCapacity: 10000
      };
    }

    // If multiple portfolios, aggregate (for backward compatibility)
    // If single portfolio, return its specific data
    const isSinglePortfolio = portfolios.length === 1;
    const portfolio = portfolios[0];

    // Calculate holdings summary
    let totalValue = 0;
    let totalInvested = 0;
    const allHoldings = [];

    portfolios.forEach(p => {
      p.holdings.forEach(h => {
        const invested = h.quantity * parseFloat(h.avgPrice);
        const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
        totalInvested += invested;
        totalValue += current;
        
        allHoldings.push({
          symbol: h.symbol,
          quantity: h.quantity,
          avgPrice: parseFloat(h.avgPrice),
          currentPrice: parseFloat(h.currentPrice || h.avgPrice),
          portfolioId: p.id
        });
      });
    });

    const totalPL = totalValue - totalInvested;
    const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

    // NEW: Portfolio-specific data
    if (isSinglePortfolio) {
      const startingCapital = parseFloat(portfolio.startingCapital);
      const availableCash = parseFloat(portfolio.availableCash);
      const currentValue = parseFloat(portfolio.currentValue);

      return {
        portfolioId: portfolio.id,
        portfolioName: portfolio.name,
        ownerName: portfolio.ownerName,
        broker: portfolio.broker,
        startingCapital,
        availableCash,
        currentValue,
        totalInvested,
        totalProfitLoss: totalPL,
        profitLossPercent: totalPLPercent,
        holdings: allHoldings,
        totalStocks: allHoldings.length,
        reinvestmentCapacity: Math.max(availableCash * 0.7, 0) // 70% of available cash
      };
    }

    // Aggregated view (multiple portfolios)
    const totalStartingCapital = portfolios.reduce((sum, p) => sum + parseFloat(p.startingCapital), 0);
    const totalAvailableCash = portfolios.reduce((sum, p) => sum + parseFloat(p.availableCash), 0);

    return {
      portfolioId: null, // Multiple portfolios
      portfolioName: 'All Portfolios',
      ownerName: null,
      broker: null,
      startingCapital: totalStartingCapital,
      availableCash: totalAvailableCash,
      currentValue: totalValue,
      totalInvested,
      totalProfitLoss: totalPL,
      profitLossPercent: totalPLPercent,
      holdings: allHoldings,
      totalStocks: allHoldings.length,
      reinvestmentCapacity: Math.max(totalAvailableCash * 0.7, 0)
    };

  } catch (error) {
    logger.error('Portfolio summary error:', error);
    return {
      portfolioId: null,
      portfolioName: null,
      ownerName: null,
      broker: null,
      startingCapital: 10000,
      availableCash: 10000,
      currentValue: 0,
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
 * GET /api/ai/portfolio-plan?portfolioId=1
 * NEW: Now accepts portfolioId query parameter
 * Returns per-portfolio plan with capital management data
 */
router.get('/portfolio-plan', async (req, res) => {
  try {
    const { portfolioId } = req.query;
    const userId = req.userId; // From auth middleware
    
    logger.info(`Generating portfolio plan... (portfolioId: ${portfolioId || 'all'})`);
    
    // NEW: Pass portfolioId and userId to get portfolio-specific data
    const summary = await getSafePortfolioSummary(
      portfolioId ? parseInt(portfolioId) : null,
      userId
    );
    
    // NEW: Calculate reinvestment recommendation
    const availableCash = summary.availableCash;
    const shouldReinvest = availableCash >= 2000;
    const recommendedAmount = shouldReinvest ? Math.floor(availableCash * 0.7) : 0;
    const bufferAmount = shouldReinvest ? availableCash - recommendedAmount : availableCash;
    
    let reinvestmentReason;
    if (shouldReinvest) {
      reinvestmentReason = `You have ₹${availableCash.toLocaleString('en-IN')} available. Investing ₹${recommendedAmount.toLocaleString('en-IN')} (70%) while keeping ₹${bufferAmount.toLocaleString('en-IN')} as buffer for emergencies.`;
    } else {
      reinvestmentReason = `You have ₹${availableCash.toLocaleString('en-IN')} available. Build up to at least ₹2,000 before investing. Keep saving!`;
    }
    
    // Generate opportunities (only if should reinvest)
    const opportunities = shouldReinvest 
      ? await scanMarketForOpportunities({
          targetCount: { high: 3, medium: 3, low: 3 },
          baseAmount: recommendedAmount
        })
      : { high: [], medium: [], low: [] };
    
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
    
    // Get AI insights (only if investing)
    let aiInsights = null;
    if (shouldReinvest && allStocks.length > 0) {
      try {
        logger.info('Calling Claude API...');
        
        const prompt = `You are a friendly investment advisor. Analyze this portfolio plan:

**Portfolio:** ${summary.portfolioName || 'All Portfolios'}
${summary.ownerName ? `**Owner:** ${summary.ownerName}` : ''}
${summary.broker ? `**Broker:** ${summary.broker}` : ''}

**Current Status:**
- Starting Capital: ₹${summary.startingCapital.toLocaleString('en-IN')}
- Available Cash: ₹${availableCash.toLocaleString('en-IN')}
- Currently Invested: ₹${summary.totalInvested.toLocaleString('en-IN')}
- Current Value: ₹${summary.currentValue.toLocaleString('en-IN')}
- P&L: ₹${summary.totalProfitLoss.toLocaleString('en-IN')} (${summary.profitLossPercent?.toFixed(2)}%)
- Holdings: ${summary.totalStocks} stocks

**Proposed Plan:**
- Investment Amount: ₹${totalInvestment.toLocaleString('en-IN')}
- Stocks: ${allStocks.map(s => s.symbol).join(', ')}
- High Risk=${opportunities.high.length}, Medium Risk=${opportunities.medium.length}, Low Risk=${opportunities.low.length}

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
    }
    
    // NEW: Response structure matching YourPlan.jsx expectations
    res.json({
      portfolio: {
        portfolioId: summary.portfolioId,
        portfolioName: summary.portfolioName,
        ownerName: summary.ownerName,
        broker: summary.broker,
        startingCapital: summary.startingCapital,
        availableCash: availableCash,
        currentValue: summary.currentValue,
        totalInvested: summary.totalInvested,
        totalPL: summary.totalProfitLoss,
        totalPLPercent: summary.profitLossPercent,
        totalValue: summary.currentValue,
        totalStocks: summary.totalStocks
      },
      reinvestment: {
        shouldReinvest,
        recommendedAmount,
        bufferAmount,
        reason: reinvestmentReason,
        strategy: 'BALANCED'
      },
      plan: shouldReinvest ? {
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
      } : null,
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

// ============================================
// SCREENSHOT ANALYSIS (Claude Vision)
// ============================================

// Configure multer for screenshot uploads
const uploadsDir = path.join(process.cwd(), 'uploads', 'screenshots');
try { mkdirSync(uploadsDir, { recursive: true }); } catch (e) { /* exists */ }

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `screenshot-${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'));
    }
  }
});

/**
 * POST /api/ai/parse-screenshot
 * Upload a trade screenshot and extract trade data via Claude Vision
 */
router.post('/parse-screenshot', upload.single('screenshot'), async (req, res) => {
  try {
    const userId = req.userId;
    const { portfolioId } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No screenshot uploaded' });
    }

    logger.info(`Processing screenshot: ${req.file.filename}`);

    // Read image and compute hash
    const imageBuffer = readFileSync(req.file.path);
    const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
    const base64Image = imageBuffer.toString('base64');
    const mediaType = req.file.mimetype;

    // Check for duplicate
    const existing = await prisma.tradeScreenshot.findUnique({
      where: { imageHash }
    });

    if (existing && existing.isConfirmed) {
      return res.status(409).json({
        error: 'This screenshot has already been processed',
        screenshotId: existing.id
      });
    }

    // Send to Claude Vision API
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Image
            }
          },
          {
            type: 'text',
            text: `Extract trade details from this brokerage screenshot. Return ONLY valid JSON:
{
  "symbol": "STOCK_SYMBOL (NSE format, e.g., HDFCBANK, RELIANCE)",
  "quantity": 5,
  "price": 1680.50,
  "tradeType": "BUY or SELL",
  "executedAt": "2025-01-15T10:30:00Z (ISO format, best guess if not visible)",
  "broker": "detected broker name (e.g., Upstox, Zerodha, HDFC Securities)",
  "fees": 15.50,
  "confidence": 0.85,
  "notes": "any additional context"
}
If multiple trades are visible, return an array. If you cannot extract data, return {"error": "reason"}.`
          }
        ]
      }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/[\[{][\s\S]*[\]}]/);

    if (!jsonMatch) {
      return res.status(422).json({ error: 'Could not extract trade data from screenshot' });
    }

    let extractedData = JSON.parse(jsonMatch[0]);

    // Normalize to array
    if (!Array.isArray(extractedData)) {
      extractedData = [extractedData];
    }

    if (extractedData[0]?.error) {
      return res.status(422).json({ error: extractedData[0].error });
    }

    // Save screenshot record
    const firstTrade = extractedData[0];
    const screenshot = await prisma.tradeScreenshot.upsert({
      where: { imageHash },
      update: {
        extractedData: extractedData,
        symbol: firstTrade.symbol,
        quantity: firstTrade.quantity,
        price: firstTrade.price,
        tradeType: firstTrade.tradeType,
        executedAt: firstTrade.executedAt ? new Date(firstTrade.executedAt) : null,
        broker: firstTrade.broker,
        confidence: firstTrade.confidence,
        status: 'PROCESSED',
        portfolioId: portfolioId ? parseInt(portfolioId) : null
      },
      create: {
        userId,
        portfolioId: portfolioId ? parseInt(portfolioId) : null,
        imageUrl: `/uploads/screenshots/${req.file.filename}`,
        imageHash,
        extractedData: extractedData,
        symbol: firstTrade.symbol,
        quantity: firstTrade.quantity,
        price: firstTrade.price,
        tradeType: firstTrade.tradeType,
        executedAt: firstTrade.executedAt ? new Date(firstTrade.executedAt) : null,
        broker: firstTrade.broker,
        confidence: firstTrade.confidence,
        status: 'PROCESSED'
      }
    });

    logger.info(`Screenshot processed: ${screenshot.id}, found ${extractedData.length} trade(s)`);

    res.json({
      success: true,
      screenshotId: screenshot.id,
      trades: extractedData,
      confidence: firstTrade.confidence
    });

  } catch (error) {
    logger.error('Screenshot parse error:', error.message);
    res.status(500).json({ error: 'Failed to process screenshot' });
  }
});

/**
 * POST /api/ai/confirm-screenshot-trade
 * Confirm extracted trade data and save to DB
 */
router.post('/confirm-screenshot-trade', async (req, res) => {
  try {
    const userId = req.userId;
    const { screenshotId, portfolioId, trades } = req.body;

    if (!screenshotId || !portfolioId || !trades || !Array.isArray(trades)) {
      return res.status(400).json({ error: 'screenshotId, portfolioId, and trades array are required' });
    }

    // Verify screenshot exists
    const screenshot = await prisma.tradeScreenshot.findFirst({
      where: { id: screenshotId, userId }
    });

    if (!screenshot) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }

    // Verify portfolio belongs to user
    const portfolio = await prisma.portfolio.findFirst({
      where: { id: parseInt(portfolioId), userId }
    });

    if (!portfolio) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    const createdTrades = [];

    for (const trade of trades) {
      const { symbol, quantity, price, tradeType, executedAt, fees } = trade;

      // Create trade record
      const newTrade = await prisma.trade.create({
        data: {
          portfolioId: parseInt(portfolioId),
          symbol: symbol.toUpperCase(),
          exchange: 'NSE',
          type: tradeType,
          quantity: parseInt(quantity),
          price: parseFloat(price),
          fees: fees ? parseFloat(fees) : 0,
          executedAt: executedAt ? new Date(executedAt) : new Date(),
          source: 'SCREENSHOT',
          screenshotId
        }
      });

      // Update holdings
      if (tradeType === 'BUY') {
        const existing = await prisma.holding.findFirst({
          where: { portfolioId: parseInt(portfolioId), symbol: symbol.toUpperCase(), exchange: 'NSE' }
        });

        if (existing) {
          const totalQty = existing.quantity + parseInt(quantity);
          const newAvg = ((Number(existing.avgPrice) * existing.quantity) + (parseFloat(price) * parseInt(quantity))) / totalQty;

          await prisma.holding.update({
            where: { id: existing.id },
            data: { quantity: totalQty, avgPrice: newAvg }
          });
        } else {
          await prisma.holding.create({
            data: {
              portfolioId: parseInt(portfolioId),
              symbol: symbol.toUpperCase(),
              exchange: 'NSE',
              quantity: parseInt(quantity),
              avgPrice: parseFloat(price),
              currentPrice: parseFloat(price)
            }
          });
        }
      } else if (tradeType === 'SELL') {
        const existing = await prisma.holding.findFirst({
          where: { portfolioId: parseInt(portfolioId), symbol: symbol.toUpperCase(), exchange: 'NSE' }
        });

        if (existing) {
          const newQty = existing.quantity - parseInt(quantity);
          if (newQty <= 0) {
            await prisma.holding.delete({ where: { id: existing.id } });
          } else {
            await prisma.holding.update({
              where: { id: existing.id },
              data: { quantity: newQty }
            });
          }
        }
      }

      createdTrades.push(newTrade);
    }

    // Mark screenshot as confirmed
    await prisma.tradeScreenshot.update({
      where: { id: screenshotId },
      data: { isConfirmed: true, confirmedAt: new Date(), portfolioId: parseInt(portfolioId) }
    });

    logger.info(`Screenshot ${screenshotId} confirmed: ${createdTrades.length} trades saved`);

    res.json({
      success: true,
      trades: createdTrades
    });

  } catch (error) {
    logger.error('Confirm screenshot error:', error.message);
    res.status(500).json({ error: 'Failed to confirm trades' });
  }
});

export default router;
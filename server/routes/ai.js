import express from 'express';
import multer from 'multer';
import { readFileSync, mkdirSync } from 'fs';
import path from 'path';
import { scanMarketForOpportunities, buildProfileBrief, buildAllPortfoliosBrief } from '../services/advancedScreener.js';
import { fetchMarketContext, MARKET_DATA_ANTI_HALLUCINATION_PROMPT } from '../services/marketData.js';
import prisma from '../services/prisma.js';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../services/logger.js';
import crypto from 'crypto';
import { generateMultiAssetRecommendations, getCommodityRecommendations, getMutualFundRecommendations } from '../services/multiAssetRecommendations.js';

const router = express.Router();

// Initialize Claude API client
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * 10 COMPREHENSIVE ANALYSIS PROMPTS — PROFILE-AWARE
 * Each section receives the full portfolio context and provides
 * deeply personalized, actionable insights.
 *
 * @param {string} context - Full portfolio brief (single or all portfolios)
 */
const COMPREHENSIVE_PROMPTS = {
  marketAnalysis: (context) => `
## 1. MARKET ANALYSIS — Personalized Market Outlook

${context}

Given the above investor situation, analyze the current Indian stock market:
- What is the broad market doing (Nifty, Sensex, Bank Nifty) and how does it affect THIS investor?
- For CONSERVATIVE portfolios: Is this a good time to deploy capital or stay defensive?
- For AGGRESSIVE portfolios: What momentum sectors/themes are running? Where are the breakout opportunities?
- Identify 3-5 specific opportunities RIGHT NOW that match each portfolio's risk profile
- Key support/resistance levels on Nifty 50 and sector indices relevant to current holdings
- Upcoming events (earnings season, RBI policy, FII activity) that need attention`,

  portfolioDiversification: (context) => `
## 2. PORTFOLIO DIVERSIFICATION — Gap Analysis

${context}

Analyze concentration risk and diversification gaps for EACH portfolio above:
- What sectors are over-represented or missing entirely?
- For portfolios WITH holdings: Which sectors should be added to reduce correlation?
- For EMPTY portfolios: What's the ideal starting allocation for their risk profile?
- Suggest 3-4 specific stocks per portfolio that address their gaps
- Cross-portfolio view: Are the family's investments collectively well-diversified?
- Asset class gaps: Should any portfolio add MFs, ETFs, gold, or bonds alongside stocks?`,

  riskManagement: (context) => `
## 3. RISK MANAGEMENT — Portfolio-Specific Rules

${context}

Create risk management rules SPECIFIC to each portfolio:
- CONSERVATIVE portfolios: Tighter stop-losses (5-8%), larger positions in quality, max 15% in any single stock
- AGGRESSIVE portfolios: Wider stops (10-15%), smaller positions in speculative plays, trailing stop strategy
- Position sizing formula for each portfolio based on their available capital
- For existing holdings: Which positions are oversized or undersized for the risk profile?
- Portfolio-level risk: Max drawdown scenarios for each portfolio
- Emergency rules: When to go to cash (market crash triggers)
Provide specific ₹ amounts, not just percentages.`,

  technicalAnalysis: (context) => `
## 4. TECHNICAL ANALYSIS — Existing Holdings + Watchlist

${context}

Provide technical analysis for:
A) Every stock currently held in the portfolios above:
   - Current trend (uptrend/downtrend/sideways)
   - Key support and resistance levels
   - RSI zone (oversold/neutral/overbought)
   - Is it a HOLD, ADD MORE, or EXIT?

B) 3-5 new stocks on each risk tier that show strong technical setups:
   - Breakout candidates with volume confirmation
   - Oversold bounces in quality names
   - Chart patterns forming (cup & handle, flags, etc.)

For each: Entry zone, target, stop-loss, and time horizon.`,

  economicIndicators: (context) => `
## 5. ECONOMIC INDICATORS — Impact on This Investor

${context}

How do current economic conditions affect THIS investor's portfolios?
- RBI interest rate stance → Impact on banking/NBFC holdings and bond allocation
- Inflation trajectory → Which holdings benefit or suffer? Should commodities allocation change?
- GDP growth outlook → Which portfolio sectors align with growth? Which are headwinds?
- FII/DII flows → Are foreign investors buying or selling the sectors this investor holds?
- USD/INR trend → Impact on IT holdings, import-dependent companies
- Crude oil → Impact on OMCs, aviation, manufacturing holdings
- For each indicator: Specific action items for conservative vs aggressive portfolios`,

  valueInvesting: (context) => `
## 6. VALUE INVESTING — What's Cheap For This Profile

${context}

Given each portfolio's risk profile and existing holdings:
- For CONSERVATIVE portfolios: Find undervalued large-caps with P/E below sector average, high dividend yield, low debt-to-equity, strong ROE, wide moat. These should be core holdings.
- For AGGRESSIVE portfolios: Find undervalued growth stories — high ROE, expanding margins, market share gainers that are temporarily cheap (fallen angels, sector rotations).
- For each recommendation: P/E vs 5-year average, P/B, debt, ROE, dividend yield, free cash flow
- Intrinsic value estimate vs current price for top 3 picks per portfolio
- Identify any CURRENT holdings that have become overvalued and should be trimmed`,

  marketSentiment: (context) => `
## 7. MARKET SENTIMENT — Timing Guidance

${context}

Current market sentiment analysis relevant to this investor:
- Overall market mood: Fear/Greed indicator equivalent for Indian markets
- FII vs DII battle: Who's buying, who's selling, and what it means
- India VIX: Is volatility elevated or suppressed? What should each portfolio do?
- Sector-specific sentiment for sectors held in the portfolios above
- IPO market temperature: Is retail euphoria or caution the theme?
- Mutual fund inflows/outflows: Are retail investors pumping or dumping?
For each portfolio:
- Should they be DEPLOYING capital now or WAITING?
- If deploying: Lump sum or staggered over weeks?`,

  earningsReports: (context) => `
## 8. EARNINGS ANALYSIS — Holdings & Sector Review

${context}

For every stock currently held in the portfolios:
- Most recent quarterly results: Revenue growth (YoY), PAT margins, EPS
- Did it BEAT/MEET/MISS analyst expectations?
- Management commentary highlights and forward guidance
- What does this mean: HOLD / ADD MORE / EXIT?

For the sectors relevant to empty portfolios (where capital needs to be deployed):
- Which sectors delivered strong earnings this quarter?
- Which companies in those sectors are worth entering?
- Any earnings surprises (positive or negative) creating opportunities?`,

  growthVsDividend: (context) => `
## 9. GROWTH VS DIVIDEND STRATEGY — Personalized Allocation

${context}

Based on each portfolio's risk profile:

**For CONSERVATIVE portfolios:**
- Recommend 3-4 dividend stocks (yield > 2%, consistent payout history, blue-chip)
- Suggest dividend-focused MFs
- Calculate expected annual dividend income from current + recommended holdings
- Build a "dividend income ladder" — monthly income from staggered payouts

**For AGGRESSIVE portfolios:**
- Recommend 3-4 pure growth stocks (revenue growing > 20% YoY, market disruptors)
- Suggest growth-focused MFs (small/mid-cap, sectoral)
- Expected capital appreciation scenario (1-year, 3-year)
- Which current holdings are growth vs value? Is the mix right?

**Cross-portfolio:** How do the portfolios complement each other as a family unit?`,

  globalEvents: (context) => `
## 10. GLOBAL MACRO & HEDGING — Protection Strategy

${context}

How global events impact THIS investor's specific holdings and future plans:
- US Federal Reserve: Rate trajectory and impact on IT stocks, FII flows to India
- China: Manufacturing data, any supply chain shifts benefiting Indian companies held
- Geopolitical: India's trade deals, border situations, defense spending implications
- Global commodities: Oil, gold, copper — impact on specific holdings
- Currency moves: INR outlook and which portfolio positions benefit/suffer

Hedging recommendations per portfolio:
- CONSERVATIVE: Gold allocation (SGB/ETF), G-Sec exposure, cash reserves %
- AGGRESSIVE: Sector hedges, defensive anchor stocks, put option awareness
- Portfolio insurance: How much cash buffer should each portfolio maintain?
- Rebalancing triggers: When to shift allocation between portfolios`
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
 * CLAUDE-POWERED, PROFILE-AWARE MARKET SCAN
 * Accepts optional portfolioId in body; defaults to first portfolio or generic scan
 */
router.post('/scan', async (req, res) => {
  try {
    const userId = req.userId;
    const { baseAmount = 10000, perCategory = 5, portfolioId } = req.body;

    logger.info(`Starting AI market scan - amount: ₹${baseAmount}, portfolioId: ${portfolioId || 'auto'}`);

    // Pull the full portfolio object (with holdings) for profile-aware scanning
    let portfolioData = null;
    if (portfolioId) {
      portfolioData = await prisma.portfolio.findFirst({
        where: { id: parseInt(portfolioId), userId },
        include: { holdings: true }
      });
    } else if (userId) {
      // Default to first active portfolio
      portfolioData = await prisma.portfolio.findFirst({
        where: { userId, isActive: true },
        include: { holdings: true }
      });
    }

    const investAmount = portfolioData
      ? Math.max(parseFloat(portfolioData.availableCash || 0) * 0.7, baseAmount)
      : baseAmount;

    const opportunities = await scanMarketForOpportunities({
      portfolio: portfolioData,
      targetCount: {
        high: perCategory,
        medium: perCategory,
        low: perCategory
      },
      baseAmount: investAmount,
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
        availableCapital: investAmount,
        portfolioName: portfolioData?.name || 'General'
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

    // Pull the full portfolio object with holdings for profile-aware scanning
    let portfolioData = null;
    if (portfolioId) {
      portfolioData = await prisma.portfolio.findFirst({
        where: { id: parseInt(portfolioId), userId },
        include: { holdings: true }
      });
    }

    // Also get the legacy summary for backward-compatible response shape
    const summary = await getSafePortfolioSummary(
      portfolioId ? parseInt(portfolioId) : null,
      userId
    );

    // Calculate reinvestment recommendation
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

    // Generate opportunities with FULL portfolio context (only if should reinvest)
    const opportunities = shouldReinvest
      ? await scanMarketForOpportunities({
          portfolio: portfolioData,  // Pass the full portfolio for profile-aware scanning
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
        
        const profileContext = portfolioData ? buildProfileBrief(portfolioData) : `Portfolio: ${summary.portfolioName || 'All Portfolios'}`;

        const prompt = `You are a friendly but expert investment advisor. Analyze this portfolio plan DEEPLY.

${profileContext}

**PROPOSED INVESTMENT PLAN:**
- Deploy: ₹${totalInvestment.toLocaleString('en-IN')} into ${allStocks.length} stocks
- Stocks: ${allStocks.map(s => `${s.symbol} (₹${s.suggestedAmount?.toLocaleString('en-IN') || '?'}, ${s.riskCategory} risk)`).join(', ')}
- Allocation: High Risk ₹${opportunities.high.reduce((s, st) => s + (st.suggestedAmount || 0), 0).toLocaleString('en-IN')}, Medium Risk ₹${opportunities.medium.reduce((s, st) => s + (st.suggestedAmount || 0), 0).toLocaleString('en-IN')}, Low Risk ₹${opportunities.low.reduce((s, st) => s + (st.suggestedAmount || 0), 0).toLocaleString('en-IN')}

Consider: Does this plan match the investor's risk profile (${portfolioData?.riskProfile || 'BALANCED'})?
Is the allocation appropriate? Are there any red flags? What should they watch out for?

Return ONLY JSON (no markdown):
{
  "overallRating": "EXCELLENT|GOOD|MODERATE|RISKY",
  "confidence": 75,
  "keyInsights": ["insight specific to this investor", "insight 2", "insight 3"],
  "warnings": ["warning specific to their situation", "warning 2"],
  "actionItems": ["action 1 with specific stock/amount", "action 2"],
  "personalizedAdvice": "2-3 sentences referencing their specific portfolio, broker, and risk profile",
  "riskAssessment": "1-2 sentences on whether this plan matches their stated risk tolerance"
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
 * GET /api/ai/comprehensive-analysis?portfolioId=1
 * 10-SECTION COMPREHENSIVE ANALYSIS — PROFILE-AWARE
 *
 * Without portfolioId: Analyzes ALL portfolios as a family unit
 * With portfolioId: Focuses on that specific portfolio
 */
router.get('/comprehensive-analysis', async (req, res) => {
  try {
    const userId = req.userId;
    const { portfolioId } = req.query;

    logger.info(`Generating comprehensive analysis (portfolioId: ${portfolioId || 'all'})...`);

    // Pull full portfolio data with holdings
    let portfolios;
    if (portfolioId) {
      portfolios = await prisma.portfolio.findMany({
        where: { id: parseInt(portfolioId), userId },
        include: { holdings: true }
      });
    } else {
      portfolios = await prisma.portfolio.findMany({
        where: { userId, isActive: true },
        include: { holdings: true }
      });
    }

    if (!portfolios || portfolios.length === 0) {
      return res.status(404).json({ error: 'No portfolios found' });
    }

    // Build the context brief
    const context = portfolioId
      ? buildProfileBrief(portfolios[0])
      : buildAllPortfoliosBrief(portfolios);

    // Fetch real market data for comprehensive analysis
    const allHoldings = portfolios.flatMap(p => p.holdings || []);
    let marketContext = '';
    try {
      marketContext = await fetchMarketContext(allHoldings);
    } catch (e) {
      logger.warn('Could not fetch market context for comprehensive analysis:', e.message);
    }

    const prompt = `You are an expert investment advisor providing a comprehensive 10-section analysis.
This analysis must be DEEPLY PERSONALIZED to the investor's actual situation — their specific holdings, capital, risk profiles, and portfolio goals.
Do NOT give generic advice. Every recommendation must reference the actual portfolios and holdings described below.

${marketContext}
${MARKET_DATA_ANTI_HALLUCINATION_PROMPT}

${context}

Now provide all 10 sections of analysis:

${COMPREHENSIVE_PROMPTS.marketAnalysis(context)}
${COMPREHENSIVE_PROMPTS.portfolioDiversification(context)}
${COMPREHENSIVE_PROMPTS.riskManagement(context)}
${COMPREHENSIVE_PROMPTS.technicalAnalysis(context)}
${COMPREHENSIVE_PROMPTS.economicIndicators(context)}
${COMPREHENSIVE_PROMPTS.valueInvesting(context)}
${COMPREHENSIVE_PROMPTS.marketSentiment(context)}
${COMPREHENSIVE_PROMPTS.earningsReports(context)}
${COMPREHENSIVE_PROMPTS.growthVsDividend(context)}
${COMPREHENSIVE_PROMPTS.globalEvents(context)}

**FORMAT:**
- Clear section headers with numbers and emojis
- Specific stock tickers in CAPS (e.g., HDFCBANK, RELIANCE)
- Reference each portfolio by its actual name and owner (e.g., "For [Owner]'s [Broker] portfolio...")
- Bullet points for clarity
- Confidence: HIGH 🟢 / MEDIUM 🟡 / LOW 🔴
- Time horizon: SHORT / MEDIUM / LONG
- Risk level: LOW / MODERATE / HIGH
- All prices in ₹
- Actionable: "Buy X at ₹Y" not "consider looking into X"`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }]
    });

    const analysis = message.content[0].text;

    logger.info(`Comprehensive analysis complete (${analysis.length} chars, ${portfolios.length} portfolios)`);

    res.json({
      success: true,
      analysis,
      generatedAt: new Date(),
      sectionsCount: 10,
      portfolioScope: portfolioId ? `Portfolio #${portfolioId}` : `All ${portfolios.length} portfolios`
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
// MULTI-ASSET RECOMMENDATIONS
// ============================================

/**
 * POST /api/ai/multi-asset/scan
 * Generate comprehensive multi-asset investment recommendations — PROFILE-AWARE
 */
router.post('/multi-asset/scan', async (req, res) => {
  try {
    const userId = req.userId;
    const { portfolioId, riskProfile = 'BALANCED', capital = 100000, timeHorizon = 'MEDIUM' } = req.body;

    logger.info(`Multi-asset scan: capital=₹${capital}, risk=${riskProfile}, horizon=${timeHorizon}, portfolioId=${portfolioId || 'auto'}`);

    // Pull full portfolio object for profile-aware recommendations
    let portfolioData = null;
    if (portfolioId) {
      portfolioData = await prisma.portfolio.findFirst({
        where: { id: parseInt(portfolioId), userId },
        include: { holdings: true }
      });
    } else if (userId) {
      portfolioData = await prisma.portfolio.findFirst({
        where: { userId, isActive: true },
        include: { holdings: true }
      });
    }

    const effectiveCapital = portfolioData
      ? Math.max(parseFloat(portfolioData.availableCash || 0), capital)
      : capital;

    const result = await generateMultiAssetRecommendations({
      portfolio: portfolioData,
      capital: effectiveCapital,
      riskProfile,
      timeHorizon,
    });

    res.json(result);
  } catch (error) {
    logger.error('Multi-asset scan error:', error.message);
    res.status(500).json({ error: 'Failed to generate multi-asset recommendations', message: error.message });
  }
});

/**
 * GET /api/ai/commodities?capital=X&riskProfile=Y&portfolioId=Z
 * Get commodity-specific recommendations — PROFILE-AWARE
 */
router.get('/commodities', async (req, res) => {
  try {
    const userId = req.userId;
    const { capital = 50000, riskProfile = 'BALANCED', portfolioId } = req.query;

    logger.info(`Commodity recommendations: capital=₹${capital}, risk=${riskProfile}, portfolioId=${portfolioId || 'auto'}`);

    // Pull full portfolio for profile context
    let portfolioData = null;
    if (portfolioId) {
      portfolioData = await prisma.portfolio.findFirst({
        where: { id: parseInt(portfolioId), userId },
        include: { holdings: true }
      });
    } else if (userId) {
      portfolioData = await prisma.portfolio.findFirst({
        where: { userId, isActive: true },
        include: { holdings: true }
      });
    }

    const result = await getCommodityRecommendations({
      portfolio: portfolioData,
      capital: Number(capital),
      riskProfile,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Commodities endpoint error:', error.message);
    res.status(500).json({ error: 'Failed to get commodity recommendations', message: error.message });
  }
});

/**
 * GET /api/ai/mutual-funds?capital=X&riskProfile=Y&timeHorizon=Z&portfolioId=W
 * Get mutual fund recommendations — PROFILE-AWARE
 */
router.get('/mutual-funds', async (req, res) => {
  try {
    const userId = req.userId;
    const { capital = 50000, riskProfile = 'BALANCED', timeHorizon = 'LONG', portfolioId } = req.query;

    logger.info(`MF recommendations: capital=₹${capital}, risk=${riskProfile}, horizon=${timeHorizon}, portfolioId=${portfolioId || 'auto'}`);

    // Pull full portfolio for profile context
    let portfolioData = null;
    if (portfolioId) {
      portfolioData = await prisma.portfolio.findFirst({
        where: { id: parseInt(portfolioId), userId },
        include: { holdings: true }
      });
    } else if (userId) {
      portfolioData = await prisma.portfolio.findFirst({
        where: { userId, isActive: true },
        include: { holdings: true }
      });
    }

    const result = await getMutualFundRecommendations({
      portfolio: portfolioData,
      capital: Number(capital),
      riskProfile,
      timeHorizon,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Mutual funds endpoint error:', error.message);
    res.status(500).json({ error: 'Failed to get mutual fund recommendations', message: error.message });
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
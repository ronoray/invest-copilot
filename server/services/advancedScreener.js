// server/services/advancedScreener.js
// Claude-powered, profile-aware stock screener
// Replaces the old hardcoded mock screener with real AI analysis

import Anthropic from '@anthropic-ai/sdk';
import { getCurrentPrice } from './marketData.js';
import logger from './logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Build a detailed profile brief for Claude from portfolio data.
 * This is the foundation — every AI prompt in the system should use this.
 */
export function buildProfileBrief(portfolio) {
  if (!portfolio) {
    return 'No portfolio context available. Recommend for a moderate-risk Indian retail investor with ₹50,000 capital.';
  }

  const holdingsList = portfolio.holdings?.length > 0
    ? portfolio.holdings.map(h => {
        const invested = h.quantity * parseFloat(h.avgPrice);
        const current = h.quantity * parseFloat(h.currentPrice || h.avgPrice);
        const pl = current - invested;
        const plPct = invested > 0 ? ((pl / invested) * 100).toFixed(1) : '0';
        return `  - ${h.symbol} (${h.exchange}): ${h.quantity} shares @ ₹${parseFloat(h.avgPrice).toFixed(0)} avg, current ₹${parseFloat(h.currentPrice || h.avgPrice).toFixed(0)}, P&L ${pl >= 0 ? '+' : ''}₹${pl.toFixed(0)} (${plPct}%)`;
      }).join('\n')
    : '  (No holdings yet — fresh portfolio)';

  const totalInvested = portfolio.holdings?.reduce((sum, h) => sum + h.quantity * parseFloat(h.avgPrice), 0) || 0;
  const totalCurrent = portfolio.holdings?.reduce((sum, h) => sum + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0) || 0;
  const totalPL = totalCurrent - totalInvested;

  return `**INVESTOR PROFILE:**
- Name: ${portfolio.ownerName || 'Unknown'}
- Portfolio: "${portfolio.name || 'Unnamed'}"
- Broker: ${(portfolio.broker || 'UNKNOWN').replace(/_/g, ' ')}
- Risk Profile: ${portfolio.riskProfile || 'BALANCED'}
- Investment Goal: ${portfolio.investmentGoal?.replace(/_/g, ' ') || 'Not specified'}
- Experience Level: ${portfolio.investmentExperience || 'Not specified'}
- Monthly Income: ${portfolio.monthlyIncome ? '₹' + parseFloat(portfolio.monthlyIncome).toLocaleString('en-IN') : 'Not disclosed'}
- Age: ${portfolio.age || 'Not specified'}
- API Trading: ${portfolio.apiEnabled ? 'YES (can auto-execute orders)' : 'NO (manual trades only)'}
- Markets: ${(portfolio.markets || ['NSE']).join(', ')}

**CAPITAL:**
- Starting Capital: ₹${parseFloat(portfolio.startingCapital || 0).toLocaleString('en-IN')}
- Available Cash: ₹${parseFloat(portfolio.availableCash || 0).toLocaleString('en-IN')}
- Currently Invested: ₹${totalInvested.toLocaleString('en-IN')}
- Current Value: ₹${totalCurrent.toLocaleString('en-IN')}
- Unrealized P&L: ${totalPL >= 0 ? '+' : ''}₹${totalPL.toLocaleString('en-IN')}

**CURRENT HOLDINGS:**
${holdingsList}`;
}

/**
 * Build a brief for ALL portfolios (cross-portfolio view).
 */
export function buildAllPortfoliosBrief(portfolios) {
  if (!portfolios || portfolios.length === 0) {
    return 'No portfolios found.';
  }

  const sections = portfolios.map((p, i) => {
    return `--- Portfolio ${i + 1}: ${p.name} ---\n${buildProfileBrief(p)}`;
  });

  const totalCapital = portfolios.reduce((s, p) => s + parseFloat(p.startingCapital || 0), 0);
  const totalCash = portfolios.reduce((s, p) => s + parseFloat(p.availableCash || 0), 0);
  const allHoldings = portfolios.flatMap(p => p.holdings || []);
  const totalInvested = allHoldings.reduce((s, h) => s + h.quantity * parseFloat(h.avgPrice), 0);
  const totalCurrent = allHoldings.reduce((s, h) => s + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0);

  return `**FAMILY INVESTMENT OVERVIEW:**
- Total Portfolios: ${portfolios.length}
- Total Capital: ₹${totalCapital.toLocaleString('en-IN')}
- Total Available Cash: ₹${totalCash.toLocaleString('en-IN')}
- Total Invested: ₹${totalInvested.toLocaleString('en-IN')}
- Total Current Value: ₹${totalCurrent.toLocaleString('en-IN')}
- Total Holdings: ${allHoldings.length} stocks

${sections.join('\n\n')}`;
}

/**
 * Scan market for opportunities — CLAUDE-POWERED, PROFILE-AWARE
 *
 * @param {object} options
 * @param {object} options.portfolio - Full portfolio object with holdings (from Prisma)
 * @param {object} options.targetCount - { high: N, medium: N, low: N }
 * @param {number} options.baseAmount - Total amount to invest
 * @param {boolean} options.fetchRealPrices - Whether to fetch real prices (slower, rate-limited)
 * @returns {{ high: Array, medium: Array, low: Array }}
 */
export async function scanMarketForOpportunities(options = {}) {
  const {
    portfolio = null,
    targetCount = { high: 3, medium: 3, low: 3 },
    baseAmount = 10000,
    fetchRealPrices = false,
  } = options;

  const totalStocks = (targetCount.high || 3) + (targetCount.medium || 3) + (targetCount.low || 3);

  logger.info(`Starting Claude-powered scan (${totalStocks} stocks, ₹${baseAmount})...`);

  const profileBrief = buildProfileBrief(portfolio);

  // Determine what to emphasize based on risk profile
  const riskProfile = portfolio?.riskProfile || 'BALANCED';
  let riskGuidance;
  if (riskProfile === 'CONSERVATIVE') {
    riskGuidance = `This is a CONSERVATIVE portfolio. Prioritize:
- Low risk: Large-cap dividend stocks (Nifty 50 components), established businesses with consistent earnings
- Medium risk: Select mid-caps only if they have strong fundamentals and low debt
- High risk: Minimal allocation — only include if there's exceptional opportunity with defined downside
- Favor: Banking, FMCG, IT, Pharma, Infrastructure bluechips
- Avoid: Penny stocks, highly leveraged companies, pure momentum plays`;
  } else if (riskProfile === 'AGGRESSIVE') {
    riskGuidance = `This is an AGGRESSIVE portfolio. Prioritize:
- High risk: Momentum small-caps, sector disruptors, turnaround stories, high-beta stocks
- Medium risk: Growth mid-caps in trending sectors (EV, defense, renewable energy, AI/tech)
- Low risk: Include a few large-cap anchors but focus on growth over dividends
- Consider: F&O opportunities, sector rotation plays, IPO-recent listings with momentum
- Be bold but always define stop-losses`;
  } else {
    riskGuidance = `This is a BALANCED portfolio. Provide a well-diversified mix:
- Low risk: Quality large-caps with growth + dividends (40% of allocation)
- Medium risk: Mid-caps in growing sectors with reasonable valuations (35%)
- High risk: Select high-conviction small-cap or momentum plays (25%)
- Balance between value and growth across sectors`;
  }

  const existingSymbols = (portfolio?.holdings || []).map(h => h.symbol).join(', ');

  const prompt = `You are an expert Indian stock market advisor. Analyze the current market conditions and provide specific stock recommendations tailored to this investor's profile.

${profileBrief}

**INVESTMENT AMOUNT:** ₹${baseAmount.toLocaleString('en-IN')} to deploy now

**RISK GUIDANCE:**
${riskGuidance}

**EXISTING HOLDINGS TO AVOID DUPLICATING:** ${existingSymbols || 'None'}

**YOUR TASK:**
Recommend exactly ${targetCount.high || 3} HIGH risk, ${targetCount.medium || 3} MEDIUM risk, and ${targetCount.low || 3} LOW risk NSE stocks.

For EACH stock, provide deep analysis:
- Why this stock specifically for THIS investor's profile and situation
- What catalyst or setup makes it attractive RIGHT NOW
- Concrete entry, target, and stop-loss levels
- How it complements the existing portfolio

Allocate the ₹${baseAmount.toLocaleString('en-IN')} across all ${totalStocks} stocks proportionally based on conviction and risk tier.

Return ONLY valid JSON (no markdown):
{
  "high": [
    {
      "symbol": "SYMBOL",
      "exchange": "NSE",
      "price": 100.00,
      "changePercent": 2.5,
      "riskScore": 8,
      "riskCategory": "high",
      "capCategory": "smallCap",
      "targetPrice": 130.00,
      "stopLoss": 85.00,
      "timeHorizon": "SHORT",
      "timeHorizonDays": 15,
      "suggestedAmount": 3000,
      "simpleWhy": [
        "Specific reason 1 for this investor",
        "Specific reason 2 — catalyst or setup",
        "Specific reason 3 — how it fits the portfolio"
      ],
      "expectedReturns": {
        "best": "+30%",
        "likely": "+15%",
        "worst": "-15%"
      },
      "sector": "Energy",
      "reasoning": "2-3 sentence deep reasoning specific to this investor's situation"
    }
  ],
  "medium": [ ... same structure ... ],
  "low": [ ... same structure ... ]
}

**CRITICAL RULES:**
- Use real NSE stock symbols (e.g., RELIANCE, TCS, HDFCBANK, ZOMATO, SUZLON, etc.)
- Prices should be your best estimate of current market prices
- Do NOT recommend stocks the investor already holds
- Allocations must sum to approximately ₹${baseAmount.toLocaleString('en-IN')}
- simpleWhy must be an array of 3 strings, each specific to this investor
- Be specific and actionable — no generic advice
- Return ONLY the JSON object, nothing else`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Failed to parse Claude response for stock scan');
    }

    const results = JSON.parse(jsonMatch[0]);

    // Validate structure
    const high = results.high || [];
    const medium = results.medium || [];
    const low = results.low || [];

    logger.info(`Claude scan complete: ${high.length} high, ${medium.length} medium, ${low.length} low`);

    // Optionally fetch real prices to replace Claude's estimates
    if (fetchRealPrices) {
      const allStocks = [...high, ...medium, ...low];
      for (const stock of allStocks) {
        try {
          const priceData = await getCurrentPrice(stock.symbol, stock.exchange || 'NSE');
          if (priceData?.price) {
            const ratio = priceData.price / stock.price; // How far off was Claude's estimate
            stock.price = priceData.price;
            stock.change = priceData.change || 0;
            stock.changePercent = priceData.changePercent || stock.changePercent || 0;
            // Scale target and stop-loss proportionally
            stock.targetPrice = parseFloat((stock.targetPrice * ratio).toFixed(2));
            stock.stopLoss = parseFloat((stock.stopLoss * ratio).toFixed(2));
            logger.info(`Real price for ${stock.symbol}: ₹${priceData.price}`);
          }
          // Rate limit: Alpha Vantage free tier = 5/min
          await new Promise(resolve => setTimeout(resolve, 13000));
        } catch (err) {
          logger.warn(`Could not fetch real price for ${stock.symbol}: ${err.message}`);
          // Keep Claude's estimated price
        }
      }
    }

    return { high, medium, low };

  } catch (error) {
    const errDetail = error?.error?.message || error?.message || JSON.stringify(error);
    logger.error(`Claude stock scan error: ${errDetail}`);
    if (error?.status) logger.error(`Claude API status: ${error.status}`);

    // Re-throw so the caller knows the scan failed (not just "0 results")
    throw new Error(`AI scan failed: ${errDetail}`);
  }
}

/**
 * Calculate technicals for a single stock (uses real price data)
 * Kept for backward compatibility
 */
export async function calculateTechnicals(symbol, exchange) {
  try {
    const priceData = await getCurrentPrice(symbol, exchange);
    return {
      price: priceData.price,
      change: priceData.change,
      changePercent: priceData.changePercent,
    };
  } catch (error) {
    logger.error(`Tech calc failed for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get a flat list of common NSE symbols (for reference/fallback)
 */
export function getAllNSESymbols() {
  return [
    // Large Cap
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'ITC', 'SBIN', 'BHARTIARTL',
    'HINDUNILVR', 'LT', 'KOTAKBANK', 'BAJFINANCE', 'MARUTI', 'TITAN', 'ASIANPAINT',
    // Mid Cap
    'ZOMATO', 'PAYTM', 'TATAPOWER', 'ADANIGREEN', 'IRCTC', 'FEDERALBNK', 'VOLTAS',
    'HAVELLS', 'POLYCAB', 'PERSISTENT', 'COFORGE', 'MPHASIS', 'DEEPAKNTR',
    // Small Cap
    'SUZLON', 'YESBANK', 'SAIL', 'NMDC', 'TATACHEM', 'JINDALSAW', 'GMRINFRA',
    'RAILTEL', 'IRFC', 'RVNL', 'BEL', 'HAL', 'COCHINSHIP',
  ];
}

export default { scanMarketForOpportunities, calculateTechnicals, getAllNSESymbols, buildProfileBrief, buildAllPortfoliosBrief };

// server/services/multiAssetRecommendations.js
// Claude-powered, profile-aware multi-asset recommendation engine
// Stocks, MFs, Commodities, Fixed Income, Alternatives — all tuned to investor profile

import Anthropic from '@anthropic-ai/sdk';
import { buildProfileBrief } from './advancedScreener.js';
import { fetchMarketContext, MARKET_DATA_ANTI_HALLUCINATION_PROMPT } from './marketData.js';
import logger from './logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Build allocation guidance based on risk profile
 */
function getAllocationGuidance(riskProfile, timeHorizon) {
  if (riskProfile === 'CONSERVATIVE') {
    return {
      equity: { min: 25, max: 40 },
      mutualFunds: { min: 20, max: 30 },
      commodities: { min: 10, max: 15 },
      fixedIncome: { min: 20, max: 35 },
      alternatives: { min: 0, max: 5 },
      note: 'Conservative: Heavy fixed income + large-cap equity. Minimize speculative exposure. Prioritize capital preservation and steady income.',
    };
  } else if (riskProfile === 'AGGRESSIVE') {
    return {
      equity: { min: 50, max: 65 },
      mutualFunds: { min: 15, max: 25 },
      commodities: { min: 10, max: 20 },
      fixedIncome: { min: 5, max: 10 },
      alternatives: { min: 5, max: 15 },
      note: 'Aggressive: Heavy equity (mid/small-cap focus) + commodities. Growth-oriented MFs. Minimal fixed income. Can include crypto/REITs.',
    };
  }
  // BALANCED / MODERATE
  return {
    equity: { min: 35, max: 50 },
    mutualFunds: { min: 20, max: 30 },
    commodities: { min: 10, max: 15 },
    fixedIncome: { min: 10, max: 20 },
    alternatives: { min: 5, max: 10 },
    note: 'Balanced: Mix of growth and stability. Diversified across asset classes. Equal weight to equity and income.',
  };
}

/**
 * Generate recommendations across multiple asset classes
 * NOW ACCEPTS FULL PORTFOLIO OBJECT for deep personalization
 *
 * @param {object} options
 * @param {object} options.portfolio - Full portfolio object from Prisma (with holdings)
 * @param {number} options.capital - Amount to invest
 * @param {string} options.riskProfile - CONSERVATIVE / BALANCED / AGGRESSIVE
 * @param {string} options.timeHorizon - SHORT / MEDIUM / LONG
 */
export async function generateMultiAssetRecommendations(options = {}) {
  try {
    const {
      portfolio = null,
      capital = 100000,
      riskProfile = 'BALANCED',
      timeHorizon = 'MEDIUM',
    } = options;

    const profileBrief = portfolio
      ? buildProfileBrief(portfolio)
      : `No portfolio context. Recommend for a ${riskProfile} Indian retail investor with ₹${capital.toLocaleString('en-IN')} capital.`;

    const effectiveRisk = portfolio?.riskProfile || riskProfile;
    const allocation = getAllocationGuidance(effectiveRisk, timeHorizon);

    const existingSymbols = (portfolio?.holdings || []).map(h => h.symbol).join(', ');

    // Fetch real market data
    let marketContext = '';
    try {
      marketContext = await fetchMarketContext(portfolio?.holdings || []);
    } catch (e) {
      logger.warn('Could not fetch market context for multi-asset:', e.message);
    }

    const prompt = `You are an expert Indian financial advisor creating a COMPREHENSIVE multi-asset investment portfolio.

${marketContext}
${MARKET_DATA_ANTI_HALLUCINATION_PROMPT}

${profileBrief}

**INVESTMENT PARAMETERS:**
- Capital to Deploy: ₹${capital.toLocaleString('en-IN')}
- Risk Profile: ${effectiveRisk}
- Time Horizon: ${timeHorizon}
- Existing Holdings to AVOID: ${existingSymbols || 'None'}

**ALLOCATION GUIDANCE (${effectiveRisk}):**
${allocation.note}
- Equity: ${allocation.equity.min}-${allocation.equity.max}%
- Mutual Funds: ${allocation.mutualFunds.min}-${allocation.mutualFunds.max}%
- Commodities: ${allocation.commodities.min}-${allocation.commodities.max}%
- Fixed Income: ${allocation.fixedIncome.min}-${allocation.fixedIncome.max}%
- Alternatives: ${allocation.alternatives.min}-${allocation.alternatives.max}%

**YOUR TASK:**
Create a DEEPLY PERSONALIZED multi-asset portfolio. Every recommendation must explain WHY it fits THIS specific investor.

For a CONSERVATIVE profile: Emphasize SGBs, G-Secs, large-cap MFs, dividend stocks, FDs. Avoid crypto, small-caps, F&O.
For an AGGRESSIVE profile: Emphasize growth stocks, small/mid-cap MFs, commodity plays, REITs, selective crypto. Minimize FDs.
For a BALANCED profile: Even mix. Quality large + mid caps, balanced MFs, gold, some corporate bonds.

For EVERY recommendation, include a "guide" object for COMPLETE BEGINNERS:
- Step-by-step instructions assuming NO demat account, NO investment experience
- Platform-specific tips (Zerodha, Upstox, Groww, SBI, etc.)
- Common mistakes to avoid

Include a "riskLevel" field: "HIGH", "MEDIUM", or "LOW" for every recommendation.

Return ONLY valid JSON (no markdown):
{
  "portfolioSummary": {
    "totalCapital": ${capital},
    "riskProfile": "${effectiveRisk}",
    "expectedAnnualReturn": "X-Y%",
    "timeHorizon": "${timeHorizon}",
    "investorName": "${portfolio?.ownerName || 'Investor'}",
    "broker": "${portfolio?.broker || 'Not specified'}"
  },
  "allocation": {
    "equity": { "percentage": 0, "amount": 0 },
    "mutualFunds": { "percentage": 0, "amount": 0 },
    "commodities": { "percentage": 0, "amount": 0 },
    "fixedIncome": { "percentage": 0, "amount": 0 },
    "alternatives": { "percentage": 0, "amount": 0 }
  },
  "recommendations": {
    "stocks": [
      {
        "symbol": "SYMBOL",
        "sector": "Sector",
        "currentPrice": 100,
        "targetPrice": 130,
        "stopLoss": 85,
        "allocation": 10000,
        "timeHorizon": "SHORT/MEDIUM/LONG",
        "riskLevel": "HIGH/MEDIUM/LOW",
        "reasoning": "Why this stock for THIS investor — reference their risk profile, existing holdings, and goals",
        "guide": {
          "title": "How to Buy SYMBOL",
          "steps": ["Step 1 for complete beginner...", "Step 2...", "Step 3..."],
          "tips": ["Tip 1", "Tip 2"],
          "platforms": ["Platform 1", "Platform 2"]
        }
      }
    ],
    "etfs": [
      {
        "name": "ETF Name",
        "ticker": "TICKER",
        "allocation": 5000,
        "riskLevel": "LOW/MEDIUM/HIGH",
        "reasoning": "Why this ETF for this investor",
        "guide": { "title": "...", "steps": [], "tips": [], "platforms": [] }
      }
    ],
    "mutualFunds": [
      {
        "name": "Fund Name",
        "category": "Large Cap/Mid Cap/Small Cap/Debt/Hybrid/ELSS",
        "amc": "AMC Name",
        "returns1y": "X%",
        "returns3y": "X%",
        "returns5y": "X%",
        "expenseRatio": "X%",
        "minSip": 500,
        "allocation": 5000,
        "riskLevel": "LOW/MEDIUM/HIGH",
        "reasoning": "Why this fund for this investor",
        "guide": { "title": "...", "steps": [], "tips": [], "platforms": [] }
      }
    ],
    "commodities": [
      {
        "type": "Gold/Silver/Crude Oil",
        "instrument": "SGB/ETF/Digital Gold/MCX",
        "currentTrend": "Bullish/Bearish/Sideways",
        "allocation": 5000,
        "riskLevel": "LOW/MEDIUM/HIGH",
        "reasoning": "Why for this investor",
        "guide": { "title": "...", "steps": [], "tips": [], "platforms": [] }
      }
    ],
    "fixedIncome": [
      {
        "type": "G-Sec/Corporate Bond/FD/PPF/NPS",
        "instrument": "Specific instrument",
        "yieldPercent": 7.0,
        "tenure": "X years",
        "rating": "Sovereign/AAA/AA+",
        "allocation": 5000,
        "riskLevel": "LOW/MEDIUM",
        "reasoning": "Why for this investor",
        "guide": { "title": "...", "steps": [], "tips": [], "platforms": [] }
      }
    ],
    "alternatives": [
      {
        "type": "REIT/InvIT/Crypto/P2P",
        "name": "Specific name",
        "expectedYield": "X-Y%",
        "minInvestment": 500,
        "allocation": 2000,
        "riskLevel": "MEDIUM/HIGH",
        "reasoning": "Why for this investor",
        "guide": { "title": "...", "steps": [], "tips": [], "platforms": [] }
      }
    ]
  },
  "rebalancing": {
    "frequency": "Monthly/Quarterly/Semi-Annual",
    "triggers": ["Trigger 1", "Trigger 2"]
  },
  "taxOptimization": {
    "ltcg": "Specific advice for this investor",
    "stcg": "Specific advice",
    "elss": "Specific advice",
    "otherBenefits": "NPS 80CCD, HRA if applicable"
  }
}

**CRITICAL RULES:**
- Use REAL Indian instrument names (NSE stocks, actual MF names, real SGB series)
- Do NOT recommend stocks the investor already holds
- Allocations must sum to approximately ₹${capital.toLocaleString('en-IN')}
- Every "reasoning" field must reference THIS investor's specific situation
- Guides must be genuinely helpful for absolute beginners
- Provide at least 4-5 stocks, 2-3 ETFs, 4-6 MFs, 2-3 commodities, 2-3 fixed income, 1-2 alternatives
- Return ONLY the JSON object`;

    logger.info(`Generating multi-asset recommendations (${effectiveRisk}, ₹${capital})...`);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Failed to parse AI response for multi-asset recommendations');
    }

    const recommendations = JSON.parse(jsonMatch[0]);

    logger.info('Multi-asset recommendations generated successfully');

    return {
      success: true,
      recommendations,
      generatedAt: new Date().toISOString()
    };

  } catch (error) {
    logger.error('Multi-asset recommendations error:', error);
    throw error;
  }
}

/**
 * Get commodity recommendations — PROFILE-AWARE
 *
 * @param {object} options
 * @param {object} options.portfolio - Full portfolio from Prisma
 * @param {number} options.capital - Amount for commodities
 * @param {string} options.riskProfile - Fallback risk profile
 */
export async function getCommodityRecommendations(options = {}) {
  try {
    const {
      portfolio = null,
      capital = 50000,
      riskProfile = 'BALANCED',
    } = options;

    const profileBrief = portfolio
      ? buildProfileBrief(portfolio)
      : `Investor with ₹${capital.toLocaleString('en-IN')} for commodities, ${riskProfile} risk profile.`;

    const effectiveRisk = portfolio?.riskProfile || riskProfile;

    let commodityGuidance;
    if (effectiveRisk === 'CONSERVATIVE') {
      commodityGuidance = `CONSERVATIVE investor — prioritize:
- Sovereign Gold Bonds (SGB) — tax-free after 8 years, 2.5% annual interest
- Gold ETFs for liquidity
- AVOID crude oil futures and silver (too volatile)
- Max 10-15% of total portfolio in commodities`;
    } else if (effectiveRisk === 'AGGRESSIVE') {
      commodityGuidance = `AGGRESSIVE investor — can include:
- Gold (SGBs + ETFs) as hedge, not main play
- Silver ETFs — higher beta than gold, good for momentum
- Crude Oil proxy stocks (ONGC, Oil India, BPCL) instead of direct MCX
- Consider commodity-focused MFs for diversified exposure
- Up to 15-20% of portfolio in commodities`;
    } else {
      commodityGuidance = `BALANCED investor:
- Gold as 60% of commodity allocation (SGBs preferred, ETFs for flexibility)
- Silver as 25% (via ETFs)
- Crude oil proxy as 15% (via energy stocks)
- Total commodities: 10-15% of overall portfolio`;
    }

    const prompt = `You are an expert Indian commodity market advisor. Analyze commodity markets and provide recommendations tailored to this investor.

${profileBrief}

**COMMODITY CAPITAL:** ₹${capital.toLocaleString('en-IN')}

**COMMODITY GUIDANCE (${effectiveRisk}):**
${commodityGuidance}

For EVERY recommendation, include a "guide" object for COMPLETE BEGINNERS with step-by-step instructions.
Include a "riskLevel" field: Gold/SGBs = LOW, Silver = MEDIUM, Crude Oil = HIGH.

**PROVIDE DETAILED RECOMMENDATIONS FOR:**
1. **Gold** — Compare: Sovereign Gold Bonds vs Gold ETFs vs Digital Gold. Which is best for this investor and why?
2. **Silver** — Silver ETFs, Digital Silver. Only if risk profile allows.
3. **Crude Oil** — MCX awareness + proxy stocks (ONGC, Oil India, etc.). Only for moderate/aggressive.
4. **Agricultural Commodities** — Mention awareness only (not directly investable for retail easily).

Return ONLY valid JSON:
{
  "commodities": [
    {
      "type": "Gold",
      "currentPrice": 6500,
      "recommendation": "BUY/HOLD/AVOID",
      "riskLevel": "LOW",
      "allocation": 25000,
      "instruments": [
        {
          "name": "Sovereign Gold Bonds 2024-25 Series",
          "type": "SGB",
          "allocation": 15000,
          "why": "Specific reason for THIS investor"
        },
        {
          "name": "Nippon India Gold ETF",
          "type": "ETF",
          "allocation": 10000,
          "why": "Specific reason"
        }
      ],
      "outlook": "2-3 sentence market outlook",
      "reasoning": "Why gold specifically for this investor's situation",
      "guide": {
        "title": "How to Invest in Gold",
        "steps": ["Detailed step 1 for beginner...", "Step 2...", "Step 3..."],
        "tips": ["Tip 1", "Tip 2"],
        "platforms": ["Platform 1", "Platform 2"]
      }
    }
  ],
  "summary": {
    "totalAllocation": ${capital},
    "goldPercent": 60,
    "silverPercent": 25,
    "otherPercent": 15,
    "overallOutlook": "1-2 sentence summary"
  }
}

Use real instrument names. Allocations must sum to ≈₹${capital.toLocaleString('en-IN')}. Return ONLY JSON.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Failed to parse commodity recommendations');
    }

    return JSON.parse(jsonMatch[0]);

  } catch (error) {
    logger.error('Commodity recommendations error:', error);
    throw error;
  }
}

/**
 * Get mutual fund recommendations — PROFILE-AWARE
 *
 * @param {object} options
 * @param {object} options.portfolio - Full portfolio from Prisma
 * @param {number} options.capital - Amount for MFs
 * @param {string} options.riskProfile - Fallback risk profile
 * @param {string} options.timeHorizon - SHORT/MEDIUM/LONG
 */
export async function getMutualFundRecommendations(options = {}) {
  try {
    const {
      portfolio = null,
      capital = 50000,
      riskProfile = 'BALANCED',
      timeHorizon = 'LONG',
    } = options;

    const profileBrief = portfolio
      ? buildProfileBrief(portfolio)
      : `Investor with ₹${capital.toLocaleString('en-IN')} for mutual funds, ${riskProfile} risk, ${timeHorizon} horizon.`;

    const effectiveRisk = portfolio?.riskProfile || riskProfile;

    let mfGuidance;
    if (effectiveRisk === 'CONSERVATIVE') {
      mfGuidance = `CONSERVATIVE — prioritize:
- Large Cap Index Funds (Nifty 50, Sensex) — 40% of MF allocation
- Balanced Advantage / Dynamic Asset Allocation funds — 25%
- Debt Funds (short duration, banking & PSU) — 20%
- ELSS for tax saving (large-cap ELSS) — 15%
- AVOID small-cap, sectoral, and thematic funds
- Prefer SIP over lump sum for equity funds`;
    } else if (effectiveRisk === 'AGGRESSIVE') {
      mfGuidance = `AGGRESSIVE — prioritize:
- Small Cap Funds — 25% (high growth potential)
- Mid Cap Funds — 25%
- Sectoral/Thematic (IT, Pharma, Defense, Manufacturing) — 20%
- Large Cap for stability anchor — 15%
- ELSS for tax saving — 15%
- Can do lump sum in corrections, SIP for regular deployment
- Consider international funds for diversification`;
    } else {
      mfGuidance = `BALANCED — diversified mix:
- Large Cap / Index Funds — 30%
- Mid Cap Funds — 20%
- Small Cap (limited) — 10%
- Balanced Advantage — 15%
- Debt Funds — 10%
- ELSS — 15%
- SIP preferred for equity, lump sum OK for debt`;
    }

    const prompt = `You are an expert Indian mutual fund advisor. Recommend MFs tailored to this investor.

${profileBrief}

**MF CAPITAL:** ₹${capital.toLocaleString('en-IN')}
**TIME HORIZON:** ${timeHorizon}

**MF GUIDANCE (${effectiveRisk}):**
${mfGuidance}

For EVERY fund, include a "guide" object for COMPLETE BEGINNERS.
Include a "riskLevel" field: Large Cap/Debt = LOW, Mid Cap/Hybrid = MEDIUM, Small Cap/Sectoral = HIGH.

**CATEGORIES TO COVER:**
1. Large Cap / Index Funds (1-2 funds)
2. Mid Cap Funds (1-2 funds)
3. Small Cap Funds (1 fund if risk allows, otherwise skip)
4. Balanced / Hybrid Funds (1 fund)
5. Debt Funds (1 fund — short duration or banking & PSU)
6. ELSS Tax Saving (1 fund)
7. Sectoral/Thematic (1 fund if aggressive, otherwise skip)

For each fund provide: REAL fund name, AMC, actual return estimates, expense ratio, minimum SIP amount.

Return ONLY valid JSON:
{
  "mutualFunds": [
    {
      "name": "Real Fund Name Direct Growth",
      "category": "Large Cap/Mid Cap/Small Cap/Debt/Hybrid/ELSS/Sectoral",
      "amc": "AMC Name",
      "returns1y": "X%",
      "returns3y": "X%",
      "returns5y": "X%",
      "expenseRatio": "X%",
      "minSip": 500,
      "allocation": 10000,
      "riskLevel": "LOW/MEDIUM/HIGH",
      "reasoning": "Why this fund for THIS specific investor — reference their risk profile and goals",
      "guide": {
        "title": "How to Start SIP in [Fund Name]",
        "steps": ["Step 1 for complete beginner...", "Step 2...", "Step 3..."],
        "tips": ["Tip 1", "Tip 2"],
        "platforms": ["Platform 1", "Platform 2"]
      }
    }
  ],
  "sipRecommendation": {
    "totalMonthly": 10000,
    "distribution": [
      {"fund": "Fund Name", "monthly": 3000, "reasoning": "Why this SIP amount"}
    ],
    "sipVsLumpsum": "Advice specific to current market conditions and this investor's risk profile"
  },
  "summary": {
    "totalAllocation": ${capital},
    "equityMfPercent": 70,
    "debtMfPercent": 20,
    "hybridPercent": 10,
    "expectedReturn": "X-Y% CAGR over ${timeHorizon === 'LONG' ? '5+' : timeHorizon === 'MEDIUM' ? '2-5' : '1-2'} years"
  }
}

Use REAL fund names (Direct Growth plans preferred). Always recommend Direct plans over Regular. Allocations ≈ ₹${capital.toLocaleString('en-IN')}. Return ONLY JSON.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 5000,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('Failed to parse mutual fund recommendations');
    }

    return JSON.parse(jsonMatch[0]);

  } catch (error) {
    logger.error('Mutual fund recommendations error:', error);
    throw error;
  }
}

export default {
  generateMultiAssetRecommendations,
  getCommodityRecommendations,
  getMutualFundRecommendations
};

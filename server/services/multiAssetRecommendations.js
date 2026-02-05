// server/services/multiAssetRecommendations.js
import Anthropic from '@anthropic-ai/sdk';
import logger from './logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Generate recommendations across multiple asset classes
 * - Stocks (NSE/BSE)
 * - Mutual Funds
 * - ETFs
 * - Commodities (Gold, Silver, Crude Oil)
 * - Bonds/Fixed Income
 */
export async function generateMultiAssetRecommendations(userProfile) {
  try {
    const { capital, riskProfile, timeHorizon, existingHoldings } = userProfile;
    
    const prompt = `You are an expert financial advisor. Create a comprehensive multi-asset investment portfolio.

**USER PROFILE:**
- Available Capital: ₹${capital}
- Risk Profile: ${riskProfile} (CONSERVATIVE/MODERATE/AGGRESSIVE)
- Time Horizon: ${timeHorizon} (SHORT/MEDIUM/LONG)
- Existing Holdings: ${existingHoldings || 'None'}

**PROVIDE RECOMMENDATIONS FOR:**

## 1. EQUITY (40-60% allocation)
### A. Direct Stocks (NSE/BSE)
- 5 stocks with detailed analysis
- For each: symbol, sector, buy price, target, stop loss, allocation amount, reasoning

### B. ETFs
- 2-3 ETFs for diversification
- Nifty 50 ETF, Bank ETF, Pharma ETF, etc.
- Why each ETF, allocation

## 2. MUTUAL FUNDS (20-30% allocation)
### A. Large Cap Funds
- 1-2 recommendations
- Fund name, AMC, 3-year returns, why recommend

### B. Mid/Small Cap Funds
- 1-2 recommendations for growth

### C. Debt/Hybrid Funds
- 1-2 for stability

## 3. COMMODITIES (10-15% allocation)
### A. Gold
- Digital Gold, Gold ETF, or Sovereign Gold Bonds
- How much to allocate, why

### B. Silver
- Silver ETF if suitable

### C. Crude Oil (optional)
- For aggressive investors

## 4. FIXED INCOME (10-20% allocation)
### A. Government Bonds
- G-Secs, Treasury Bills

### B. Corporate Bonds
- AAA-rated bonds

### C. Fixed Deposits
- Bank FDs for safety

## 5. ALTERNATIVE INVESTMENTS (5-10% if applicable)
- REITs (Real Estate)
- InvITs (Infrastructure)
- Cryptocurrencies (if risk appetite allows)

**FORMAT YOUR RESPONSE AS JSON:**
{
  "portfolioSummary": {
    "totalCapital": ${capital},
    "riskProfile": "${riskProfile}",
    "expectedAnnualReturn": "X-Y%",
    "timeHorizon": "${timeHorizon}"
  },
  "allocation": {
    "equity": { "percentage": 50, "amount": 0 },
    "mutualFunds": { "percentage": 20, "amount": 0 },
    "commodities": { "percentage": 15, "amount": 0 },
    "fixedIncome": { "percentage": 10, "amount": 0 },
    "alternatives": { "percentage": 5, "amount": 0 }
  },
  "recommendations": {
    "stocks": [
      {
        "symbol": "RELIANCE",
        "sector": "Energy",
        "currentPrice": 2450,
        "targetPrice": 2850,
        "stopLoss": 2250,
        "allocation": 10000,
        "timeHorizon": "MEDIUM",
        "reasoning": "Strong fundamentals, growth in telecom and retail"
      }
    ],
    "etfs": [
      {
        "name": "Nifty 50 ETF",
        "ticker": "NIFTYBEES",
        "allocation": 5000,
        "reasoning": "Low-cost broad market exposure"
      }
    ],
    "mutualFunds": [
      {
        "name": "HDFC Top 100 Fund",
        "category": "Large Cap",
        "amc": "HDFC Mutual Fund",
        "returns3y": "18%",
        "allocation": 5000,
        "reasoning": "Consistent performance, low expense ratio"
      }
    ],
    "commodities": [
      {
        "type": "Gold",
        "instrument": "Sovereign Gold Bonds",
        "allocation": 5000,
        "reasoning": "Hedge against inflation, tax benefits"
      }
    ],
    "fixedIncome": [
      {
        "type": "Government Bonds",
        "instrument": "10Y G-Sec",
        "yieldPercent": 7.2,
        "allocation": 3000,
        "reasoning": "Safe, government-backed"
      }
    ]
  },
  "rebalancing": {
    "frequency": "Quarterly",
    "triggers": ["Market correction >10%", "Allocation drift >5%"]
  },
  "taxOptimization": {
    "ltcg": "Utilize ₹1L exemption for equity",
    "stcg": "Book short-term losses to offset gains",
    "elss": "Invest ₹1.5L in ELSS for 80C deduction"
  }
}

**CRITICAL:** Return ONLY valid JSON, no markdown, no extra text.`;

    logger.info('Generating multi-asset recommendations...');
    
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0.7,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('Failed to parse AI response');
    }

    const recommendations = JSON.parse(jsonMatch[0]);
    
    logger.info('Multi-asset recommendations generated');
    
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
 * Get specific commodity recommendations
 */
export async function getCommodityRecommendations(capital, riskProfile) {
  try {
    const prompt = `Analyze commodity markets for Indian investors.

Capital: ₹${capital}
Risk Profile: ${riskProfile}

**PROVIDE RECOMMENDATIONS FOR:**

1. **Gold**
   - Current price trend
   - Entry point
   - Digital Gold vs Gold ETF vs Sovereign Gold Bonds
   - Allocation amount

2. **Silver**
   - Price outlook
   - Best instrument (ETF, Digital Silver)
   - Allocation

3. **Crude Oil**
   - MCX Crude Oil futures (if aggressive)
   - Oil & Gas stocks as proxy
   - Allocation

4. **Agricultural Commodities**
   - Wheat, Soybean, Cotton (via ETFs)
   - Rationale

Return JSON:
{
  "commodities": [
    {
      "type": "Gold",
      "currentPrice": 6500,
      "recommendation": "BUY",
      "instruments": [
        {"name": "SGB 2024", "allocation": 5000, "why": "Tax-free after 8 years"}
      ],
      "outlook": "Bullish due to global uncertainty"
    }
  ]
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('Failed to parse response');
    }

    return JSON.parse(jsonMatch[0]);
    
  } catch (error) {
    logger.error('Commodity recommendations error:', error);
    throw error;
  }
}

/**
 * Get mutual fund recommendations
 */
export async function getMutualFundRecommendations(capital, riskProfile, timeHorizon) {
  try {
    const prompt = `Recommend mutual funds for Indian investors.

Capital: ₹${capital}
Risk Profile: ${riskProfile}
Time Horizon: ${timeHorizon}

**CATEGORIES TO COVER:**

1. **Large Cap Funds** (Stability)
   - 2 funds
   - Top AMCs: HDFC, ICICI, SBI, Axis

2. **Mid Cap Funds** (Growth)
   - 1-2 funds
   - Higher risk, higher return potential

3. **Small Cap Funds** (Aggressive Growth)
   - 1 fund if risk profile allows

4. **Hybrid/Balanced Funds**
   - 1-2 funds for balanced allocation

5. **Debt Funds** (Safety)
   - 1 fund for conservative portion

6. **ELSS (Tax Saving)**
   - 1 fund for 80C benefit

Return JSON:
{
  "mutualFunds": [
    {
      "name": "HDFC Top 100 Fund",
      "category": "Large Cap",
      "amc": "HDFC Mutual Fund",
      "returns1y": "15%",
      "returns3y": "18%",
      "returns5y": "16%",
      "expenseRatio": "0.98%",
      "minSip": 500,
      "allocation": 5000,
      "reasoning": "Consistent performer, low expense",
      "riskRating": "LOW"
    }
  ],
  "sipRecommendation": {
    "totalMonthly": 10000,
    "distribution": [
      {"fund": "HDFC Top 100", "monthly": 3000},
      {"fund": "Axis Midcap", "monthly": 2000}
    ]
  }
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('Failed to parse response');
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
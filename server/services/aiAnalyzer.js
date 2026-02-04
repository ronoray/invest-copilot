import Anthropic from '@anthropic-ai/sdk';
import logger from './logger.js';
import { analyzeTechnicals, determineRiskCategory } from './technicalAnalysis.js';

const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

/**
 * Analyze a stock using Claude AI with simple, noob-friendly explanations
 * @param {string} symbol - Stock symbol (e.g., "RELIANCE")
 * @param {string} exchange - Exchange (NSE/BSE)
 * @param {object} marketData - Current price, volume, etc.
 * @param {object} technicals - Technical analysis data
 * @returns {object} AI analysis with simple recommendations
 */
export async function analyzeStock(symbol, exchange, marketData, technicals) {
  try {
    const riskCategory = determineRiskCategory(technicals, marketData.marketCap || 50000);
    
    const prompt = `You are a friendly stock market advisor explaining to a complete beginner (like explaining to a 10-year-old).

**Stock**: ${symbol} (${exchange})
**Current Price**: ₹${marketData.price}
**Risk Level**: ${riskCategory}

**Technical Indicators**:
- RSI: ${technicals.indicators.rsi} ${technicals.indicators.rsi < 30 ? '(OVERSOLD - cheap!)' : technicals.indicators.rsi > 70 ? '(OVERBOUGHT - expensive!)' : '(NORMAL)'}
- Trend: ${technicals.trend}
- Volume: ${technicals.indicators.volume ? technicals.indicators.volume.status : 'NORMAL'}
- Momentum: ${technicals.indicators.momentum ? technicals.indicators.momentum.status : 'NEUTRAL'}
- Volatility: ${technicals.indicators.volatility}%

**Your Job**: 
Create a SIMPLE recommendation that a beginner can understand. Use analogies, avoid jargon.

Return ONLY this JSON (no markdown, no extra text):
{
  "recommendation": "BUY" | "HOLD" | "SELL",
  "confidence": 0-100,
  "simpleReason": "1-2 sentence explanation like you're talking to a friend over chai",
  "entryPrice": ${marketData.price},
  "targetPrice": number,
  "stopLoss": number,
  "investmentAmount": "Suggested ₹ amount (₹500-5000 based on risk)",
  "riskLevel": "${riskCategory}",
  "timeHorizon": "SHORT (5-15 days)" | "MEDIUM (1-3 months)" | "LONG (6+ months)",
  "whyBuy": "Simple reason #1|Simple reason #2|Simple reason #3",
  "risks": "Simple risk #1|Simple risk #2",
  "comparison": "Simple analogy comparing this to everyday thing (cricket bet, lottery, fixed deposit, etc.)"
}

Example "simpleReason": "Stock is on sale! Like buying shoes at 50% off. Chart shows it could jump 20% soon."
Example "whyBuy": "Government pushing wind energy|Chart shows breakout pattern|Price is dirt cheap vs history"
Example "comparison": "Like betting on an underdog cricket team - risky but big reward if they win"`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const responseText = message.content[0].text;
    
    // Extract JSON
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse AI response');
    }

    const analysis = JSON.parse(jsonMatch[0]);

    logger.info(`AI analysis completed for ${symbol}: ${analysis.recommendation} (${analysis.confidence}%)`);

    return {
      symbol,
      exchange,
      currentPrice: marketData.price,
      marketCap: marketData.marketCap,
      analysis,
      technicals,
      analyzedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`AI analysis error for ${symbol}:`, error);
    throw error;
  }
}

/**
 * Scan and analyze multiple stocks with simple explanations
 * @param {array} stocks - Array of stock data with technicals
 * @returns {array} Analysis results for all stocks
 */
export async function scanStocks(stocks) {
  const results = [];

  for (const stockData of stocks) {
    try {
      // Add delay to respect API rate limits
      await new Promise(resolve => setTimeout(resolve, 2000));

      const analysis = await analyzeStock(
        stockData.symbol,
        stockData.exchange,
        {
          price: stockData.currentPrice,
          marketCap: stockData.marketCap,
        },
        stockData.technicals
      );

      results.push(analysis);
    } catch (error) {
      logger.error(`Failed to analyze ${stockData.symbol}:`, error);
      results.push({
        symbol: stockData.symbol,
        error: 'Analysis failed',
      });
    }
  }

  return results;
}

export default {
  analyzeStock,
  scanStocks,
};
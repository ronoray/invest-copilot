import logger from './logger.js';

/**
 * Technical Analysis Service
 * Calculates RSI, MACD, Bollinger Bands, Moving Averages, Volume analysis
 */

/**
 * Calculate RSI (Relative Strength Index)
 * @param {array} prices - Array of closing prices (most recent last)
 * @param {number} period - Period for RSI (default 14)
 * @returns {number} RSI value (0-100)
 */
export function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  // Calculate initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Calculate subsequent values
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return Math.round(rsi * 100) / 100;
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 * @param {array} prices - Array of closing prices
 * @returns {object} MACD line, Signal line, Histogram
 */
export function calculateMACD(prices) {
  if (prices.length < 26) return null;

  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = ema12 - ema26;

  // Signal line is 9-day EMA of MACD line
  const macdHistory = [macdLine]; // Simplified - should track history
  const signalLine = calculateEMA(macdHistory, 9);
  const histogram = macdLine - signalLine;

  return {
    macd: Math.round(macdLine * 100) / 100,
    signal: Math.round(signalLine * 100) / 100,
    histogram: Math.round(histogram * 100) / 100,
    status: histogram > 0 ? 'BULLISH' : 'BEARISH',
  };
}

/**
 * Calculate EMA (Exponential Moving Average)
 * @param {array} prices - Array of prices
 * @param {number} period - EMA period
 * @returns {number} EMA value
 */
export function calculateEMA(prices, period) {
  if (prices.length < period) return null;

  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Calculate Simple Moving Average
 * @param {array} prices - Array of prices
 * @param {number} period - SMA period
 * @returns {number} SMA value
 */
export function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const recent = prices.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

/**
 * Calculate Bollinger Bands
 * @param {array} prices - Array of prices
 * @param {number} period - Period (default 20)
 * @param {number} stdDev - Standard deviations (default 2)
 * @returns {object} Upper, Middle, Lower bands
 */
export function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) return null;

  const sma = calculateSMA(prices, period);
  const recentPrices = prices.slice(-period);

  // Calculate standard deviation
  const variance = recentPrices.reduce((sum, price) => {
    return sum + Math.pow(price - sma, 2);
  }, 0) / period;

  const standardDeviation = Math.sqrt(variance);

  return {
    upper: Math.round((sma + stdDev * standardDeviation) * 100) / 100,
    middle: Math.round(sma * 100) / 100,
    lower: Math.round((sma - stdDev * standardDeviation) * 100) / 100,
    bandwidth: Math.round((standardDeviation / sma) * 10000) / 100, // As percentage
  };
}

/**
 * Analyze volume for breakouts
 * @param {array} volumes - Array of volume data (most recent last)
 * @param {number} period - Period to compare (default 20)
 * @returns {object} Volume analysis
 */
export function analyzeVolume(volumes, period = 20) {
  if (volumes.length < period + 1) return null;

  const recentVolumes = volumes.slice(-period - 1, -1);
  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / period;
  const currentVolume = volumes[volumes.length - 1];

  const volumeRatio = currentVolume / avgVolume;

  return {
    avgVolume: Math.round(avgVolume),
    currentVolume: Math.round(currentVolume),
    ratio: Math.round(volumeRatio * 100) / 100,
    status: volumeRatio > 2 ? 'BREAKOUT' : volumeRatio > 1.5 ? 'HIGH' : 'NORMAL',
  };
}

/**
 * Calculate price momentum
 * @param {array} prices - Array of prices
 * @param {number} period - Period to calculate momentum
 * @returns {object} Momentum analysis
 */
export function calculateMomentum(prices, period = 10) {
  if (prices.length < period + 1) return null;

  const currentPrice = prices[prices.length - 1];
  const pastPrice = prices[prices.length - period - 1];

  const change = currentPrice - pastPrice;
  const changePercent = (change / pastPrice) * 100;

  return {
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(changePercent * 100) / 100,
    status: changePercent > 20 ? 'STRONG_UP' : 
            changePercent > 10 ? 'MODERATE_UP' :
            changePercent < -20 ? 'STRONG_DOWN' :
            changePercent < -10 ? 'MODERATE_DOWN' : 'NEUTRAL',
  };
}

/**
 * Calculate volatility (standard deviation of returns)
 * @param {array} prices - Array of prices
 * @param {number} period - Period for calculation
 * @returns {number} Volatility percentage
 */
export function calculateVolatility(prices, period = 20) {
  if (prices.length < period + 1) return null;

  const returns = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    const dailyReturn = (prices[i] - prices[i - 1]) / prices[i - 1];
    returns.push(dailyReturn);
  }

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, ret) => {
    return sum + Math.pow(ret - avgReturn, 2);
  }, 0) / returns.length;

  const volatility = Math.sqrt(variance) * Math.sqrt(252); // Annualized
  return Math.round(volatility * 10000) / 100; // As percentage
}

/**
 * Comprehensive technical analysis for a stock
 * @param {object} stockData - Object with prices and volumes arrays
 * @returns {object} Complete technical analysis
 */
export function analyzeTechnicals(stockData) {
  const { prices, volumes, symbol } = stockData;

  if (!prices || prices.length < 30) {
    logger.warn(`Insufficient data for ${symbol}`);
    return null;
  }

  try {
    const rsi = calculateRSI(prices);
    const macd = calculateMACD(prices);
    const bb = calculateBollingerBands(prices);
    const volumeAnalysis = volumes ? analyzeVolume(volumes) : null;
    const momentum = calculateMomentum(prices, 10);
    const volatility = calculateVolatility(prices);

    const sma20 = calculateSMA(prices, 20);
    const sma50 = calculateSMA(prices, 50);
    const sma200 = calculateSMA(prices, 200);
    const currentPrice = prices[prices.length - 1];

    // Determine trend
    let trend = 'NEUTRAL';
    if (sma20 && sma50 && sma200) {
      if (currentPrice > sma20 && sma20 > sma50 && sma50 > sma200) {
        trend = 'STRONG_UPTREND';
      } else if (currentPrice > sma20 && sma20 > sma50) {
        trend = 'UPTREND';
      } else if (currentPrice < sma20 && sma20 < sma50 && sma50 < sma200) {
        trend = 'STRONG_DOWNTREND';
      } else if (currentPrice < sma20 && sma20 < sma50) {
        trend = 'DOWNTREND';
      }
    }

    // Generate signals
    const signals = [];
    
    // RSI signals
    if (rsi < 30) signals.push({ type: 'BUY', reason: 'RSI oversold', strength: 'STRONG' });
    else if (rsi > 70) signals.push({ type: 'SELL', reason: 'RSI overbought', strength: 'STRONG' });
    
    // MACD signals
    if (macd && macd.status === 'BULLISH') {
      signals.push({ type: 'BUY', reason: 'MACD bullish crossover', strength: 'MODERATE' });
    }
    
    // Volume breakout
    if (volumeAnalysis && volumeAnalysis.status === 'BREAKOUT') {
      signals.push({ type: 'BUY', reason: 'Volume breakout', strength: 'STRONG' });
    }
    
    // Momentum
    if (momentum && momentum.status === 'STRONG_UP') {
      signals.push({ type: 'BUY', reason: 'Strong momentum', strength: 'MODERATE' });
    }

    // Bollinger Band squeeze/breakout
    if (bb && bb.bandwidth < 10) {
      signals.push({ type: 'WATCH', reason: 'Bollinger squeeze - volatility breakout imminent', strength: 'MODERATE' });
    }

    return {
      symbol,
      currentPrice,
      indicators: {
        rsi,
        macd,
        bollingerBands: bb,
        sma20,
        sma50,
        sma200,
        volume: volumeAnalysis,
        momentum,
        volatility,
      },
      trend,
      signals,
      analysis: {
        isBullish: signals.filter(s => s.type === 'BUY').length > signals.filter(s => s.type === 'SELL').length,
        isOversold: rsi < 30,
        isOverbought: rsi > 70,
        hasVolumeBre: volumeAnalysis && volumeAnalysis.status === 'BREAKOUT',
        trendStrength: trend.includes('STRONG') ? 'STRONG' : trend.includes('TREND') ? 'MODERATE' : 'WEAK',
      },
    };
  } catch (error) {
    logger.error(`Technical analysis error for ${symbol}:`, error);
    return null;
  }
}

/**
 * Determine risk category based on technical analysis
 * @param {object} technicals - Technical analysis results
 * @param {number} marketCap - Market cap in crores
 * @returns {string} HIGH, MEDIUM, or LOW risk
 */
export function determineRiskCategory(technicals, marketCap) {
  const { indicators, signals } = technicals;
  
  let riskScore = 0;

  // Volatility factor (higher volatility = higher risk)
  if (indicators.volatility > 40) riskScore += 3;
  else if (indicators.volatility > 25) riskScore += 2;
  else riskScore += 1;

  // Market cap factor (smaller = higher risk)
  if (marketCap < 5000) riskScore += 3; // Small-cap
  else if (marketCap < 20000) riskScore += 2; // Mid-cap
  else riskScore += 1; // Large-cap

  // Signal strength (aggressive signals = higher risk)
  const strongSignals = signals.filter(s => s.strength === 'STRONG').length;
  if (strongSignals >= 2) riskScore += 1;

  // RSI extremes (contrarian plays = higher risk)
  if (indicators.rsi < 25 || indicators.rsi > 75) riskScore += 1;

  // Categorize
  if (riskScore >= 7) return 'HIGH';
  if (riskScore >= 4) return 'MEDIUM';
  return 'LOW';
}

export default {
  calculateRSI,
  calculateMACD,
  calculateEMA,
  calculateSMA,
  calculateBollingerBands,
  analyzeVolume,
  calculateMomentum,
  calculateVolatility,
  analyzeTechnicals,
  determineRiskCategory,
};
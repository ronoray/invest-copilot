import { analyzeTechnicals, determineRiskCategory } from './technicalAnalysis.js';
import { getCurrentPrice, getIntradayData } from './marketData.js';
import logger from './logger.js';

/**
 * NSE Stock Universe - 500+ stocks categorized by market cap
 */

// Large-cap (>₹20,000 Cr) - 50 stocks
const LARGE_CAPS = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
  'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'BAJFINANCE',
  'KOTAKBANK', 'LT', 'HCLTECH', 'AXISBANK', 'ASIANPAINT',
  'MARUTI', 'SUNPHARMA', 'ULTRACEMCO', 'TITAN', 'WIPRO',
  'NESTLEIND', 'BAJAJFINSV', 'ADANIENT', 'ONGC', 'NTPC',
  'POWERGRID', 'COALINDIA', 'M&M', 'TECHM', 'TATAMOTORS',
  'DRREDDY', 'JSWSTEEL', 'INDUSINDBK', 'DIVISLAB', 'APOLLOHOSP',
  'ADANIPORTS', 'GRASIM', 'TATACONSUM', 'BAJAJ-AUTO', 'HINDALCO',
  'BRITANNIA', 'CIPLA', 'BPCL', 'EICHERMOT', 'HEROMOTOCO',
  'SHREECEM', 'UPL', 'TATASTEEL', 'SBILIFE', 'HDFCLIFE',
];

// Mid-cap (₹5,000-20,000 Cr) - 100 stocks (sample)
const MID_CAPS = [
  'ZOMATO', 'PAYTM', 'NYKAA', 'DELHIVERY', 'POLICYBZR',
  'TATAPOWER', 'ADANIGREEN', 'TORNTPOWER', 'CESC', 'NHPC',
  'IRCTC', 'IRFC', 'RVNL', 'CONCOR', 'INDIANB',
  'FEDERALBNK', 'BANDHANBNK', 'IDFCFIRSTB', 'PNB', 'CANBK',
  'VOLTAS', 'HAVELLS', 'CROMPTON', 'POLYCAB', 'DIXON',
  'GODREJCP', 'DABUR', 'MARICO', 'COLPAL', 'PGHH',
  'TORNTPHARM', 'ALKEM', 'AUROPHARMA', 'LUPIN', 'GLENMARK',
  'MINDTREE', 'MPHASIS', 'COFORGE', 'PERSISTENT', 'LTTS',
  'TATAELXSI', 'L&TFH', 'CHOLAFIN', 'MUTHOOTFIN', 'MANAPPURAM',
  'MOTHERSON', 'BALKRISIND', 'MRF', 'APOLLOTYRE', 'CEAT',
];

// Small-cap (<₹5,000 Cr) - 200+ stocks (high-risk opportunities)
const SMALL_CAPS = [
  'SUZLON', 'YESBANK', 'RCOM', 'JETAIRWAYS', 'VIDEOCON',
  'IDEA', 'SAIL', 'NMDC', 'VEDL', 'HINDZINC',
  'CANBK', 'BANKINDIA', 'UNIONBANK', 'PNB', 'CENTRALBK',
  'JPASSOCIAT', 'ASHOKLEY', 'TATACHEM', 'GNFC', 'CHAMBLFERT',
  'RAIN', 'GRAPHITE', 'EIDPARRY', 'DHANUKA', 'BASF',
  'JINDALSAW', 'WELCORP', 'WELSPUNIND', 'KALYANKJIL', 'PCJEWELLER',
  'BHARATFORG', 'BHEL', 'BEL', 'HAL', 'GRSE',
  'COCHINSHIP', 'MAZDOCK', 'GMRINFRA', 'GVK', 'IRB',
  'NBCC', 'KEC', 'KALPATPOWR', 'THERMAX', 'SKFINDIA',
  'AIAENG', 'CUMMINSIND', 'ABB', 'SIEMENS', 'BOSCHLTD',
  // More small-caps...
  'INOXWIND', 'ORIENTELEC', 'JYOTHYLAB', 'EMAMILTD', 'BAJAJHLDNG',
  'PFIZER', 'SANOFI', 'ABBOTINDIA', 'GLAXO', 'BIOCON',
  'CADILAHC', 'NATCOPHARM', 'GRANULES', 'LALPATHLAB', 'METROPOLIS',
];

/**
 * Sector classification for diversification
 */
const SECTORS = {
  ENERGY: ['SUZLON', 'TATAPOWER', 'ADANIGREEN', 'INOXWIND', 'NTPC', 'POWERGRID'],
  BANKING: ['HDFCBANK', 'ICICIBANK', 'SBIN', 'YESBANK', 'FEDERALBNK', 'BANDHANBNK'],
  IT: ['TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM', 'MINDTREE'],
  AUTO: ['TATAMOTORS', 'MARUTI', 'BAJAJ-AUTO', 'EICHERMOT', 'ASHOKLEY'],
  PHARMA: ['SUNPHARMA', 'DRREDDY', 'CIPLA', 'BIOCON', 'ALKEM'],
  FMCG: ['HINDUNILVR', 'ITC', 'DABUR', 'MARICO', 'BRITANNIA'],
  METALS: ['TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'SAIL', 'VEDL'],
  TELECOM: ['BHARTIARTL', 'IDEA', 'VODAFONE'],
  TECH: ['ZOMATO', 'PAYTM', 'NYKAA', 'POLICYBZR'],
};

/**
 * Get all stocks to scan based on risk preference
 * @param {string} riskLevel - ALL, HIGH, MEDIUM, LOW
 * @returns {array} Array of stock symbols
 */
export function getStocksToScan(riskLevel = 'ALL') {
  switch (riskLevel) {
    case 'HIGH':
      return SMALL_CAPS;
    case 'MEDIUM':
      return MID_CAPS;
    case 'LOW':
      return LARGE_CAPS;
    case 'ALL':
    default:
      return [...LARGE_CAPS, ...MID_CAPS, ...SMALL_CAPS.slice(0, 50)]; // Total ~200 stocks
  }
}

/**
 * Screen stocks based on technical criteria
 * @param {object} criteria - Screening criteria
 * @returns {array} Filtered stock list with scores
 */
export async function screenStocks(criteria = {}) {
  const {
    riskLevel = 'ALL',
    minRSI = 0,
    maxRSI = 100,
    volumeBreakout = false,
    momentum = null, // 'STRONG_UP', 'MODERATE_UP', etc.
    maxResults = 20,
  } = criteria;

  const stocksToScan = getStocksToScan(riskLevel);
  const results = [];

  logger.info(`Screening ${stocksToScan.length} stocks with criteria:`, criteria);

  // Scan stocks (with rate limiting)
  for (let i = 0; i < Math.min(stocksToScan.length, maxResults * 3); i++) {
    const symbol = stocksToScan[i];
    
    try {
      // Get market data (mock for now - in production, fetch real historical data)
      const currentPrice = await getCurrentPrice(symbol, 'NSE');
      
      // Mock historical data for technical analysis
      // In production, this would come from Alpha Vantage or database
      const mockPrices = generateMockPriceHistory(currentPrice.price, 100);
      const mockVolumes = generateMockVolumeHistory(100);

      const technicals = analyzeTechnicals({
        symbol,
        prices: mockPrices,
        volumes: mockVolumes,
      });

      if (!technicals) continue;

      // Apply filters
      if (technicals.indicators.rsi < minRSI || technicals.indicators.rsi > maxRSI) continue;
      if (volumeBreakout && (!technicals.indicators.volume || technicals.indicators.volume.status !== 'BREAKOUT')) continue;
      if (momentum && technicals.indicators.momentum.status !== momentum) continue;

      // Determine market cap (mock - in production, fetch from API)
      const marketCap = getMarketCap(symbol);
      const riskCategory = determineRiskCategory(technicals, marketCap);

      // Calculate opportunity score (0-100)
      const score = calculateOpportunityScore(technicals, currentPrice.changePercent);

      results.push({
        symbol,
        exchange: 'NSE',
        currentPrice: currentPrice.price,
        change: currentPrice.change,
        changePercent: currentPrice.changePercent,
        marketCap,
        riskCategory,
        technicals,
        score,
      });

      // Rate limiting (Alpha Vantage: 5 calls/min)
      if (i < stocksToScan.length - 1) {
        await sleep(2000); // 2 seconds delay
      }
    } catch (error) {
      logger.error(`Screening error for ${symbol}:`, error.message);
      continue;
    }
  }

  // Sort by opportunity score
  results.sort((a, b) => b.score - a.score);

  logger.info(`Screening complete: Found ${results.length} opportunities`);

  return results.slice(0, maxResults);
}

/**
 * Find top opportunities across all risk categories
 * @param {number} perCategory - Number of stocks per risk category
 * @returns {object} Categorized opportunities
 */
export async function findTopOpportunities(perCategory = 5) {
  logger.info('Finding top opportunities across all risk categories...');

  const opportunities = {
    highRisk: [],
    mediumRisk: [],
    lowRisk: [],
  };

  // Scan high-risk (small-caps with high volatility)
  const highRiskResults = await screenStocks({
    riskLevel: 'HIGH',
    volumeBreakout: false,
    maxResults: perCategory,
  });

  // Scan medium-risk (mid-caps with momentum)
  const mediumRiskResults = await screenStocks({
    riskLevel: 'MEDIUM',
    momentum: 'MODERATE_UP',
    maxResults: perCategory,
  });

  // Scan low-risk (large-caps with stability)
  const lowRiskResults = await screenStocks({
    riskLevel: 'LOW',
    minRSI: 40,
    maxRSI: 60,
    maxResults: perCategory,
  });

  opportunities.highRisk = highRiskResults.filter(r => r.riskCategory === 'HIGH').slice(0, perCategory);
  opportunities.mediumRisk = mediumRiskResults.filter(r => r.riskCategory === 'MEDIUM').slice(0, perCategory);
  opportunities.lowRisk = lowRiskResults.filter(r => r.riskCategory === 'LOW').slice(0, perCategory);

  // Fill gaps if categories don't have enough
  if (opportunities.highRisk.length < perCategory) {
    opportunities.highRisk.push(...highRiskResults.slice(0, perCategory - opportunities.highRisk.length));
  }

  return opportunities;
}

/**
 * Calculate opportunity score based on technical indicators
 * @param {object} technicals - Technical analysis results
 * @param {number} recentChange - Recent price change percentage
 * @returns {number} Score from 0-100
 */
function calculateOpportunityScore(technicals, recentChange) {
  let score = 50; // Base score

  const { indicators, signals, analysis } = technicals;

  // RSI scoring
  if (indicators.rsi < 30) score += 20; // Oversold - buy opportunity
  else if (indicators.rsi > 70) score -= 20; // Overbought - avoid

  // MACD scoring
  if (indicators.macd && indicators.macd.status === 'BULLISH') score += 15;

  // Volume scoring
  if (indicators.volume && indicators.volume.status === 'BREAKOUT') score += 20;
  else if (indicators.volume && indicators.volume.status === 'HIGH') score += 10;

  // Momentum scoring
  if (indicators.momentum) {
    if (indicators.momentum.status === 'STRONG_UP') score += 15;
    else if (indicators.momentum.status === 'MODERATE_UP') score += 10;
    else if (indicators.momentum.status === 'STRONG_DOWN') score -= 15;
  }

  // Trend scoring
  if (technicals.trend === 'STRONG_UPTREND') score += 10;
  else if (technicals.trend === 'UPTREND') score += 5;
  else if (technicals.trend === 'DOWNTREND') score -= 5;

  // Signal strength
  const buySignals = signals.filter(s => s.type === 'BUY' && s.strength === 'STRONG').length;
  score += buySignals * 5;

  // Recent performance
  if (recentChange > 5) score += 10;
  else if (recentChange < -5) score -= 10;

  // Cap score between 0-100
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Get estimated market cap (mock - replace with real data)
 * @param {string} symbol
 * @returns {number} Market cap in crores
 */
function getMarketCap(symbol) {
  if (LARGE_CAPS.includes(symbol)) return 50000 + Math.random() * 200000;
  if (MID_CAPS.includes(symbol)) return 5000 + Math.random() * 15000;
  return 500 + Math.random() * 4500;
}

/**
 * Generate mock price history for testing
 * TODO: Replace with real historical data from Alpha Vantage
 */
function generateMockPriceHistory(currentPrice, days) {
  const prices = [];
  let price = currentPrice * 0.9; // Start 10% lower

  for (let i = 0; i < days; i++) {
    const change = (Math.random() - 0.48) * price * 0.03; // Random walk with slight upward bias
    price += change;
    prices.push(Math.round(price * 100) / 100);
  }

  return prices;
}

/**
 * Generate mock volume history for testing
 */
function generateMockVolumeHistory(days) {
  const volumes = [];
  const baseVolume = 1000000 + Math.random() * 5000000;

  for (let i = 0; i < days; i++) {
    const volume = baseVolume * (0.5 + Math.random());
    volumes.push(Math.round(volume));
  }

  return volumes;
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  getStocksToScan,
  screenStocks,
  findTopOpportunities,
  LARGE_CAPS,
  MID_CAPS,
  SMALL_CAPS,
  SECTORS,
};
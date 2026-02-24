import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import logger from './logger.js';

const prisma = new PrismaClient();
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;
const BASE_URL = 'https://www.alphavantage.co/query';

// NSE symbols with .NS suffix for Alpha Vantage
const NSE_SUFFIX = '.NS';
const BSE_SUFFIX = '.BO';

/**
 * Fetch current price for a symbol
 */
export async function getCurrentPrice(symbol, exchange = 'NSE') {
  try {
    const suffix = exchange === 'NSE' ? NSE_SUFFIX : BSE_SUFFIX;
    const fullSymbol = `${symbol}${suffix}`;
    
    const response = await axios.get(BASE_URL, {
      params: {
        function: 'GLOBAL_QUOTE',
        symbol: fullSymbol,
        apikey: ALPHA_VANTAGE_KEY
      }
    });

    const quote = response.data['Global Quote'];
    
    if (!quote || !quote['05. price']) {
      throw new Error(`No data for ${symbol}`);
    }

    return {
      symbol,
      exchange,
      price: parseFloat(quote['05. price']),
      change: parseFloat(quote['09. change']),
      changePercent: parseFloat(quote['10. change percent'].replace('%', '')),
      volume: parseInt(quote['06. volume']),
      timestamp: new Date(quote['07. latest trading day'])
    };
  } catch (error) {
    logger.error(`Error fetching price for ${symbol}:`, error.message);
    
    // Fallback to NSE direct scraping if Alpha Vantage fails
    return await scrapeNSEPrice(symbol);
  }
}

/**
 * Fetch intraday data (5-min candles)
 */
export async function getIntradayData(symbol, exchange = 'NSE') {
  try {
    const suffix = exchange === 'NSE' ? NSE_SUFFIX : BSE_SUFFIX;
    const fullSymbol = `${symbol}${suffix}`;
    
    const response = await axios.get(BASE_URL, {
      params: {
        function: 'TIME_SERIES_INTRADAY',
        symbol: fullSymbol,
        interval: '5min',
        apikey: ALPHA_VANTAGE_KEY,
        outputsize: 'compact' // Last 100 data points
      }
    });

    const timeSeries = response.data['Time Series (5min)'];
    
    if (!timeSeries) {
      throw new Error(`No intraday data for ${symbol}`);
    }

    // Convert to array and save to DB
    const candles = Object.entries(timeSeries).map(([timestamp, data]) => ({
      symbol,
      exchange,
      open: parseFloat(data['1. open']),
      high: parseFloat(data['2. high']),
      low: parseFloat(data['3. low']),
      close: parseFloat(data['4. close']),
      volume: parseInt(data['5. volume']),
      timestamp: new Date(timestamp)
    }));

    // Save to database
    await prisma.marketData.createMany({
      data: candles,
      skipDuplicates: true
    });

    logger.info(`Saved ${candles.length} candles for ${symbol}`);
    return candles;
  } catch (error) {
    logger.error(`Error fetching intraday data for ${symbol}:`, error.message);
    return [];
  }
}

/**
 * Scrape price directly from NSE (fallback method)
 */
async function scrapeNSEPrice(symbol) {
  try {
    // NSE API endpoint (unofficial but widely used)
    const url = `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    });

    const data = response.data;
    const priceInfo = data.priceInfo;

    return {
      symbol,
      exchange: 'NSE',
      price: parseFloat(priceInfo.lastPrice),
      change: parseFloat(priceInfo.change),
      changePercent: parseFloat(priceInfo.pChange),
      volume: parseInt(data.preOpenMarket?.totalTradedVolume || 0),
      timestamp: new Date()
    };
  } catch (error) {
    logger.error(`NSE scraping failed for ${symbol}:`, error.message);
    throw error;
  }
}

/**
 * Update portfolio holdings with current prices
 */
export async function updatePortfolioPrices() {
  try {
    const holdings = await prisma.holding.findMany();
    
    for (const holding of holdings) {
      try {
        const priceData = await getCurrentPrice(holding.symbol, holding.exchange);
        
        await prisma.holding.update({
          where: { id: holding.id },
          data: { currentPrice: priceData.price }
        });
        
        logger.info(`Updated ${holding.symbol}: ₹${priceData.price}`);
        
        // Rate limiting for Alpha Vantage (5 calls/min on free tier)
        await sleep(12000); // 12 seconds between calls
      } catch (error) {
        logger.error(`Failed to update ${holding.symbol}:`, error.message);
      }
    }
  } catch (error) {
    logger.error('Portfolio update error:', error);
  }
}

/**
 * Get top gainers/losers from watchlist
 */
export async function getWatchlistSignals() {
  const watchlist = await prisma.watchlist.findMany();
  const signals = [];

  for (const stock of watchlist) {
    try {
      const priceData = await getCurrentPrice(stock.symbol, stock.exchange);
      
      // Check if target or stop loss hit
      if (stock.targetPrice && priceData.price >= stock.targetPrice) {
        signals.push({
          symbol: stock.symbol,
          type: 'TARGET_HIT',
          currentPrice: priceData.price,
          targetPrice: stock.targetPrice
        });
      }
      
      if (stock.stopLoss && priceData.price <= stock.stopLoss) {
        signals.push({
          symbol: stock.symbol,
          type: 'STOP_LOSS_HIT',
          currentPrice: priceData.price,
          stopLoss: stock.stopLoss
        });
      }

      await sleep(12000);
    } catch (error) {
      logger.error(`Watchlist check failed for ${stock.symbol}`);
    }
  }

  return signals;
}

/**
 * Search for stock symbols (helper for frontend)
 */
export async function searchSymbols(query) {
  try {
    const response = await axios.get(BASE_URL, {
      params: {
        function: 'SYMBOL_SEARCH',
        keywords: query,
        apikey: ALPHA_VANTAGE_KEY
      }
    });

    const matches = response.data.bestMatches || [];
    
    // Filter Indian stocks only
    return matches
      .filter(m => m['1. symbol'].endsWith('.NSE') || m['1. symbol'].endsWith('.BSE'))
      .map(m => ({
        symbol: m['1. symbol'].replace('.NSE', '').replace('.BSE', ''),
        name: m['2. name'],
        exchange: m['1. symbol'].endsWith('.NSE') ? 'NSE' : 'BSE'
      }));
  } catch (error) {
    logger.error('Symbol search error:', error);
    return [];
  }
}

// ============================================
// Market Context for AI Prompts
// ============================================

// Sector ETFs — give Claude real directional data across the market
// Fetched via API and cached; portfolio holding prices come from DB (no extra API calls)
const SECTOR_ETFS = [
  { symbol: 'NIFTYBEES',  label: 'Nifty 50' },
  { symbol: 'BANKBEES',   label: 'Nifty Bank' },
  { symbol: 'ITBEES',     label: 'Nifty IT' },
  { symbol: 'JUNIORBEES', label: 'Nifty Next 50' },
  { symbol: 'MIDCAPBEES', label: 'Nifty Midcap' },
];

const sectorEtfCache = { lines: null, timestamp: 0 };
const SECTOR_CACHE_TTL_MS = 25 * 60 * 1000; // 25 min — covers 9:30 AM + 1 PM generation

/**
 * Fetch real market data to inject into AI prompts.
 *
 * Sector ETFs are fetched via Alpha Vantage and cached for 25 min — they only
 * need refreshing twice a day (morning + midday signal generation). Portfolio
 * holdings use currentPrice already written to DB by the 5-min market scanner,
 * so zero extra API calls are needed for holdings.
 *
 * @param {Array} holdings - Portfolio holdings array (with currentPrice from DB)
 * @returns {Promise<string>} Formatted market context text
 */
export async function fetchMarketContext(holdings = []) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

  // ── Sector ETFs (API, cached 25 min) ──────────────────────────────────────
  let sectorLines;
  if (sectorEtfCache.lines && (Date.now() - sectorEtfCache.timestamp) < SECTOR_CACHE_TTL_MS) {
    sectorLines = sectorEtfCache.lines;
  } else {
    sectorLines = [];
    for (const etf of SECTOR_ETFS) {
      try {
        const data = await getCurrentPrice(etf.symbol, 'NSE');
        const sign = data.changePercent >= 0 ? '+' : '';
        sectorLines.push(`${etf.label} (${etf.symbol}): ₹${data.price.toFixed(2)} (${sign}${data.changePercent.toFixed(2)}%)`);
      } catch (e) {
        sectorLines.push(`${etf.label} (${etf.symbol}): unavailable`);
      }
      await sleep(12000); // Alpha Vantage free-tier rate limit
    }
    sectorEtfCache.lines = sectorLines;
    sectorEtfCache.timestamp = Date.now();
  }

  // ── Portfolio holdings (DB prices — zero extra API calls) ─────────────────
  const topHoldings = [...holdings]
    .sort((a, b) => (b.quantity * parseFloat(b.avgPrice)) - (a.quantity * parseFloat(a.avgPrice)))
    .slice(0, 5);

  const holdingLines = topHoldings.map(h => {
    const current = parseFloat(h.currentPrice || 0);
    const avg = parseFloat(h.avgPrice || 0);
    if (!current) return `${h.symbol}: price not in DB yet`;
    const pnlPct = avg > 0 ? ((current - avg) / avg * 100).toFixed(1) : '0.0';
    const pnlSign = parseFloat(pnlPct) >= 0 ? '+' : '';
    return `${h.symbol}: ₹${current.toFixed(2)} (avg ₹${avg.toFixed(2)}, P&L ${pnlSign}${pnlPct}%)`;
  });

  return [
    `=== REAL-TIME MARKET DATA (as of ${timeStr} IST) ===`,
    '',
    '--- Broad Market & Sectors ---',
    ...sectorLines,
    '',
    '--- Portfolio Holdings (live prices) ---',
    ...(holdingLines.length ? holdingLines : ['No holdings']),
    '=== END MARKET DATA ===',
  ].join('\n');
}

/**
 * @deprecated Use MARKET_DATA_INSTRUCTION from analystPrompts.js instead.
 * Kept for backward compatibility — re-exports the new instruction.
 */
export { MARKET_DATA_INSTRUCTION as MARKET_DATA_ANTI_HALLUCINATION_PROMPT } from './analystPrompts.js';

// Utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

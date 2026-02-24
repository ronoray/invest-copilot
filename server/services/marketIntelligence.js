/**
 * server/services/marketIntelligence.js
 *
 * Provides institutional-grade market context for signal generation.
 * Fetches previous session OHLCV data for sector ETFs and holdings
 * to give Claude real data about market regime, sector rotation,
 * and breakout levels — not just a single price snapshot.
 *
 * All data is cached per trading day so each symbol is fetched at
 * most once per day regardless of how many functions call it.
 */

import axios from 'axios';
import logger from './logger.js';

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;
const BASE_URL = 'https://www.alphavantage.co/query';

// Per-day cache keyed by 'SYMBOL-YYYY-MM-DD'
const dailyDataCache = new Map();

// Sector ETFs that proxy each major theme in Indian markets
export const SECTOR_PROXIES = [
  { symbol: 'NIFTYBEES',  label: 'Nifty 50 (broad market)' },
  { symbol: 'BANKBEES',   label: 'Nifty Bank'              },
  { symbol: 'ITBEES',     label: 'Nifty IT'                },
  { symbol: 'JUNIORBEES', label: 'Nifty Next 50'           },
  { symbol: 'GOLDBEES',   label: 'Gold (safe haven)'       },
];

// ─── Daily OHLCV fetch ────────────────────────────────────────────────────────

/**
 * Fetch previous day OHLCV for a symbol via Alpha Vantage TIME_SERIES_DAILY.
 * Cached per trading day — guaranteed single fetch regardless of call count.
 *
 * @returns {Object|null} { today: {date,open,high,low,close,volume}, yesterday: {...} }
 */
export async function fetchDailyData(symbol, exchange = 'NSE') {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const cacheKey = `${symbol}-${today}`;

  if (dailyDataCache.has(cacheKey)) return dailyDataCache.get(cacheKey);

  try {
    const suffix = exchange === 'NSE' ? '.NS' : '.BO';
    const response = await axios.get(BASE_URL, {
      params: {
        function: 'TIME_SERIES_DAILY',
        symbol: `${symbol}${suffix}`,
        outputsize: 'compact',
        apikey: ALPHA_VANTAGE_KEY,
      },
      timeout: 15000,
    });

    const ts = response.data['Time Series (Daily)'];
    if (!ts) return null;

    const dates = Object.keys(ts).sort().reverse();
    const parse = d => d ? {
      date:   d,
      open:   parseFloat(ts[d]['1. open']   || 0),
      high:   parseFloat(ts[d]['2. high']   || 0),
      low:    parseFloat(ts[d]['3. low']    || 0),
      close:  parseFloat(ts[d]['4. close']  || 0),
      volume: parseInt  (ts[d]['5. volume'] || 0),
    } : null;

    // Full ascending series (oldest → newest) for technical analysis
    const series = [...dates].reverse().map(parse).filter(Boolean);

    const data = { today: parse(dates[0]), yesterday: parse(dates[1]), series };
    dailyDataCache.set(cacheKey, data);
    return data;
  } catch (err) {
    logger.warn(`[MarketIntel] Daily data fetch failed for ${symbol}: ${err.message}`);
    return null;
  }
}

/**
 * Get previous day high/low for a holding — used by market scanner
 * for breakout-above-prev-high detection.
 */
export async function getPrevDayHighLow(symbol, exchange = 'NSE') {
  const data = await fetchDailyData(symbol, exchange);
  if (!data?.yesterday) return null;
  return { high: data.yesterday.high, low: data.yesterday.low, close: data.yesterday.close };
}

// ─── Pre-market sector context ────────────────────────────────────────────────

/**
 * Build a rich pre-market context string covering the previous session's
 * performance across all major sectors.
 *
 * Called once at 8:30 AM. Results are included in the morning Sonnet call
 * so Claude can set today's trading thesis BEFORE market opens.
 *
 * @returns {Promise<{contextText: string, sectorRanking: Array}>}
 */
export async function buildPreMarketContext() {
  const lines  = ['=== PREVIOUS SESSION — SECTOR PERFORMANCE ==='];
  const ranked = [];

  for (const proxy of SECTOR_PROXIES) {
    try {
      const data = await fetchDailyData(proxy.symbol);
      const prev = data?.yesterday;

      if (!prev || !prev.close) {
        lines.push(`${proxy.label}: Data unavailable`);
        continue;
      }

      const sessionChange = prev.open > 0
        ? ((prev.close - prev.open) / prev.open * 100)
        : 0;
      const sign = sessionChange >= 0 ? '+' : '';
      const dir  = sessionChange >= 0 ? '▲' : '▼';

      lines.push(
        `${proxy.label} (${proxy.symbol}): ` +
        `Prev close ₹${prev.close.toFixed(2)} | ` +
        `Session: ${dir}${Math.abs(sessionChange).toFixed(2)}% | ` +
        `Range: ₹${prev.low.toFixed(2)} – ₹${prev.high.toFixed(2)} | ` +
        `Vol: ${(prev.volume / 1e6).toFixed(2)}M`
      );

      ranked.push({ symbol: proxy.symbol, label: proxy.label, change: sessionChange });
      await sleep(12000);
    } catch (e) {
      lines.push(`${proxy.label}: Error`);
    }
  }

  // Identify market leaders and laggards
  ranked.sort((a, b) => b.change - a.change);
  const leaders  = ranked.filter(s => s.change >  0.5).map(s => s.label);
  const laggards = ranked.filter(s => s.change < -0.5).map(s => s.label);

  if (leaders.length)  lines.push(`\n🟢 Yesterday's leaders: ${leaders.join(', ')}`);
  if (laggards.length) lines.push(`🔴 Yesterday's laggards: ${laggards.join(', ')}`);

  // Gold signal: rising gold = risk-off, falling = risk-on
  const gold = ranked.find(s => s.symbol === 'GOLDBEES');
  if (gold) {
    if (gold.change >  0.5) lines.push('⚠️  Gold up → defensive posture, market may be risk-off today');
    if (gold.change < -0.5) lines.push('✅ Gold down → risk-on signal, equities may outperform');
  }

  lines.push('=== END PREV SESSION DATA ===');

  return { contextText: lines.join('\n'), sectorRanking: ranked };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

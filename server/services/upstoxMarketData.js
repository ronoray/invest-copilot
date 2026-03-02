/**
 * server/services/upstoxMarketData.js
 *
 * Upstox-native market data: real-time LTP (batch) + historical OHLCV candles.
 * Used as primary data source by marketData.js and marketIntelligence.js.
 * Falls back gracefully — throws on failure so callers use Alpha Vantage.
 *
 * Why Upstox instead of Alpha Vantage:
 *   - Real-time prices (vs 15-20 min delay on AV free tier)
 *   - All holdings in ONE call (vs sequential with 12s sleep)
 *   - No rate limit / 500-calls/day cap
 *   - User is already Upstox-connected — no extra cost
 */

import axios from 'axios';
import prisma from './prisma.js';
import { resolveInstrumentKey } from './upstoxService.js';
import logger from './logger.js';

const UPSTOX_BASE_URL = 'https://api.upstox.com/v2';

// Lazy singleton: userId of the first connected Upstox account.
// Safe for single-user system; resets on process restart.
let _connectedUserId = null;

async function getConnectedUserId() {
  if (_connectedUserId !== null) return _connectedUserId;
  const integration = await prisma.upstoxIntegration.findFirst({
    where: { isConnected: true },
    select: { userId: true },
  });
  if (!integration) throw new Error('No connected Upstox integration found');
  _connectedUserId = integration.userId;
  return _connectedUserId;
}

/**
 * Get a valid Upstox access token — throws if missing or expired.
 */
async function getToken() {
  const userId = await getConnectedUserId();
  const integration = await prisma.upstoxIntegration.findUnique({
    where: { userId },
    select: { accessToken: true, tokenExpiresAt: true, isConnected: true },
  });
  if (!integration?.isConnected || !integration?.accessToken) {
    throw new Error('Upstox not connected');
  }
  if (integration.tokenExpiresAt && new Date() > new Date(integration.tokenExpiresAt)) {
    throw new Error('Upstox token expired — re-authenticate via /auth');
  }
  return integration.accessToken;
}

/**
 * IST date string helper.
 * @param {number} daysAgo - 0 = today, 150 = 150 days ago
 * @returns {string} 'YYYY-MM-DD' in IST
 */
function getISTDateStr(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// ─── LTP ─────────────────────────────────────────────────────────────────────

/**
 * Fetch real-time last-traded price for multiple symbols in a SINGLE API call.
 *
 * @param {string[]} symbols - e.g. ['INFY', 'BHARTIARTL', 'NIFTYBEES']
 * @returns {Promise<Map<string, {price, change, changePercent, volume}>>}
 *   Map from symbol → price data. Missing symbols are omitted (not in map).
 */
export async function getUpstoxLTP(symbols) {
  if (!symbols || symbols.length === 0) return new Map();

  const token = await getToken();

  // Resolve all instrument keys (hits in-memory cache after first daily load)
  const keyMap = {};
  for (const symbol of symbols) {
    keyMap[symbol] = await resolveInstrumentKey(symbol, 'NSE_EQ');
  }

  // Build URL manually to preserve '|' in instrument keys (axios would encode them)
  const keys = Object.values(keyMap).join(',');
  const url = `${UPSTOX_BASE_URL}/market-quote/ltp?instrument_key=${keys}`;
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    timeout: 10000,
  });

  // Response: { data: { 'NSE_EQ:TRADINGSYMBOL': { instrument_token, last_price }, ... } }
  // Note: response key uses colon+trading-symbol, NOT pipe+ISIN.
  const quoteData = response.data?.data || {};
  const result = new Map();

  // Build reverse map: instrument_key → symbol (for response key resolution)
  const keyToSymbol = {};
  for (const [symbol, key] of Object.entries(keyMap)) {
    keyToSymbol[key] = symbol;
    // Also map colon-format key that Upstox returns in response
    keyToSymbol[`NSE_EQ:${symbol}`] = symbol;
  }

  for (const [responseKey, q] of Object.entries(quoteData)) {
    if (!q || !(q.last_price > 0)) continue;
    // responseKey is like "NSE_EQ:NIFTYBEES" or "NSE_EQ|INF204KB14I2"
    const symbol = keyToSymbol[responseKey]
      || keyToSymbol[q.instrument_token]
      || responseKey.split(':')[1]  // fallback: extract from "NSE_EQ:SYMBOL"
      || responseKey.split('|')[1]; // fallback: extract from "NSE_EQ|ISIN"
    if (symbol) {
      result.set(symbol, {
        price: q.last_price,
        change: 0,          // LTP endpoint doesn't return change
        changePercent: 0,   // Use full /market-quote/quotes if needed
        volume: 0,
      });
    }
  }

  logger.info(`[UpstoxMD] LTP batch: ${result.size}/${symbols.length} resolved`);
  return result;
}

// ─── Daily candles ────────────────────────────────────────────────────────────

/**
 * Fetch daily OHLCV candles for a symbol (authoritative Upstox historical data).
 *
 * Returns the SAME structure as fetchDailyData() in marketIntelligence.js:
 *   { today, yesterday, series: [{date, open, high, low, close, volume}, ...ascending] }
 *
 * This is a drop-in replacement — callers need no changes.
 *
 * @param {string} symbol
 * @param {number} days - Calendar days back to fetch (default 150 → ~100 trading days)
 * @returns {Promise<{today, yesterday, series}>}
 */
export async function getUpstoxDailyCandles(symbol, days = 150) {
  const token = await getToken();
  const instrumentKey = await resolveInstrumentKey(symbol, 'NSE_EQ');

  const toDate   = getISTDateStr(0);
  const fromDate = getISTDateStr(days);

  // Upstox candle URL: /historical-candle/{instrumentKey}/day/{to}/{from}
  // instrument_key contains '|' → must be URI-encoded
  const url = `${UPSTOX_BASE_URL}/historical-candle/${encodeURIComponent(instrumentKey)}/day/${toDate}/${fromDate}`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  const candles = response.data?.data?.candles || [];
  if (candles.length === 0) {
    throw new Error(`No candle data returned for ${symbol}`);
  }

  // Upstox format: [timestamp, open, high, low, close, volume, oi]
  // Sort ascending by timestamp (oldest → newest)
  const sorted = [...candles].sort((a, b) => a[0].localeCompare(b[0]));

  const series = sorted.map(c => ({
    date:   c[0].split('T')[0],  // "2026-02-25T00:00:00+05:30" → "2026-02-25"
    open:   c[1],
    high:   c[2],
    low:    c[3],
    close:  c[4],
    volume: c[5],
  }));

  const today     = series[series.length - 1] ?? null;
  const yesterday = series[series.length - 2] ?? null;

  logger.info(`[UpstoxMD] Candles for ${symbol}: ${series.length} bars (${fromDate} → ${toDate})`);
  return { today, yesterday, series };
}

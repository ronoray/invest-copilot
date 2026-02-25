/**
 * server/services/technicalAnalysis.js
 *
 * Technical indicator computation from daily OHLCV series.
 * Feeds real, data-grounded technical analysis into every Claude signal call
 * so recommendations are timed against actual market structure — not training-data guesses.
 *
 * Data source: Alpha Vantage TIME_SERIES_DAILY via marketIntelligence.fetchDailyData()
 * Cached per trading day — each symbol costs exactly 1 API call per day.
 * Universe is pre-fetched at 8:30 AM; 9:30 AM signal gen runs on cache hits (free).
 *
 * Legacy exports (calculateRSI etc.) retained for backward compatibility.
 */

import { fetchDailyData } from './marketIntelligence.js';
import logger from './logger.js';

// ── Core math ─────────────────────────────────────────────────────────────────

/**
 * Wilder's RSI — identical to TradingView default.
 * @param {number[]} closes  Ascending (oldest → newest), min length period + 1
 * @param {number}   period
 */
export function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const c = closes.slice(-Math.min(closes.length, period * 4));

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d))  / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }

  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
}

/**
 * Exponential Moving Average.
 * @param {number[]} closes  Ascending
 * @param {number}   period
 */
export function computeEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(2));
}

/**
 * Wilder's Average True Range — for stop sizing and volatility detection.
 * @param {Array<{high, low, close}>} series  Ascending
 * @param {number} period
 */
export function computeATR(series, period = 14) {
  if (series.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < series.length; i++) {
    trs.push(Math.max(
      series[i].high  - series[i].low,
      Math.abs(series[i].high - series[i - 1].close),
      Math.abs(series[i].low  - series[i - 1].close),
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return parseFloat(atr.toFixed(2));
}

/**
 * Volume ratio: yesterday's volume vs 20-day average.
 * @param {number[]} volumes  Ascending
 */
export function computeVolumeRatio(volumes) {
  if (volumes.length < 21) return null;
  const recent = volumes[volumes.length - 1];
  const avg    = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? parseFloat((recent / avg).toFixed(2)) : null;
}

/**
 * Classic floor trader's pivot points — computed from previous day's OHLC.
 * PP = central pivot, R1/R2 = resistance levels, S1/S2 = support levels.
 * These are the price levels institutional desks and market makers reference most.
 *
 * @param {{ high: number, low: number, close: number }} prevDay
 * @returns {{ pp, r1, r2, s1, s2 }}
 */
export function computePivotPoints({ high, low, close }) {
  const pp = (high + low + close) / 3;
  const r1 = (2 * pp) - low;
  const s1 = (2 * pp) - high;
  const r2 = pp + (high - low);
  const s2 = pp - (high - low);
  return {
    pp: parseFloat(pp.toFixed(2)),
    r1: parseFloat(r1.toFixed(2)),
    r2: parseFloat(r2.toFixed(2)),
    s1: parseFloat(s1.toFixed(2)),
    s2: parseFloat(s2.toFixed(2)),
  };
}

// ── Symbol technical profile ──────────────────────────────────────────────────

/**
 * Full technical profile for a symbol.
 * Costs exactly 1 Alpha Vantage TIME_SERIES_DAILY call per symbol per day (cached).
 *
 * @param {string} symbol
 * @param {string} exchange
 * @returns {Promise<object|null>}
 */
export async function getSymbolTechnicals(symbol, exchange = 'NSE') {
  try {
    const data = await fetchDailyData(symbol, exchange);
    if (!data?.series || data.series.length < 25) return null;

    const s      = data.series;  // ascending
    const latest = s[s.length - 1];
    const closes = s.map(d => d.close);
    const volumes = s.map(d => d.volume);

    const rsi    = computeRSI(closes);
    const ema20  = computeEMA(closes, 20);
    const ema50  = computeEMA(closes, 50);
    const atr    = computeATR(s.slice(-20), 14);
    const volRat = computeVolumeRatio(volumes);

    // 52-week range (up to 252 trading days)
    const year       = s.slice(-252);
    const high52w    = Math.max(...year.map(d => d.high));
    const pctFromHigh = parseFloat(((latest.close - high52w) / high52w * 100).toFixed(1));

    // EMA structure
    const aboveEMA20 = ema20 != null && latest.close > ema20;
    const aboveEMA50 = ema50 != null && latest.close > ema50;
    const emaUptrend = ema20 != null && ema50 != null && ema20 > ema50;

    const trend = (aboveEMA20 && aboveEMA50 && emaUptrend) ? 'STRONG UPTREND'
      : (aboveEMA50 && !aboveEMA20)                        ? 'PULLBACK IN UPTREND'
      : (!aboveEMA20 && !aboveEMA50 && !emaUptrend)        ? 'DOWNTREND'
      :                                                      'SIDEWAYS';

    const rsiLabel = rsi == null ? 'N/A'
      : rsi < 25 ? 'DEEPLY OVERSOLD'
      : rsi < 35 ? 'OVERSOLD'
      : rsi < 45 ? 'WEAKENING'
      : rsi < 55 ? 'NEUTRAL'
      : rsi < 65 ? 'STRENGTHENING'
      : rsi < 75 ? 'OVERBOUGHT'
      : 'EXTREMELY OVERBOUGHT';

    // Setup detection — grade quality
    let setup = null;
    if (trend === 'STRONG UPTREND' && rsi >= 48 && rsi <= 68 && volRat >= 1.2) {
      setup = 'MOMENTUM BUY — uptrend intact + volume confirmation. Enter on minor dips.';
    } else if (trend === 'PULLBACK IN UPTREND' && rsi >= 32 && rsi <= 52) {
      setup = 'PULLBACK BUY — dip to EMA20 in uptrend, RSI resetting. High R:R entry zone.';
    } else if (rsi != null && rsi < 33 && aboveEMA50) {
      setup = 'OVERSOLD BOUNCE — RSI deeply oversold, EMA50 support intact. Reversal watch.';
    } else if (trend === 'STRONG UPTREND' && rsi != null && rsi > 72 && volRat != null && volRat < 0.8) {
      setup = 'OVERBOUGHT + fading volume — trim, avoid fresh entry.';
    } else if (trend === 'DOWNTREND' && rsi != null && rsi > 60) {
      setup = 'DEAD CAT BOUNCE — sell into strength, do not buy.';
    }

    // Pivot points from previous trading day's OHLC (zero extra API calls — uses cached series)
    const prevBar = s.length > 1 ? s[s.length - 2] : null;
    const pivots  = prevBar ? computePivotPoints(prevBar) : null;

    // Flag if current price is within 0.8% of a key pivot level — inflection point alert
    let nearPivotNote = '';
    if (pivots) {
      const price = latest.close;
      const tol   = 0.008;
      const near  = [];
      if (Math.abs(price - pivots.pp) / pivots.pp <= tol) near.push(`PP ₹${pivots.pp.toFixed(0)}`);
      if (Math.abs(price - pivots.r1) / pivots.r1 <= tol) near.push(`R1 ₹${pivots.r1.toFixed(0)}`);
      if (Math.abs(price - pivots.r2) / pivots.r2 <= tol) near.push(`R2 ₹${pivots.r2.toFixed(0)}`);
      if (Math.abs(price - pivots.s1) / pivots.s1 <= tol) near.push(`S1 ₹${pivots.s1.toFixed(0)}`);
      if (Math.abs(price - pivots.s2) / pivots.s2 <= tol) near.push(`S2 ₹${pivots.s2.toFixed(0)}`);
      if (near.length > 0) nearPivotNote = `AT PIVOT: ${near.join(' + ')} — key inflection zone`;
    }

    // Prompt-ready summary
    const parts = [
      `${symbol}: ₹${latest.close.toFixed(0)}`,
      rsi    != null ? `RSI ${rsi} (${rsiLabel})`                                               : '',
      `| ${trend}`,
      ema20  != null ? `| EMA20 ₹${ema20.toFixed(0)} (${aboveEMA20  ? '✓' : '✗'})` : '',
      ema50  != null ? `| EMA50 ₹${ema50.toFixed(0)} (${aboveEMA50  ? '✓' : '✗'})` : '',
      volRat != null ? `| Vol ${volRat}x`                                                        : '',
      atr    != null ? `| ATR ₹${atr.toFixed(0)}`                                                : '',
      pctFromHigh    ? `| ${pctFromHigh}% from 52W high`                                         : '',
      pivots         ? `| Pivots PP ₹${pivots.pp.toFixed(0)} R1 ₹${pivots.r1.toFixed(0)} S1 ₹${pivots.s1.toFixed(0)}` : '',
      setup          ? `\n     ⚡ ${setup}`                                                       : '',
      nearPivotNote  ? `\n     🎯 ${nearPivotNote}`                                               : '',
    ];

    return {
      symbol, trend, rsi, ema20, ema50, atr, volRatio: volRat,
      pctFrom52wHigh: pctFromHigh, setup, rsiLabel,
      latestClose: latest.close, aboveEMA20, aboveEMA50,
      pivots,
      summary: parts.filter(Boolean).join(' '),
    };
  } catch (err) {
    logger.warn(`[Technicals] ${symbol}: ${err.message}`);
    return null;
  }
}

// ── Market regime ─────────────────────────────────────────────────────────────

// Cache the most recent successful regime — used as fallback when data fetch fails
let _lastKnownRegime = null;

/**
 * Detect current market regime using NIFTYBEES as Nifty proxy.
 * NIFTYBEES data is already cached from buildPreMarketContext() — zero extra API call.
 *
 * @returns {Promise<{regime, rationale, details, aggressionMultiplier}>}
 */
export async function getMarketRegime() {
  try {
    const data = await fetchDailyData('NIFTYBEES', 'NSE');
    if (!data?.series || data.series.length < 50) {
      if (_lastKnownRegime) {
        logger.info(`[MarketRegime] NIFTYBEES data unavailable — using cached regime: ${_lastKnownRegime.regime}`);
        return _lastKnownRegime;
      }
      return { regime: 'UNKNOWN', rationale: 'No data', details: '', aggressionMultiplier: 0.7 };
    }

    const s      = data.series;
    const closes = s.map(d => d.close);
    const latest = closes[closes.length - 1];
    const rsi    = computeRSI(closes);
    const ema20  = computeEMA(closes, 20);
    const ema50  = computeEMA(closes, 50);
    const atr    = computeATR(s.slice(-20), 14);
    const volPct = atr != null ? (atr / latest * 100) : 0;

    const aboveEMA20 = ema20 != null && latest > ema20;
    const aboveEMA50 = ema50 != null && latest > ema50;
    const emaAligned = ema20 != null && ema50 != null && ema20 > ema50;

    let regime, rationale, aggressionMultiplier;

    if (volPct > 1.8 && !aboveEMA20) {
      regime               = 'HIGH_VOL_BEAR';
      aggressionMultiplier = 0.4;
      rationale = `DANGER ZONE: Elevated volatility (ATR ${volPct.toFixed(1)}% of price) + Nifty below EMA20. Cut all position sizes to 40% of normal. Only execute high-conviction SELLs. No fresh longs until EMA20 is reclaimed.`;
    } else if (aboveEMA20 && aboveEMA50 && emaAligned && rsi != null && rsi > 52) {
      regime               = 'BULL';
      aggressionMultiplier = 1.0;
      rationale = `BULL MARKET: Nifty above EMA20 (₹${ema20?.toFixed(0)}) and EMA50 (₹${ema50?.toFixed(0)}), RSI ${rsi}. Trend is working. Full conviction on momentum + pullback setups. Size up when confidence ≥80%.`;
    } else if (!aboveEMA20 && rsi != null && rsi < 45) {
      regime               = 'BEAR';
      aggressionMultiplier = 0.5;
      rationale = `BEAR PHASE: Nifty below EMA20, RSI ${rsi}. Defensive only. Prioritise SELLs and profit-taking. Fresh longs only if R:R ≥ 4:1 at EMA50 support with volume confirmation.`;
    } else if (aboveEMA50 && !aboveEMA20 && rsi != null && rsi >= 38 && rsi <= 55) {
      regime               = 'PULLBACK';
      aggressionMultiplier = 0.75;
      rationale = `PULLBACK ZONE: Nifty above EMA50 (₹${ema50?.toFixed(0)}) but below EMA20 (₹${ema20?.toFixed(0)}), RSI ${rsi}. Prime entry zone for quality dips. Wait for EMA20 retest stabilisation, then enter with ATR-based stops.`;
    } else {
      regime               = 'NEUTRAL';
      aggressionMultiplier = 0.7;
      rationale = `MIXED SIGNALS: RSI ${rsi}, EMA alignment unclear. Minimum R:R 3:1. No marginal setups — only Grade A entries.`;
    }

    const result = {
      regime, rationale, aggressionMultiplier,
      details: `NIFTYBEES | RSI ${rsi} | EMA20 ₹${ema20?.toFixed(0)} (${aboveEMA20 ? '✓' : '✗'}) | EMA50 ₹${ema50?.toFixed(0)} (${aboveEMA50 ? '✓' : '✗'}) | ATR ₹${atr?.toFixed(0)} (${volPct.toFixed(1)}% vol)`,
    };
    _lastKnownRegime = result;
    return result;
  } catch (err) {
    logger.warn(`[MarketRegime] ${err.message}`);
    if (_lastKnownRegime) {
      logger.info(`[MarketRegime] Using cached regime: ${_lastKnownRegime.regime}`);
      return _lastKnownRegime;
    }
    return { regime: 'UNKNOWN', rationale: 'Data error', details: '', aggressionMultiplier: 0.7 };
  }
}

// ── Holdings bulk analysis ────────────────────────────────────────────────────

/**
 * Build full technical context for portfolio holdings.
 * Returns formatted block for signal generation prompt injection.
 *
 * Alpha Vantage budget: 1 TIME_SERIES_DAILY call per holding per day (cached).
 * Adds 13s sleep between calls to stay under 5/min rate limit.
 * Set withSleep=false when cache is already warm (e.g. post-8:30 AM pre-market scan).
 *
 * @param {Array}   holdings
 * @param {boolean} withSleep
 * @returns {Promise<string>}
 */
export async function buildHoldingsTechnicals(holdings, withSleep = true) {
  if (!holdings?.length) return '';

  const lines   = ['=== HOLDINGS — TECHNICAL STATE ==='];
  let   hasData = false;

  for (const h of holdings.slice(0, 6)) {
    const tech = await getSymbolTechnicals(h.symbol, h.exchange || 'NSE');
    if (tech) {
      lines.push(tech.summary);
      hasData = true;
    }
    if (withSleep) await sleep(13000);
  }

  if (!hasData) return '';
  lines.push('=== END HOLDINGS TECHNICALS ===');
  return lines.join('\n');
}

// ── Legacy exports (backward compatibility) ──────────────────────────────────

export function calculateRSI(prices, period = 14) { return computeRSI(prices, period); }
export function calculateEMA(prices, period)       { return computeEMA(prices, period); }
export function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}
export function analyzeVolume(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const avg     = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  const current = volumes[volumes.length - 1];
  const ratio   = current / avg;
  return {
    avgVolume: Math.round(avg), currentVolume: Math.round(current),
    ratio: Math.round(ratio * 100) / 100,
    status: ratio > 2 ? 'BREAKOUT' : ratio > 1.5 ? 'HIGH' : 'NORMAL',
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  computeRSI, computeEMA, computeATR, computeVolumeRatio, computePivotPoints,
  getSymbolTechnicals, getMarketRegime, buildHoldingsTechnicals,
  // legacy
  calculateRSI, calculateEMA, calculateSMA, analyzeVolume,
};

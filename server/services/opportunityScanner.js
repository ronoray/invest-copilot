/**
 * server/services/opportunityScanner.js
 *
 * Pre-computes technical indicators for a curated universe of NSE's most
 * tradeable large-cap stocks. Runs once at 8:30 AM and caches for the day.
 *
 * Why this exists:
 * Claude can recommend stocks from its training knowledge, but has no idea
 * what RSI, EMA position, or volume profile those stocks have TODAY.
 * This module provides that real data so every recommendation is technically
 * grounded, not a training-data guess.
 *
 * API budget: 1 TIME_SERIES_DAILY call per symbol per day.
 * 12 symbols × 13s sleep = ~2.6 minutes at 8:30 AM. All cached for the day.
 * 9:30 AM signal generation uses these cache hits — zero extra API calls.
 */

import { getSymbolTechnicals } from './technicalAnalysis.js';
import logger from './logger.js';

// ── Trading universe ──────────────────────────────────────────────────────────

/**
 * 12 liquid NSE large-caps covering all major sectors.
 * These are the stocks Claude is most likely to recommend for CNC delivery.
 * Selection criteria: Nifty 50 inclusion, high liquidity, CNC-tradeable, sector diversity.
 */
export const TRADING_UNIVERSE = [
  { symbol: 'HDFCBANK',   sector: 'Banking'  },
  { symbol: 'ICICIBANK',  sector: 'Banking'  },
  { symbol: 'SBIN',       sector: 'PSU Bank' },
  { symbol: 'TCS',        sector: 'IT'       },
  { symbol: 'INFY',       sector: 'IT'       },
  { symbol: 'RELIANCE',   sector: 'Energy'   },
  { symbol: 'NTPC',       sector: 'Power'    },
  { symbol: 'TATAMOTORS', sector: 'Auto'     },
  { symbol: 'TATASTEEL',  sector: 'Metals'   },
  { symbol: 'ITC',        sector: 'FMCG'     },
  { symbol: 'BAJFINANCE', sector: 'NBFC'     },
  { symbol: 'SUNPHARMA',  sector: 'Pharma'   },
];

// ── Per-day cache ─────────────────────────────────────────────────────────────

let lastScanDate   = null;
let cachedScanText = null;
let cachedResults  = null;

// ── Scanner ───────────────────────────────────────────────────────────────────

/**
 * Scan the trading universe and return a formatted technical context block.
 * Result is cached for the day — subsequent calls return instantly.
 *
 * @returns {Promise<string>} Formatted text block for prompt injection
 */
export async function scanTradingUniverse() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (lastScanDate === today && cachedScanText) {
    logger.info('[OpportunityScanner] Returning cached scan');
    return cachedScanText;
  }

  logger.info('[OpportunityScanner] Scanning trading universe...');
  const results = [];

  for (const stock of TRADING_UNIVERSE) {
    try {
      const tech = await getSymbolTechnicals(stock.symbol, 'NSE');
      if (tech) results.push({ ...stock, ...tech });
    } catch (e) {
      logger.warn(`[OpportunityScanner] ${stock.symbol}: ${e.message}`);
    }
    // No sleep needed — Upstox candles is primary data source (no rate limit)
  }

  logger.info(`[OpportunityScanner] ${results.length}/${TRADING_UNIVERSE.length} symbols analyzed`);

  const text = formatResults(results);
  cachedScanText = text;
  cachedResults  = results;
  lastScanDate   = today;
  return text;
}

/**
 * Return cached raw results (for regime-aware sector scoring).
 * Returns null if no scan has run today.
 */
export function getCachedResults() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return lastScanDate === today ? cachedResults : null;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatResults(results) {
  // Sort: setups first (by score), then monitoring
  const withSetup    = results.filter(r => r.setup && !r.setup.includes('AVOID') && !r.setup.includes('DEAD CAT'));
  const needsAction  = results.filter(r => r.setup && (r.setup.includes('OVERBOUGHT') || r.setup.includes('DEAD CAT')));
  const noSetup      = results.filter(r => !r.setup);

  const ranked = withSetup.sort((a, b) => scoreSetup(b) - scoreSetup(a));

  const lines = ['=== NSE OPPORTUNITY SCAN — TRADING UNIVERSE ==='];

  if (ranked.length > 0) {
    lines.push('ACTIVE SETUPS (ranked by quality — these are your candidates):');
    for (const r of ranked) {
      lines.push(r.summary);
    }
  } else {
    lines.push('No strong setups detected across universe — consolidation phase.');
  }

  if (needsAction.length > 0) {
    lines.push('');
    lines.push('CAUTION / AVOID:');
    for (const r of needsAction) {
      lines.push(r.summary);
    }
  }

  if (noSetup.length > 0) {
    lines.push('');
    lines.push('MONITORING (no clear setup today):');
    for (const r of noSetup.slice(0, 4)) {
      // Brief line — just price + trend for context
      lines.push(`${r.symbol}: ₹${r.latestClose?.toFixed(0)} | ${r.trend} | RSI ${r.rsi}`);
    }
  }

  lines.push('');
  lines.push('SETUP QUALITY GUIDE:');
  lines.push('  Grade A (85%+ conviction): STRONG UPTREND + RSI 50-65 + Vol >1.2x → size 25-30% of capital');
  lines.push('  Grade B (70-80%): PULLBACK IN UPTREND + RSI 35-50 resetting → size 15-20%');
  lines.push('  Grade C (60-70%): OVERSOLD BOUNCE at EMA50, volume confirming → size 10-15%');
  lines.push('  SKIP: DOWNTREND entries, overbought without catalyst, volume drying up');
  lines.push('  STOP SIZING: Place stop at entry − (1.5 × ATR). Target = entry + (3 × ATR) minimum.');
  lines.push('=== END OPPORTUNITY SCAN ===');

  return lines.join('\n');
}

function scoreSetup(tech) {
  let score = 0;
  if (tech.trend === 'STRONG UPTREND')       score += 40;
  else if (tech.trend === 'PULLBACK IN UPTREND') score += 30;

  if (tech.rsi >= 48 && tech.rsi <= 65)      score += 25;
  else if (tech.rsi >= 32 && tech.rsi < 48)  score += 15;

  if (tech.volRatio >= 1.5)                  score += 20;
  else if (tech.volRatio >= 1.2)             score += 10;

  // Sweet spot: not too extended from 52W high
  if (tech.pctFrom52wHigh >= -15 && tech.pctFrom52wHigh <= -2) score += 10;

  return score;
}


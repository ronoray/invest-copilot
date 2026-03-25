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
 * API budget: 1 TIME_SERIES_DAILY call per symbol per day (AV fallback only).
 * 50 symbols — Upstox candles is primary data source (no rate limit) — ~3 min at 8:30 AM.
 * 9:30 AM signal generation uses these cache hits — zero extra API calls.
 */

import { getSymbolTechnicals } from './technicalAnalysis.js';
import logger from './logger.js';

// ── Trading universe ──────────────────────────────────────────────────────────

/**
 * Full Nifty 50 universe — all 50 index constituents.
 * Selection criteria: Nifty 50 inclusion, high liquidity, CNC-tradeable, sector diversity.
 * 50 symbols — Upstox candles has no per-symbol rate limit, so full scan runs in ~3 min.
 */
export const TRADING_UNIVERSE = [
  // Banking
  { symbol: 'HDFCBANK',    sector: 'Banking'     },
  { symbol: 'ICICIBANK',   sector: 'Banking'     },
  { symbol: 'SBIN',        sector: 'PSU Bank'    },
  { symbol: 'AXISBANK',    sector: 'Banking'     },
  { symbol: 'KOTAKBANK',   sector: 'Banking'     },
  { symbol: 'INDUSINDBK',  sector: 'Banking'     },
  // Financial Services
  { symbol: 'BAJFINANCE',  sector: 'NBFC'        },
  { symbol: 'BAJAJFINSV',  sector: 'Fin Services'},
  { symbol: 'SHRIRAMFIN',  sector: 'NBFC'        },
  // Insurance
  { symbol: 'HDFCLIFE',    sector: 'Insurance'   },
  { symbol: 'SBILIFE',     sector: 'Insurance'   },
  // IT
  { symbol: 'TCS',         sector: 'IT'          },
  { symbol: 'INFY',        sector: 'IT'          },
  { symbol: 'HCLTECH',     sector: 'IT'          },
  { symbol: 'WIPRO',       sector: 'IT'          },
  { symbol: 'TECHM',       sector: 'IT'          },
  // Energy & Oil
  { symbol: 'RELIANCE',    sector: 'Energy'      },
  { symbol: 'ONGC',        sector: 'Oil & Gas'   },
  { symbol: 'BPCL',        sector: 'Oil & Gas'   },
  // Power
  { symbol: 'NTPC',        sector: 'Power'       },
  { symbol: 'POWERGRID',   sector: 'Power'       },
  // Auto
  { symbol: 'TATAMOTORS',  sector: 'Auto'        },
  { symbol: 'MARUTI',      sector: 'Auto'        },
  { symbol: 'M&M',         sector: 'Auto'        },
  { symbol: 'BAJAJ-AUTO',  sector: 'Auto'        },
  { symbol: 'HEROMOTOCO',  sector: 'Auto'        },
  { symbol: 'EICHERMOT',   sector: 'Auto'        },
  // Metals
  { symbol: 'TATASTEEL',   sector: 'Metals'      },
  { symbol: 'JSWSTEEL',    sector: 'Metals'      },
  { symbol: 'HINDALCO',    sector: 'Metals'      },
  { symbol: 'COALINDIA',   sector: 'Mining'      },
  // FMCG
  { symbol: 'ITC',         sector: 'FMCG'        },
  { symbol: 'HINDUNILVR',  sector: 'FMCG'        },
  { symbol: 'BRITANNIA',   sector: 'FMCG'        },
  { symbol: 'NESTLEIND',   sector: 'FMCG'        },
  // Pharma & Healthcare
  { symbol: 'SUNPHARMA',   sector: 'Pharma'      },
  { symbol: 'CIPLA',       sector: 'Pharma'      },
  { symbol: 'DRREDDY',     sector: 'Pharma'      },
  { symbol: 'DIVISLAB',    sector: 'Pharma'      },
  { symbol: 'APOLLOHOSP',  sector: 'Healthcare'  },
  // Infrastructure & Cement
  { symbol: 'LT',          sector: 'Infra'       },
  { symbol: 'ULTRACEMCO',  sector: 'Cement'      },
  { symbol: 'GRASIM',      sector: 'Diversified' },
  // Telecom
  { symbol: 'BHARTIARTL',  sector: 'Telecom'     },
  // Consumer & Retail
  { symbol: 'TITAN',       sector: 'Consumer'    },
  { symbol: 'TRENT',       sector: 'Retail'      },
  { symbol: 'ASIANPAINT',  sector: 'Paints'      },
  // Conglomerate
  { symbol: 'ADANIENT',    sector: 'Diversified' },
  { symbol: 'ADANIPORTS',  sector: 'Ports'       },
  // New-age
  { symbol: 'ZOMATO',      sector: 'Food Tech'   },
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


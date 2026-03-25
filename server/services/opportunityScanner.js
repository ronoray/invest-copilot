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
 * Expanded universe — Nifty 50 + Nifty Next 50 + key Nifty Midcap 100 picks.
 * ~120 liquid NSE stocks covering all sectors and market-cap bands.
 * Concurrent scan (batches of 10) completes in ~2 min at 8:30 AM.
 * Only the top-ranked setups are injected into Claude's context — full breadth, focused output.
 */
export const TRADING_UNIVERSE = [
  // ── NIFTY 50 ───────────────────────────────────────────────────────────────
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
  // IT — Nifty 50
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
  // Auto — Nifty 50
  { symbol: 'TATAMOTORS',  sector: 'Auto'        },
  { symbol: 'MARUTI',      sector: 'Auto'        },
  { symbol: 'M&M',         sector: 'Auto'        },
  { symbol: 'BAJAJ-AUTO',  sector: 'Auto'        },
  { symbol: 'HEROMOTOCO',  sector: 'Auto'        },
  { symbol: 'EICHERMOT',   sector: 'Auto'        },
  // Metals — Nifty 50
  { symbol: 'TATASTEEL',   sector: 'Metals'      },
  { symbol: 'JSWSTEEL',    sector: 'Metals'      },
  { symbol: 'HINDALCO',    sector: 'Metals'      },
  { symbol: 'COALINDIA',   sector: 'Mining'      },
  // FMCG — Nifty 50
  { symbol: 'ITC',         sector: 'FMCG'        },
  { symbol: 'HINDUNILVR',  sector: 'FMCG'        },
  { symbol: 'BRITANNIA',   sector: 'FMCG'        },
  { symbol: 'NESTLEIND',   sector: 'FMCG'        },
  // Pharma & Healthcare — Nifty 50
  { symbol: 'SUNPHARMA',   sector: 'Pharma'      },
  { symbol: 'CIPLA',       sector: 'Pharma'      },
  { symbol: 'DRREDDY',     sector: 'Pharma'      },
  { symbol: 'DIVISLAB',    sector: 'Pharma'      },
  { symbol: 'APOLLOHOSP',  sector: 'Healthcare'  },
  // Infrastructure & Cement — Nifty 50
  { symbol: 'LT',          sector: 'Infra'       },
  { symbol: 'ULTRACEMCO',  sector: 'Cement'      },
  { symbol: 'GRASIM',      sector: 'Diversified' },
  // Telecom
  { symbol: 'BHARTIARTL',  sector: 'Telecom'     },
  // Consumer & Retail — Nifty 50
  { symbol: 'TITAN',       sector: 'Consumer'    },
  { symbol: 'TRENT',       sector: 'Retail'      },
  { symbol: 'ASIANPAINT',  sector: 'Paints'      },
  // Conglomerate
  { symbol: 'ADANIENT',    sector: 'Diversified' },
  { symbol: 'ADANIPORTS',  sector: 'Ports'       },
  // New-age
  { symbol: 'ZOMATO',      sector: 'Food Tech'   },

  // ── NIFTY NEXT 50 ──────────────────────────────────────────────────────────
  // Banking / Finance
  { symbol: 'BANKBARODA',  sector: 'PSU Bank'    },
  { symbol: 'CANBK',       sector: 'PSU Bank'    },
  { symbol: 'FEDERALBNK',  sector: 'Banking'     },
  { symbol: 'SBICARD',     sector: 'Fin Services'},
  { symbol: 'CHOLAFIN',    sector: 'NBFC'        },
  { symbol: 'MUTHOOTFIN',  sector: 'NBFC'        },
  { symbol: 'LICHSGFIN',   sector: 'Housing Fin' },
  { symbol: 'PFC',         sector: 'Fin Services'},
  { symbol: 'RECLTD',      sector: 'Fin Services'},
  { symbol: 'ICICIPRULI',  sector: 'Insurance'   },
  // IT — Next 50
  { symbol: 'OFSS',        sector: 'IT'          },
  { symbol: 'MPHASIS',     sector: 'IT'          },
  { symbol: 'LTTS',        sector: 'IT'          },
  { symbol: 'COFORGE',     sector: 'IT'          },
  { symbol: 'PERSISTENT',  sector: 'IT'          },
  // Energy / Power — Next 50
  { symbol: 'GAIL',        sector: 'Gas'         },
  { symbol: 'PETRONET',    sector: 'Gas'         },
  { symbol: 'TATAPOWER',   sector: 'Power'       },
  { symbol: 'TORNTPOWER',  sector: 'Power'       },
  { symbol: 'ADANIGREEN',  sector: 'Renewables'  },
  // Auto & Ancillary — Next 50
  { symbol: 'TVSMOTOR',    sector: 'Auto'        },
  { symbol: 'BOSCHLTD',    sector: 'Auto Anc'   },
  // Metals & Chemicals — Next 50
  { symbol: 'VEDL',        sector: 'Metals'      },
  { symbol: 'SAIL',        sector: 'Steel'       },
  { symbol: 'PIDILITIND',  sector: 'Chemicals'   },
  { symbol: 'SRF',         sector: 'Chemicals'   },
  { symbol: 'UPL',         sector: 'Agrochem'    },
  // FMCG — Next 50
  { symbol: 'GODREJCP',    sector: 'FMCG'        },
  { symbol: 'DABUR',       sector: 'FMCG'        },
  { symbol: 'MARICO',      sector: 'FMCG'        },
  { symbol: 'COLPAL',      sector: 'FMCG'        },
  // Pharma — Next 50
  { symbol: 'TORNTPHARM',  sector: 'Pharma'      },
  { symbol: 'LUPIN',       sector: 'Pharma'      },
  { symbol: 'AUROPHARMA',  sector: 'Pharma'      },
  { symbol: 'ZYDUSLIFE',   sector: 'Pharma'      },
  // Infra & Cement — Next 50
  { symbol: 'HAVELLS',     sector: 'Electricals' },
  { symbol: 'SIEMENS',     sector: 'Capital Gds' },
  { symbol: 'AMBUJACEM',   sector: 'Cement'      },
  { symbol: 'ACC',         sector: 'Cement'      },
  // Real Estate
  { symbol: 'DLF',         sector: 'Real Estate' },
  { symbol: 'GODREJPROP',  sector: 'Real Estate' },
  // Consumer
  { symbol: 'BERGERPAINT', sector: 'Paints'      },
  { symbol: 'VOLTAS',      sector: 'Engineering' },
  { symbol: 'NAUKRI',      sector: 'Internet'    },
  { symbol: 'INDIGO',      sector: 'Aviation'    },
  { symbol: 'IRCTC',       sector: 'Travel'      },

  // ── KEY NIFTY MIDCAP ───────────────────────────────────────────────────────
  { symbol: 'DIXON',       sector: 'Electronics' },
  { symbol: 'POLYCAB',     sector: 'Electricals' },
  { symbol: 'JUBLFOOD',    sector: 'QSR'         },
  { symbol: 'PAGEIND',     sector: 'Consumer'    },
  { symbol: 'ASTRAL',      sector: 'Pipes'       },
  { symbol: 'TATACOMM',    sector: 'Telecom'     },
  { symbol: 'LALPATHLAB',  sector: 'Diagnostics' },
  { symbol: 'TATACHEM',    sector: 'Chemicals'   },
  { symbol: 'TATAELXSI',   sector: 'IT'          },
  { symbol: 'PVRINOX',     sector: 'Entertainment'},
  { symbol: 'PIIND',       sector: 'Chemicals'   },
  { symbol: 'CONCOR',      sector: 'Logistics'   },
  { symbol: 'IEX',         sector: 'Power Exch'  },
  { symbol: 'CAMS',        sector: 'Fin Services'},
  { symbol: 'AUBANK',      sector: 'Banking'     },
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

  logger.info(`[OpportunityScanner] Scanning ${TRADING_UNIVERSE.length} stocks in concurrent batches...`);
  const results = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < TRADING_UNIVERSE.length; i += BATCH_SIZE) {
    const batch = TRADING_UNIVERSE.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(stock => getSymbolTechnicals(stock.symbol, 'NSE').then(tech => ({ stock, tech })))
    );
    for (const res of settled) {
      if (res.status === 'fulfilled' && res.value.tech) {
        results.push({ ...res.value.stock, ...res.value.tech });
      } else if (res.status === 'rejected') {
        logger.warn(`[OpportunityScanner] batch error: ${res.reason?.message}`);
      }
    }
    logger.info(`[OpportunityScanner] Scanned ${Math.min(i + BATCH_SIZE, TRADING_UNIVERSE.length)}/${TRADING_UNIVERSE.length}`);
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

  const lines = [`=== NSE OPPORTUNITY SCAN — ${results.length} STOCKS ANALYZED ===`];

  if (ranked.length > 0) {
    const top = ranked.slice(0, 20); // Top 20 setups — keep prompt concise
    lines.push(`ACTIVE SETUPS — top ${top.length} of ${ranked.length} (ranked by quality):`);
    for (const r of top) {
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


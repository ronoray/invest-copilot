import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../services/prisma.js';
import { getBot } from '../services/telegramBot.js';
import { generateTradeSignals, expireOldSignals } from '../services/signalGenerator.js';
import { isTokenValid, getAuthorizationUrl, getHoldings, getOrderStatus } from '../services/upstoxService.js';
import { syncUpstoxFunds, syncUpstoxHoldings, getEffectiveCash } from '../services/capitalGuard.js';
import { buildPreMarketContext } from '../services/marketIntelligence.js';
import { ANALYST_IDENTITY } from '../services/analystPrompts.js';
import { buildPortfolioTrajectory } from '../services/advancedScreener.js';
import { getMarketRegime, buildHoldingsTechnicals } from '../services/technicalAnalysis.js';
import { isTradingDay } from '../utils/marketHolidays.js';
import { getSystemPauseState } from '../services/pauseState.js';
import { getAVBudget } from '../services/marketData.js';
import logger from '../services/logger.js';

// ─── Reliability infrastructure ───────────────────────────────────────────────

/**
 * Retry an async operation with exponential backoff.
 * Used for Telegram sends and critical system calls.
 */
async function withRetry(fn, label = 'operation', maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delayMs = attempt * 2500; // 2.5s, 5s
      logger.warn(`[Retry] ${label} failed (${attempt}/${maxAttempts}): ${err.message} — retry in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

/**
 * Send a Telegram message to every eligible active Telegram user (non-muted).
 * Used for system alerts, scan status, and recovery notices.
 */
async function alertEligibleUsers(msg, opts = {}) {
  const bot = getBot();
  if (!bot) return;
  try {
    const portfolios = await prisma.portfolio.findMany({
      where: { isActive: true, isPaused: false },
      include: { user: { include: { telegramUser: true } } }
    });
    const seen = new Set();
    for (const p of portfolios) {
      const tg = p.user?.telegramUser;
      if (!tg?.isActive || tg?.isMuted) continue;
      if (seen.has(tg.telegramId)) continue;
      seen.add(tg.telegramId);
      await bot.sendMessage(parseInt(tg.telegramId), msg, { parse_mode: 'Markdown', ...opts }).catch(() => {});
    }
  } catch (err) {
    logger.error('[alertEligibleUsers] Failed:', err.message);
  }
}

// ─── Scan heartbeat tracking ──────────────────────────────────────────────────
// Records when each scheduled scan ran and how many signals it generated.
// Checked by the watchdog cron every 15 minutes during market hours.
const scanHeartbeat = new Map(); // name → { at: Date, signals: number }

// Canonical scan schedule — single source of truth for heartbeat + recovery.
// Covers market hours AND the evening playbook (7:30 PM).
// recoveryDeadline (in total IST minutes) — after this time, the scan is too stale
// to recover. The watchdog silently marks it as done instead of re-running it.
// This prevents post-market deploys from blasting stale recovery messages.
const SCAN_SCHEDULE_DEF = [
  { name: 'pre-market',      hour: 8,  minute: 30, recoveryDeadline: 9  * 60 + 30 }, // don't recover after market open
  { name: '9:30-signals',    hour: 9,  minute: 30, recoveryDeadline: 13 * 60 +  0 }, // stale after midday scan fires
  { name: '11:00-pivot',     hour: 11, minute: 0,  recoveryDeadline: 14 * 60 + 30 }, // stale after pre-close pivot
  { name: '13:00-signals',   hour: 13, minute: 0,  recoveryDeadline: 15 * 60 + 30 }, // stale at market close
  { name: '14:30-pivot',     hour: 14, minute: 30, recoveryDeadline: 15 * 60 + 45 }, // stale after EOD review
  { name: 'evening-playbook',hour: 19, minute: 30, recoveryDeadline: 20 * 60 + 30 }, // still protected until 8:30 PM
];

function recordScanRun(name, signals = 0) {
  scanHeartbeat.set(name, { at: new Date(), signals });
  logger.info(`[Heartbeat] ${name} completed — ${signals} signal(s)`);
}

/** IST current time as { h, m, totalMin } */
function nowIST() {
  const ts = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata'
  });
  const [h, m] = ts.split(':').map(Number);
  return { h, m, totalMin: h * 60 + m };
}

/** Human-readable IST clock string */
function nowISTStr() {
  return new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
  });
}

/**
 * Startup scan recovery.
 * On every container start during market hours, check if any portfolio missed
 * today's signals (e.g. deploy happened after 9:30 AM). If yes, run immediately.
 */
async function runStartupRecovery() {
  if (!isTradingDay(new Date())) return;

  const { totalMin } = nowIST();
  const MARKET_OPEN    = 9  * 60 + 30;
  const MARKET_CLOSE   = 15 * 60 + 30;
  const EVENING_START  = 19 * 60 + 30; // 7:30 PM
  const EVENING_END    = 20 * 60 + 30; // 8:30 PM grace window

  const inMarketHours  = totalMin >= MARKET_OPEN  && totalMin <= MARKET_CLOSE;
  const inEveningHours = totalMin >= EVENING_START && totalMin <= EVENING_END;

  // Handle evening playbook recovery (deploy happened around 7:30 PM)
  if (inEveningHours && !scanHeartbeat.get('evening-playbook')) {
    logger.warn('[Startup Recovery] Evening Playbook not sent yet — running now');
    try {
      const { runEveningPlaybook } = await import('./telegramAlerts.js');
      await runEveningPlaybook();
      recordScanRun('evening-playbook');
    } catch (err) {
      logger.error('[Startup Recovery] Evening Playbook failed:', err.message);
    }
    return;
  }

  if (!inMarketHours) {
    logger.info('[Startup Recovery] Outside market/evening hours — no recovery needed');
    return;
  }

  const pauseState = await getSystemPauseState();
  if (pauseState) {
    logger.info('[Startup Recovery] System paused — skipping');
    return;
  }

  // Find active portfolios missing today's signals
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const portfolios = await prisma.portfolio.findMany({
    where: { isActive: true, isPaused: false }
  });

  const missing = [];
  for (const p of portfolios) {
    const count = await prisma.tradeSignal.count({
      where: { portfolioId: p.id, createdAt: { gte: today } }
    });
    if (count === 0) missing.push(p.id);
  }

  if (missing.length === 0) {
    logger.info('[Startup Recovery] All portfolios have today\'s signals — no action needed');
    // Populate heartbeat for every scan that should have run by now so the watchdog
    // doesn't re-fire them after this restart (heartbeat is in-memory; wiped on restart).
    for (const scan of SCAN_SCHEDULE_DEF) {
      const scanMin = scan.hour * 60 + scan.minute;
      if (scanMin <= totalMin && !scanHeartbeat.has(scan.name)) {
        scanHeartbeat.set(scan.name, { at: new Date(), signals: -1 });
        logger.info(`[Startup Recovery] Heartbeat seeded for ${scan.name} (already ran)`);
      }
    }
    return;
  }

  logger.warn(`[Startup Recovery] Portfolios ${missing.join(',')} missing signals — recovering at ${nowISTStr()}`);

  await alertEligibleUsers(
    `⚡ *Recovery Scan Running*\n\nServer restarted during market hours. Missed morning scan detected.\nRunning signal generation now at ${nowISTStr()} IST...\n\n_All intelligence layers active. Back to full operation._`
  );

  await generateSignalsForAllPortfolios();
  recordScanRun('startup-recovery');
}

/**
 * Watchdog: runs every 15 minutes during market hours.
 * Detects scans that were due but missed (cron failure, crash, etc.) and recovers them.
 * Also checks Alpha Vantage budget and warns before it's exhausted.
 */
async function checkScanHealthAndRecover() {
  if (!isTradingDay(new Date())) return;

  const { totalMin } = nowIST();
  // Cover 8 AM pre-market through 8:30 PM (catches evening playbook at 7:30 PM)
  if (totalMin < 8 * 60 || totalMin > 20 * 60 + 30) return;

  const pauseState = await getSystemPauseState();
  if (pauseState) return;

  // ── Alpha Vantage budget check ────────────────────────────────────────────
  const avBudget = getAVBudget();
  if (avBudget.remaining < 60 && !avBudget.warnSent) {
    logger.warn(`[AV Budget] Low: ${avBudget.count}/500 used, ${avBudget.remaining} remaining`);
    await alertEligibleUsers(
      `⚠️ *Market Data Budget Low*\n\n${avBudget.count}/500 Alpha Vantage calls used today.\n` +
      `${avBudget.remaining} remaining — later scans will use cached sector data.\n\n` +
      `_Technical signals and holdings data unaffected. Only live ETF prices may be delayed._`
    );
  }

  // ── Missed scan detection (25-min grace after each scheduled time) ────────
  const GRACE_MIN = 25;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  for (const scan of SCAN_SCHEDULE_DEF) {
    const scanMin = scan.hour * 60 + scan.minute;
    if (totalMin < scanMin + GRACE_MIN) continue; // Not overdue yet

    const beat = scanHeartbeat.get(scan.name);
    if (beat && beat.at >= today) continue; // Already ran today

    // Past recovery deadline — scan is too stale to run (e.g. post-market deploy).
    // Silently mark as done so we don't spam recovery messages for closed-market scans.
    if (scan.recoveryDeadline !== undefined && totalMin > scan.recoveryDeadline) {
      scanHeartbeat.set(scan.name, { at: new Date(), signals: 0 });
      logger.info(`[Watchdog] ${scan.name} past recovery deadline — marking stale, skipping`);
      continue;
    }

    // DB guard: verify signals really are missing before alerting.
    // Protects against heartbeat being wiped on restart after signals were already generated.
    {
      const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
      const activePortfolios = await prisma.portfolio.findMany({
        where: { isActive: true, isPaused: false },
        select: { id: true }
      });
      const signalCounts = await Promise.all(
        activePortfolios.map(p =>
          prisma.tradeSignal.count({ where: { portfolioId: p.id, createdAt: { gte: startOfToday } } })
        )
      );
      const hasSignalsToday = signalCounts.some(c => c > 0);
      if (hasSignalsToday) {
        scanHeartbeat.set(scan.name, { at: new Date(), signals: 0 });
        logger.info(`[Watchdog] ${scan.name} — signals exist in DB, heartbeat synced (post-restart)`);
        continue;
      }
    }

    // Missed scan confirmed
    logger.warn(`[Watchdog] MISSED SCAN: ${scan.name} (due ${scan.hour}:${String(scan.minute).padStart(2,'0')} IST)`);

    const dueStr = `${scan.hour}:${String(scan.minute).padStart(2, '0')}`;
    await alertEligibleUsers(
      `🔄 *Scan Recovery — ${dueStr} IST*\n\nThe ${scan.name} scan was overdue. Recovering now at ${nowISTStr()}...\n_This may happen after a system update or brief disruption._`
    );

    try {
      if (scan.name === 'evening-playbook') {
        const { runEveningPlaybook } = await import('./telegramAlerts.js');
        await runEveningPlaybook();
        recordScanRun(scan.name);
      } else if (scan.name.includes('pivot')) {
        const label = scan.name === '11:00-pivot' ? '11:00 AM' : '2:30 PM';
        await generateSignalsAtPivot(label);
        recordScanRun(scan.name);
      } else if (scan.name === 'pre-market') {
        await generatePreMarketIntelligence();
        recordScanRun(scan.name);
      } else {
        // '9:30-signals' or '13:00-signals'
        await generateSignalsForAllPortfolios();
        recordScanRun(scan.name);
      }
    } catch (err) {
      logger.error(`[Watchdog] Recovery failed for ${scan.name}:`, err.message);
    }

    break; // Only recover one scan per watchdog cycle — next cycle handles the rest
  }
}

// ─── Pre-market thesis ─────────────────────────────────────────────────────
// Generated at 8:30 AM, consumed at 9:30 AM signal generation.
// Module-level so it survives between cron ticks.
let todayPreMarketThesis = '';
let preMarketThesisDate  = null;

export function getTodayPreMarketThesis() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return preMarketThesisDate === today ? todayPreMarketThesis : '';
}

/**
 * Generate a pre-market trading thesis at 8:30 AM using Claude Sonnet.
 *
 * Fetches previous session's sector ETF data (OHLCV) and asks Claude to:
 *   - Read the sector rotation
 *   - Identify today's themes and focus sectors
 *   - Name 3–5 stocks to watch
 *   - Set the day's aggression level
 *
 * The output is:
 *   1. Stored in `todayPreMarketThesis` for inclusion in 9:30 AM signal gen
 *   2. Sent to Telegram as the morning brief
 */
async function generatePreMarketIntelligence() {
  if (!isTradingDay(new Date())) return;

  const pauseState = await getSystemPauseState();
  if (pauseState) return;

  const portfolios = await prisma.portfolio.findMany({
    where: { isActive: true, isPaused: false },
    include: { user: { include: { telegramUser: true } } }
  });
  const eligible = portfolios.filter(p =>
    p.user?.telegramUser?.isActive && !p.user?.telegramUser?.isMuted
  );
  if (eligible.length === 0) return;

  try {
    logger.info('[Pre-Market] Fetching sector context and warming holdings cache...');

    // 1. Sector ETF OHLCV — yesterday's performance across all sectors (60s with rate-limit sleeps)
    const { contextText, sectorRanking } = await buildPreMarketContext();

    // 2. Market regime — free, NIFTYBEES already cached from step 1
    const regime = await getMarketRegime();

    // 3. Holdings technicals — warm cache for each portfolio's held positions
    //    9:30 AM signal gen will use these as free cache hits (no sleep needed at signal time)
    for (const p of eligible) {
      if (p.holdings?.length) {
        await buildHoldingsTechnicals(p.holdings, true);
      }
    }

    // Pull in last night's watchlist if generated today
    const overnightWatchlist = getTomorrowWatchlist();

    // Detect market stress for early warning
    const isStressed = regime.regime === 'HIGH_VOL_BEAR' ||
      (regime.regime === 'BEAR' && (regime.aggressionMultiplier ?? 1) <= 0.5);

    // Leading/lagging sector summary from yesterday's ETF data
    const leadingStr  = sectorRanking.filter(s => s.change > 0.5).map(s => `${s.label} (+${s.change.toFixed(1)}%)`).join(', ');
    const laggingStr  = sectorRanking.filter(s => s.change < -0.5).map(s => `${s.label} (${s.change.toFixed(1)}%)`).join(', ');

    const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
    const dateStr = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata'
    });

    const prompt = `${ANALYST_IDENTITY}

${contextText}

=== MARKET REGIME ===
${regime.details}
${regime.rationale}
${isStressed ? '⚠️ MARKET STRESS DETECTED — defensive posture required' : ''}
=== END REGIME ===

${overnightWatchlist ? overnightWatchlist + '\n' : ''}
Today is ${dateStr}. Market opens in ~45 minutes.
CRITICAL CONTEXT: The Union Budget 2026 was already presented on 1 February 2026 and is fully in effect. Do NOT use "pre-budget" or "ahead of budget" narratives — the budget is history. Base your analysis on post-budget sector dynamics, Q3/Q4 FY26 earnings trends, and current macro reality (RBI stance, FII flows, crude, INR). Use the sector ETF data above as your primary signal for TODAY's actual positioning.

Yesterday's sector rotation summary:
- Leading: ${leadingStr || 'none significant'}
- Lagging: ${laggingStr || 'none significant'}

${isStressed ? `
STRESS MODE — DEFENSIVE MORNING BRIEF:
The market regime indicates significant stress. Your morning brief must:
1. Identify which holdings are most vulnerable and recommend pre-market decisions on them
2. Name the specific support levels that, if broken, trigger a full exit
3. Identify if there are any safe-haven or counter-cyclical plays (GOLDBEES, defensive FMCG, PHARMA)
4. Set expectations: this is capital preservation day, not growth day
` : `
FULL MARKET INTELLIGENCE BRIEF:
Based on yesterday's sector performance and the regime, set today's complete trading thesis.
You know the ENTIRE NSE market — every sector, every major stock, every thematic play.

Address:
1. Where is institutional money flowing today based on yesterday's sector leadership?
2. Which specific stocks (anywhere in NSE — not limited to any list) are primed for today?
3. What's the dominant theme? (PSU capex day? Banking NIM story? IT deal momentum? Auto sales? Power sector? Pharma FDA clearances?)
4. How aggressive should today be — and why specifically?
5. Any global macro context you know that's relevant today (FII patterns, crude oil impact, dollar strength)?
`}

Respond in JSON only:
{
  "marketMood": "bullish|bearish|mixed|rangebound",
  "keyTheme": "one crisp sentence — TODAY's dominant narrative",
  "focusSectors": ["BANKING", "POWER"],
  "avoidSectors": ["IT"],
  "watchlist": ["STOCK1", "STOCK2", "STOCK3", "STOCK4", "STOCK5"],
  "playbook": "2-3 specific, actionable sentences on how to trade today. Name actual stocks and entry logic, not generic advice.",
  "aggression": "high|medium|low",
  "topSetup": "The single best trade for today — name the stock, why today specifically, expected move",
  "riskWarning": "Key risk to watch — what would change the thesis and force a full position review"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const json = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());

    // Build thesis string — injected into 9:30 AM signal generation as context
    todayPreMarketThesis = [
      '=== PRE-MARKET INTELLIGENCE (8:30 AM) ===',
      `Regime: ${regime.regime} | Mood: ${json.marketMood.toUpperCase()} | Aggression: ${json.aggression.toUpperCase()}`,
      `Theme: ${json.keyTheme}`,
      `Focus sectors: ${json.focusSectors?.join(', ') || 'broad market'}`,
      json.avoidSectors?.length ? `Avoid sectors: ${json.avoidSectors.join(', ')}` : '',
      `Watchlist: ${json.watchlist?.join(', ') || ''}`,
      `Playbook: ${json.playbook}`,
      json.topSetup        ? `Best setup: ${json.topSetup}` : '',
      json.riskWarning     ? `Risk watch: ${json.riskWarning}` : '',
      overnightWatchlist   || '',
      '=== END PRE-MARKET INTELLIGENCE ===',
    ].filter(Boolean).join('\n');

    preMarketThesisDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    recordScanRun('pre-market');
    logger.info(`[Pre-Market] Thesis: ${json.marketMood} | ${json.keyTheme}`);

    // Send morning brief to Telegram
    const bot = getBot();
    if (bot) {
      const moodEmoji  = { bullish: '🟢', bearish: '🔴', mixed: '🟡', rangebound: '⚪' }[json.marketMood] || '🟡';
      const aggrEmoji  = { high: '⚡', medium: '📊', low: '🛡️' }[json.aggression] || '📊';
      const regimeEmoji = { BULL: '🚀', PULLBACK: '📈', BEAR: '🐻', HIGH_VOL_BEAR: '🚨', NEUTRAL: '➡️' }[regime.regime] || '➡️';
      const msg = [
        `${isStressed ? '🚨' : moodEmoji} *Pre-Market Brief — ${dateStr}*`,
        `${regimeEmoji} ${regime.regime}${isStressed ? ' — STRESS MODE' : ''}`,
        '',
        `*Theme:* ${json.keyTheme}`,
        '',
        `*Focus sectors:* ${json.focusSectors?.join(', ')}`,
        json.avoidSectors?.length ? `*Avoid:* ${json.avoidSectors.join(', ')}` : null,
        `*Watchlist:* ${json.watchlist?.join(', ')}`,
        '',
        json.topSetup    ? `*Best setup:* ${json.topSetup}` : null,
        json.riskWarning ? `*Risk watch:* ${json.riskWarning}` : null,
        '',
        `${aggrEmoji} _${json.playbook}_`,
        '',
        `_Full market signals at 9:30 AM →_`,
      ].filter(l => l !== null).join('\n');

      for (const p of eligible) {
        const tg = p.user?.telegramUser;
        if (tg) await bot.sendMessage(parseInt(tg.telegramId), msg, { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
  } catch (err) {
    logger.error('[Pre-Market] Failed:', err.message);
    todayPreMarketThesis = '';
  }
}

/**
 * End-of-day intelligence scan at 3:45 PM using Claude Sonnet.
 *
 * This is a full market scan — not a recap. The job is to:
 *   1. Review today's signal outcomes (accountability)
 *   2. Read today's sector performance to understand what moved and why
 *   3. Scan the entire NSE market for tomorrow's setups
 *   4. Produce a structured overnight watchlist with entry/target/stop
 *
 * Output is sent to Telegram and stored to seed tomorrow's 8:30 AM brief.
 */

// Stored overnight watchlist — injected into next morning's pre-market brief
let tomorrowWatchlist = '';
let tomorrowWatchlistDate = null;

export function getTomorrowWatchlist() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return tomorrowWatchlistDate === today ? tomorrowWatchlist : '';
}

async function eodReview() {
  if (!isTradingDay(new Date())) return;

  const pauseState = await getSystemPauseState();
  if (pauseState) return;

  const portfolios = await prisma.portfolio.findMany({
    where: { isActive: true, isPaused: false },
    include: {
      holdings: true,
      user: { include: { telegramUser: true } }
    }
  });

  const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  const bot = getBot();

  // Fetch today's sector performance once (from live ETF cache — scanner
  // ran at 3:35 PM so prices are fresh, no extra API calls needed)
  let sectorContext = '';
  try {
    const { fetchMarketContext } = await import('../services/marketData.js');
    // Pass empty holdings so we only get sector ETF section
    sectorContext = await fetchMarketContext([]);
  } catch (e) {
    logger.warn('[EOD Review] Could not fetch sector context:', e.message);
  }

  for (const portfolio of portfolios) {
    const telegramUser = portfolio.user?.telegramUser;
    if (!telegramUser?.isActive || telegramUser?.isMuted) continue;

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const signals = await prisma.tradeSignal.findMany({
        where: { portfolioId: portfolio.id, createdAt: { gte: today } },
        orderBy: { createdAt: 'asc' }
      });

      // Build today's signal outcomes with P&L
      const holdingPrices = {};
      for (const h of portfolio.holdings) {
        holdingPrices[h.symbol] = parseFloat(h.currentPrice || h.avgPrice || 0);
      }

      const signalLines = signals.length > 0 ? signals.map(s => {
        const entry = s.triggerPrice || s.triggerLow || 0;
        const current = holdingPrices[s.symbol] || 0;
        let outcome = '';
        if (current && entry > 0) {
          const pct = s.side === 'BUY'
            ? ((current - entry) / entry * 100).toFixed(1)
            : ((entry - current) / entry * 100).toFixed(1);
          const pl = s.side === 'BUY'
            ? ((current - entry) * s.quantity).toFixed(0)
            : ((entry - current) * s.quantity).toFixed(0);
          outcome = ` → ₹${current.toFixed(0)} (${parseFloat(pct) >= 0 ? '+' : ''}${pct}%, P&L ${parseFloat(pl) >= 0 ? '+' : ''}₹${pl})`;
        }
        return `${s.side} ${s.symbol} @ ₹${entry.toFixed(0)} [${s.status}]${outcome} | conf:${s.confidence}%`;
      }).join('\n') : 'No signals generated today.';

      // Portfolio holdings summary with full technical state
      const holdingsTechEOD = await buildHoldingsTechnicals(portfolio.holdings, false);
      const holdingsSummary = portfolio.holdings.map(h => {
        const curr    = parseFloat(h.currentPrice || 0);
        const avg     = parseFloat(h.avgPrice || 0);
        const pnl     = avg > 0 ? ((curr - avg) / avg * 100).toFixed(1) : '0.0';
        const pnlAmt  = ((curr - avg) * h.quantity).toFixed(0);
        return `${h.symbol}: ₹${curr.toFixed(0)} (avg ₹${avg.toFixed(0)}, ${parseFloat(pnl) >= 0 ? '+' : ''}${pnl}%, P&L ${parseFloat(pnlAmt) >= 0 ? '+' : ''}₹${pnlAmt})`;
      }).join('\n') || 'No holdings.';

      // Total portfolio P&L
      const totalInvested = portfolio.holdings.reduce((s, h) => s + h.quantity * parseFloat(h.avgPrice), 0);
      const totalCurrent  = portfolio.holdings.reduce((s, h) => s + h.quantity * parseFloat(h.currentPrice || h.avgPrice), 0);
      const totalPnl      = totalCurrent - totalInvested;
      const totalPnlPct   = totalInvested > 0 ? (totalPnl / totalInvested * 100).toFixed(1) : '0.0';

      const availableCash = parseFloat(portfolio.availableCash || portfolio.startingCapital || 0);

      const trajectoryEOD = buildPortfolioTrajectory(portfolio);

      const prompt = `${ANALYST_IDENTITY}

${sectorContext}

${trajectoryEOD}

=== TODAY'S SIGNALS & OUTCOMES ===
${signalLines}

=== PORTFOLIO STATE (CLOSE OF DAY) ===
${holdingsSummary}
Today's P&L on holdings: ${parseFloat(totalPnlPct) >= 0 ? '+' : ''}${totalPnlPct}% (${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toFixed(0)})
${holdingsTechEOD ? '\n' + holdingsTechEOD : ''}

Available capital for tomorrow: ₹${availableCash.toLocaleString('en-IN')}

Market closed. Your job now is two things:

1. ACCOUNTABILITY: What happened today? Were the signals right? Where did you leave money on the table? Be specific — name the stocks, the moves, the missed entries.

2. TOMORROW'S SETUP: Scan the ENTIRE NSE market — Nifty 50, Next 50, Midcap 150, Smallcap 250, all sectors. Based on today's sector performance above, identify the best setups for tomorrow's open. Look for:
   - Stocks setting up for breakouts (consolidating near highs, building volume)
   - Sector rotation plays (money rotating into or out of sectors)
   - Momentum continuations (stocks that led today and will gap-run tomorrow)
   - Reversal setups in beaten-down quality names
   - Event catalysts (results, board meetings, order wins, policy announcements)

For each setup give: entry level, target, stop, and WHY this is a tomorrow trade specifically.

Respond in JSON:
{
  "todayAssessment": "2 sentences on today — what worked, what you'd do differently",
  "sectorRead": "which sectors showed strength/weakness today and what that means for tomorrow",
  "tomorrowSetups": [
    {
      "symbol": "SYMBOL",
      "action": "BUY|SELL|WATCH",
      "entry": 0.00,
      "target": 0.00,
      "stop": 0.00,
      "thesis": "why tomorrow specifically — catalyst, setup, sector tailwind"
    }
  ],
  "tomorrowFocus": "which 2 sectors to concentrate on tomorrow and why",
  "riskWarning": "anything to be cautious about — global cues, events, sector risks"
}

Minimum 5 setups in tomorrowSetups. Maximum 10. Cast the net wide — this is the full market scan.`;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].text.trim();
      const json = JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());

      // Store overnight watchlist for injection into 8:30 AM pre-market brief
      const watchlistLines = (json.tomorrowSetups || []).map(s =>
        `${s.action} ${s.symbol}: entry ₹${s.entry}, target ₹${s.target}, stop ₹${s.stop} — ${s.thesis}`
      ).join('\n');

      tomorrowWatchlist = [
        '=== OVERNIGHT WATCHLIST (from EOD scan) ===',
        `Sector focus: ${json.tomorrowFocus}`,
        watchlistLines,
        json.riskWarning ? `Risk: ${json.riskWarning}` : '',
        '=== END OVERNIGHT WATCHLIST ===',
      ].filter(Boolean).join('\n');

      tomorrowWatchlistDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

      // Send to Telegram — split into two messages to stay under 4096 char limit
      if (bot) {
        const chatId = parseInt(telegramUser.telegramId);
        const executed = signals.filter(s => s.status === 'EXECUTED').length;
        const missed   = signals.filter(s => ['EXPIRED', 'DISMISSED'].includes(s.status)).length;

        // Message 1: today's assessment
        const msg1 = [
          `📊 *EOD — ${signals.length} signals today (${executed} executed, ${missed} missed)*`,
          '',
          json.todayAssessment,
          '',
          `*Sector read:* ${json.sectorRead}`,
          json.riskWarning ? `\n⚠️ *Tomorrow risk:* ${json.riskWarning}` : '',
        ].filter(Boolean).join('\n');

        await bot.sendMessage(chatId, msg1, { parse_mode: 'Markdown' }).catch(() => {});
        await new Promise(r => setTimeout(r, 500));

        // Message 2: tomorrow's setups
        const setupLines = (json.tomorrowSetups || []).map((s, i) => {
          const rr = s.stop && s.entry && s.target
            ? ((s.target - s.entry) / (s.entry - s.stop)).toFixed(1)
            : '?';
          return `${i + 1}. *${s.action} ${s.symbol}* — ₹${s.entry} → ₹${s.target} (stop ₹${s.stop}, R:R ${rr}:1)\n   _${s.thesis}_`;
        }).join('\n\n');

        const msg2 = [
          `🎯 *Tomorrow's Watchlist — ${json.tomorrowFocus}*`,
          '',
          setupLines,
        ].join('\n');

        await bot.sendMessage(chatId, msg2, { parse_mode: 'Markdown' }).catch(() => {});
      }

      logger.info(`[EOD Review] Portfolio ${portfolio.id}: ${json.tomorrowSetups?.length || 0} setups identified for tomorrow`);
    } catch (err) {
      logger.error(`[EOD Review] Portfolio ${portfolio.id}:`, err.message);
    }
  }
}

/**
 * Check if Upstox token is expired and send a reminder to re-authenticate.
 * Runs once in the morning before signal generation.
 */
async function remindUpstoxAuth() {
  try {
    const bot = getBot();
    if (!bot) return;

    // Find users with Upstox integration
    const integrations = await prisma.upstoxIntegration.findMany({
      where: { isConnected: true },
      include: { user: { include: { telegramUser: true } } }
    });

    for (const integration of integrations) {
      const telegramUser = integration.user?.telegramUser;
      if (!telegramUser || !telegramUser.isActive || telegramUser.isMuted) continue;

      const valid = await isTokenValid(integration.userId);
      if (valid) continue;

      try {
        const authUrl = await getAuthorizationUrl(integration.userId);
        const chatId = parseInt(telegramUser.telegramId);
        await bot.sendMessage(chatId,
          `🔐 *Upstox Token Expired*\n\nYour daily token has expired. Please re-authenticate to enable Execute buttons on trade signals:\n\n[Login to Upstox](${authUrl})\n\nOr use /auth anytime.`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
        logger.info(`Sent Upstox re-auth reminder to ${telegramUser.telegramId}`);
      } catch (err) {
        logger.error(`Failed to send Upstox auth reminder:`, err.message);
      }
    }
  } catch (error) {
    logger.error('Upstox auth reminder error:', error);
  }
}

/**
 * Sync Upstox funds for all connected integrations with valid tokens.
 * Updates portfolio.availableCash from Upstox available_margin.
 */
async function syncAllUpstoxFunds() {
  if (!isTradingDay(new Date())) return;

  try {
    const integrations = await prisma.upstoxIntegration.findMany({
      where: { isConnected: true }
    });

    let synced = 0;
    for (const integration of integrations) {
      const valid = await isTokenValid(integration.userId);
      if (!valid) continue;

      try {
        const result = await syncUpstoxFunds(integration.userId);
        synced += result.synced;
      } catch (err) {
        logger.error(`Fund sync failed for user ${integration.userId}:`, err.message);
      }
    }

    if (synced > 0) {
      logger.info(`[Fund Sync] Synced ${synced} Upstox portfolio(s)`);
    }
  } catch (error) {
    logger.error('Fund sync cron error:', error);
  }
}

/**
 * Sync Upstox holdings for all connected users, then expire any
 * pending SELL signals whose stocks are no longer held.
 */
async function syncAllUpstoxHoldingsAndExpireStaleSignals() {
  if (!isTradingDay(new Date())) return;

  try {
    const integrations = await prisma.upstoxIntegration.findMany({
      where: { isConnected: true }
    });

    for (const integration of integrations) {
      const valid = await isTokenValid(integration.userId);
      if (!valid) continue;

      try {
        await syncUpstoxHoldings(integration.userId);
      } catch (err) {
        logger.error(`Holdings sync failed for user ${integration.userId}:`, err.message);
      }
    }

    // Expire SELL signals for stocks no longer held (across all portfolios)
    const pendingSells = await prisma.tradeSignal.findMany({
      where: {
        side: 'SELL',
        status: { in: ['PENDING', 'SNOOZED', 'ACKED'] }
      },
      select: { id: true, symbol: true, portfolioId: true }
    });

    let expired = 0;
    for (const sig of pendingSells) {
      const holding = await prisma.holding.findFirst({
        where: { portfolioId: sig.portfolioId, symbol: sig.symbol }
      });
      if (!holding || holding.quantity <= 0) {
        await prisma.tradeSignal.update({
          where: { id: sig.id },
          data: { status: 'EXPIRED' }
        });
        expired++;
        logger.info(`Auto-expired stale SELL signal #${sig.id}: ${sig.symbol} no longer held (portfolio ${sig.portfolioId})`);
      }
    }

    if (expired > 0) {
      logger.info(`[Signal Cleanup] Expired ${expired} stale SELL signals after holdings sync`);
    }
  } catch (error) {
    logger.error('syncAllUpstoxHoldingsAndExpireStaleSignals error:', error);
  }
}

/**
 * Auto-generate trade signals for all active portfolios.
 * Runs at 9:30 AM and 1:00 PM IST during market hours.
 */
async function generateSignalsForAllPortfolios() {
  if (!isTradingDay(new Date())) return;

  const pauseState = await getSystemPauseState();
  if (pauseState) {
    logger.info(`[Signal Generator] Paused (${pauseState.reason}) — skipping generation`);
    return;
  }

  try {
    // Sync Upstox funds and holdings before generating signals (freshest data)
    await syncAllUpstoxFunds();
    await syncAllUpstoxHoldingsAndExpireStaleSignals();

    // Get all active, non-paused portfolios that have holdings
    const portfolios = await prisma.portfolio.findMany({
      where: { isActive: true, isPaused: false },
      include: {
        holdings: true,
        user: { include: { telegramUser: true } }
      }
    });

    // Only generate for portfolios with linked Telegram users
    const eligiblePortfolios = portfolios.filter(p =>
      p.user?.telegramUser?.isActive && !p.user?.telegramUser?.isMuted
    );

    if (eligiblePortfolios.length === 0) {
      logger.info('No eligible portfolios for signal generation');
      return;
    }

    // Check AV budget before firing Claude + market data (expensive operation)
    const avBudget = getAVBudget();
    if (avBudget.remaining < 20) {
      logger.warn(`[Signal Gen] AV budget critically low (${avBudget.remaining} calls remaining) — sector ETF data will use cache`);
    }

    let totalSignals = 0;
    let portfoliosScanned = 0; // tracks portfolios that actually ran through signal gen
    for (const portfolio of eligiblePortfolios) {
      try {
        // Gate: non-Upstox portfolios must have recently verified capital
        if (portfolio.broker !== 'UPSTOX') {
          const lastVerified = portfolio.lastVerifiedAt;
          const now = new Date();
          const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
          const isStale = !lastVerified || (now.getTime() - new Date(lastVerified).getTime() > twoDaysMs);

          if (isStale) {
            const telegramUser = portfolio.user?.telegramUser;
            if (telegramUser) {
              // Check if we already sent a reminder today for this portfolio
              const todayStart = new Date();
              todayStart.setHours(0, 0, 0, 0);
              const alreadySent = await prisma.alertHistory.count({
                where: {
                  telegramUserId: telegramUser.id,
                  alertType: 'CAPITAL_STALE',
                  symbol: `portfolio_${portfolio.id}`,
                  createdAt: { gte: todayStart }
                }
              });

              if (alreadySent === 0) {
                const bot = getBot();
                if (bot) {
                  const daysOld = lastVerified
                    ? Math.floor((now.getTime() - new Date(lastVerified).getTime()) / (24 * 60 * 60 * 1000))
                    : null;
                  const daysText = daysOld !== null ? `${daysOld} days old` : 'never verified';
                  const portfolioName = portfolio.ownerName || portfolio.name;
                  const brokerName = (portfolio.broker || 'Unknown').replace(/_/g, ' ');

                  await bot.sendMessage(parseInt(telegramUser.telegramId),
                    `📸 *Capital Data Stale*\n\nYour *${portfolioName}* (${brokerName}) capital data is ${daysText}.\n\nSignal generation is paused for this portfolio. Please upload a holdings screenshot at [invest.hungrytimes.in/plan](https://invest.hungrytimes.in/plan) or update capital manually to resume accurate signals.`,
                    { parse_mode: 'Markdown', disable_web_page_preview: true }
                  );

                  // Record that we sent this reminder
                  await prisma.alertHistory.create({
                    data: {
                      telegramUserId: telegramUser.id,
                      alertType: 'CAPITAL_STALE',
                      symbol: `portfolio_${portfolio.id}`,
                      price: 0,
                      message: `Capital stale reminder for ${portfolioName}`,
                      sent: true
                    }
                  });

                  logger.info(`Sent capital stale reminder for portfolio ${portfolio.id} (${portfolioName})`);
                }
              }
            }

            logger.info(`Skipping signal generation for portfolio ${portfolio.id}: capital data stale (lastVerifiedAt: ${lastVerified || 'null'})`);
            continue;
          }
        }

        // Check if we already generated signals for this portfolio today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const existingToday = await prisma.tradeSignal.count({
          where: {
            portfolioId: portfolio.id,
            createdAt: { gte: today },
            status: { notIn: ['EXPIRED'] }
          }
        });

        // Skip if already have 3+ active signals today for this portfolio
        if (existingToday >= 6) {
          logger.info(`Portfolio ${portfolio.id} already has ${existingToday} signals today, skipping`);
          continue;
        }

        // Fix 2: Verify previous EXECUTED signals against actual Upstox holdings
        let extraContext = '';
        if (portfolio.broker === 'UPSTOX') {
          try {
            const threeDaysAgo = new Date();
            threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

            const executedSignals = await prisma.tradeSignal.findMany({
              where: {
                portfolioId: portfolio.id,
                status: 'EXECUTED',
                side: 'BUY',
                createdAt: { gte: threeDaysAgo }
              }
            });

            if (executedSignals.length > 0) {
              try {
                const upstoxHoldings = await getHoldings(portfolio.user.id);
                const upstoxSymbols = new Set(
                  (upstoxHoldings || []).map(h => (h.tradingsymbol || h.trading_symbol || '').toUpperCase())
                );

                const unfilled = executedSignals.filter(s => !upstoxSymbols.has(s.symbol.toUpperCase()));

                if (unfilled.length > 0) {
                  const unfilledNames = unfilled.map(s => s.symbol).join(', ');
                  extraContext = `\n⚠️ UNFILLED SIGNALS: Previous BUY signals for ${unfilledNames} were marked EXECUTED but are NOT in actual Upstox holdings. These trades may have failed. Do NOT generate new signals for these symbols unless you have a strong reason.`;

                  logger.info(`Unfilled signals detected for portfolio ${portfolio.id}: ${unfilledNames}`);

                  // Alert user via Telegram
                  const telegramUser = portfolio.user?.telegramUser;
                  if (telegramUser) {
                    const bot = getBot();
                    if (bot) {
                      await bot.sendMessage(
                        parseInt(telegramUser.telegramId),
                        `⚠️ *Unfilled Signals Detected*\n\nPrevious BUY signals for *${unfilledNames}* were executed but trades did not complete in Upstox. Please check your order history.`,
                        { parse_mode: 'Markdown' }
                      );
                    }
                  }
                }
              } catch (holdingsErr) {
                logger.warn(`Could not fetch Upstox holdings for verification (user ${portfolio.user.id}):`, holdingsErr.message);
              }
            }
          } catch (verifyErr) {
            logger.error(`Holdings verification failed for portfolio ${portfolio.id}:`, verifyErr.message);
          }
        }

        // Pre-signal audit logging
        try {
          const { effectiveCash: eCash } = await getEffectiveCash(portfolio.id);
          const invested = (portfolio.holdings || []).reduce((s, h) => s + h.quantity * parseFloat(h.avgPrice), 0);
          logger.info(`[Signal Pre-Audit] Portfolio ${portfolio.id} "${portfolio.ownerName || portfolio.name}": capital=₹${parseFloat(portfolio.startingCapital || 0).toFixed(0)}, effectiveCash=₹${eCash.toFixed(0)}, holdings=${(portfolio.holdings || []).length}, invested=₹${invested.toFixed(0)}, lastVerified=${portfolio.lastVerifiedAt || 'never'}`);
        } catch (logErr) {
          logger.warn(`Pre-audit logging failed for portfolio ${portfolio.id}:`, logErr.message);
        }

        // Include pre-market thesis if generated today
        const preMarketCtx = getTodayPreMarketThesis();
        const fullContext = [extraContext, preMarketCtx].filter(Boolean).join('\n\n');
        const signals = await generateTradeSignals(portfolio.id, fullContext);
        totalSignals += signals.length;
        portfoliosScanned++;

        // Post-signal logging
        const buySignals = signals.filter(s => s.side === 'BUY');
        const sellSignals = signals.filter(s => s.side === 'SELL');
        const buyTotal = buySignals.reduce((s, sig) => s + (sig.quantity * (parseFloat(sig.triggerPrice) || 0)), 0);
        logger.info(`[Signal Post-Gen] Portfolio ${portfolio.id}: ${signals.length} signals generated (${buySignals.length} BUY ₹${buyTotal.toFixed(0)}, ${sellSignals.length} SELL)`);

        // Small delay between portfolios to avoid API rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        logger.error(`Signal generation failed for portfolio ${portfolio.id}:`, error.message);
      }
    }

    logger.info(`Signal generation complete: ${totalSignals} signals across ${eligiblePortfolios.length} portfolios`);

    // Determine which heartbeat name applies (9:30 or 13:00)
    const { h } = nowIST();
    const heartbeatName = h < 12 ? '9:30-signals' : '13:00-signals';
    recordScanRun(heartbeatName, totalSignals);

    // If scan ran for at least one portfolio but found zero signals — tell the user.
    // Silence = ambiguity. User needs to know: "system ran, market had nothing for us."
    if (portfoliosScanned > 0 && totalSignals === 0) {
      let regimeNote = '';
      try {
        const { getMarketRegime: getRegime } = await import('../services/technicalAnalysis.js');
        const regime = await getRegime();
        regimeNote = ` Current regime: *${regime.regime}*${regime.aggressionMultiplier < 0.7 ? ' (defensive mode)' : ''}.`;
      } catch { /* ignore */ }

      await alertEligibleUsers(
        `📊 *Market Scan Complete — ${nowISTStr()} IST*\n\n` +
        `Scanned the full NSE market. No setups met the conviction threshold.${regimeNote}\n\n` +
        `_Cash preserved and ready to deploy when the right opportunity appears._\n` +
        `_Next scan: 11:00 AM (pivot) → 1:00 PM (full) → 2:30 PM (pivot)_`
      );
    }
  } catch (error) {
    logger.error('Signal generation batch error:', error);
  }
}

/**
 * Check for pending trade signals and send/resend to Telegram.
 * Signals are sent with inline buttons: Execute/ACK, Snooze 30m, Dismiss.
 * Re-sends every 30 minutes until acknowledged, executed, or dismissed.
 */
async function notifyPendingSignals() {
  if (!isTradingDay(new Date())) return;

  const pauseState = await getSystemPauseState();
  if (pauseState) {
    logger.info(`[Signal Notifier] Paused (${pauseState.reason}) — skipping notifications`);
    return;
  }

  const bot = getBot();
  if (!bot) return;

  try {
    // First expire old signals
    await expireOldSignals();

    const now = new Date();
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);

    // Find signals that need notification:
    // - Status PENDING or SNOOZED
    // - Never notified, OR last notified >= 30 min ago
    const signals = await prisma.tradeSignal.findMany({
      where: {
        status: { in: ['PENDING', 'SNOOZED'] },
        OR: [
          { lastNotifiedAt: null },
          { lastNotifiedAt: { lte: thirtyMinAgo } }
        ]
      },
      include: {
        portfolio: {
          include: {
            user: {
              include: {
                telegramUser: true,
                upstoxIntegration: true
              }
            }
          }
        }
      }
    });

    // Build holdings map per portfolio for stale signal detection
    const portfolioHoldingsCache = new Map();
    async function getPortfolioHoldings(portfolioId) {
      if (!portfolioHoldingsCache.has(portfolioId)) {
        const holdings = await prisma.holding.findMany({
          where: { portfolioId },
          select: { symbol: true, quantity: true }
        });
        const map = new Map();
        for (const h of holdings) map.set(h.symbol, h.quantity);
        portfolioHoldingsCache.set(portfolioId, map);
      }
      return portfolioHoldingsCache.get(portfolioId);
    }

    let sentCount = 0;
    let expiredCount = 0;
    for (const signal of signals) {
      // Skip signals for paused portfolios
      if (signal.portfolio?.isPaused) continue;

      const telegramUser = signal.portfolio?.user?.telegramUser;
      if (!telegramUser || !telegramUser.isActive || telegramUser.isMuted) continue;

      // Validate signal against current holdings before notifying
      const holdingsMap = await getPortfolioHoldings(signal.portfolioId);
      const heldQty = holdingsMap.get(signal.symbol) || 0;

      if (signal.side === 'SELL' && heldQty <= 0) {
        // Stock already sold — expire this signal silently
        await prisma.tradeSignal.update({
          where: { id: signal.id },
          data: { status: 'EXPIRED' }
        });
        expiredCount++;
        logger.info(`Signal #${signal.id} auto-expired: SELL ${signal.symbol} but no longer held (portfolio ${signal.portfolioId})`);
        continue;
      }

      try {
        const chatId = parseInt(telegramUser.telegramId);
        const sideEmoji = signal.side === 'BUY' ? '🟢' : '🔴';
        const confidenceBar = '█'.repeat(Math.floor(signal.confidence / 10)) + '░'.repeat(10 - Math.floor(signal.confidence / 10));

        let priceInfo = '';
        if (signal.triggerType === 'MARKET') {
          priceInfo = 'At Market Price';
        } else if (signal.triggerType === 'LIMIT') {
          priceInfo = `Limit: ₹${signal.triggerPrice}`;
        } else if (signal.triggerType === 'ZONE') {
          priceInfo = `Zone: ₹${signal.triggerLow} - ₹${signal.triggerHigh}`;
        }

        const portfolioName = signal.portfolio.ownerName || signal.portfolio.name;
        const brokerName = (signal.portfolio.broker || 'Unknown').replace(/_/g, ' ');
        const riskProfile = signal.portfolio.riskProfile || '';
        const repeatNote = signal.notifyCount > 0 ? `\n⏰ _Reminder #${signal.notifyCount + 1}_` : '';

        const msgText = `${sideEmoji} *${signal.side} SIGNAL*
━━━━━━━━━━━━━━━━━━━
*${signal.symbol}* (${signal.exchange})
Qty: ${signal.quantity} | ${priceInfo}

📁 *${portfolioName}* — ${brokerName}${riskProfile ? ' (' + riskProfile + ')' : ''}

Confidence: ${confidenceBar} ${signal.confidence}%
${signal.rationale || ''}${repeatNote}`;

        // Check if this portfolio's broker is Upstox AND user has valid Upstox integration
        const isUpstoxBroker = signal.portfolio?.broker === 'UPSTOX';
        const upstoxIntegration = signal.portfolio?.user?.upstoxIntegration;
        const hasUpstox = isUpstoxBroker && upstoxIntegration?.isConnected && upstoxIntegration?.accessToken;

        const buttons = hasUpstox
          ? [
              { text: '🚀 Execute', callback_data: `sig_exec_${signal.id}` },
              { text: '⏰ Snooze 30m', callback_data: `sig_snooze_${signal.id}` },
              { text: '❌ Dismiss', callback_data: `sig_dismiss_${signal.id}` }
            ]
          : [
              { text: '✅ ACK', callback_data: `sig_ack_${signal.id}` },
              { text: '⏰ Snooze 30m', callback_data: `sig_snooze_${signal.id}` },
              { text: '❌ Dismiss', callback_data: `sig_dismiss_${signal.id}` }
            ];

        const inlineKeyboard = {
          reply_markup: {
            inline_keyboard: [buttons]
          }
        };

        await withRetry(
          () => bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', ...inlineKeyboard }),
          `signal #${signal.id} notify to ${chatId}`
        );

        // Update notification tracking
        await prisma.tradeSignal.update({
          where: { id: signal.id },
          data: {
            lastNotifiedAt: now,
            notifyCount: { increment: 1 },
            // If it was snoozed, move back to pending for the next cycle
            status: 'PENDING'
          }
        });

        sentCount++;
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (error) {
        logger.error(`Failed to notify signal ${signal.id}:`, error.message);
      }
    }

    if (expiredCount > 0) {
      logger.info(`Auto-expired ${expiredCount} stale signals (holdings no longer exist)`);
    }
    if (sentCount > 0) {
      logger.info(`Sent ${sentCount}/${signals.length} trade signal notifications`);
    } else if (signals.length > 0 && expiredCount === 0) {
      logger.warn(`Found ${signals.length} pending signals but sent 0 (no linked Telegram users)`);
    }
  } catch (error) {
    logger.error('Signal notification error:', error);
  }
}

/**
 * Poll pending/placing Upstox orders and update linked TradeSignals.
 * Runs every 5 min during market hours to catch orders that settled
 * after the initial 15s polling window.
 */
async function pollPendingOrders() {
  if (!isTradingDay(new Date())) return;

  const bot = getBot();

  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Find all non-terminal UpstoxOrders from last 24h
    const pendingOrders = await prisma.upstoxOrder.findMany({
      where: {
        createdAt: { gte: twentyFourHoursAgo },
        status: { notIn: ['complete', 'traded', 'rejected', 'cancelled', 'COMPLETE', 'TRADED', 'REJECTED', 'CANCELLED'] }
      },
      include: {
        integration: { include: { user: { include: { telegramUser: true } } } }
      }
    });

    if (pendingOrders.length === 0) return;

    logger.info(`Polling ${pendingOrders.length} pending Upstox orders...`);

    for (const order of pendingOrders) {
      try {
        if (!order.integration?.accessToken) continue;

        const status = await getOrderStatus(order.integration.userId, order.orderId);
        const orderStatus = (status.status || '').toLowerCase();

        if (!['complete', 'traded', 'rejected', 'cancelled'].includes(orderStatus)) {
          continue; // Still pending
        }

        logger.info(`Order ${order.orderId} settled: ${orderStatus}`);

        // Find linked TradeSignal
        const linkedSignal = await prisma.tradeSignal.findFirst({
          where: { upstoxOrderId: order.id }
        });

        if (!linkedSignal) continue;

        const telegramUser = order.integration?.user?.telegramUser;
        const chatId = telegramUser ? parseInt(telegramUser.telegramId) : null;

        if (['complete', 'traded'].includes(orderStatus)) {
          // Success — confirm signal
          if (linkedSignal.status !== 'EXECUTED') {
            await prisma.tradeSignal.update({
              where: { id: linkedSignal.id },
              data: { status: 'EXECUTED' }
            });
          }

          if (bot && chatId && telegramUser.isActive) {
            const avgPrice = status.averagePrice ? ` @ ₹${status.averagePrice}` : '';
            await bot.sendMessage(chatId,
              `✅ *ORDER CONFIRMED* (via monitoring)\n\n${linkedSignal.side} ${linkedSignal.quantity}x *${linkedSignal.symbol}*${avgPrice}\nOrder: \`${order.orderId}\``,
              { parse_mode: 'Markdown' }
            );
          }
        } else {
          // Failure — roll back signal
          await prisma.tradeSignal.update({
            where: { id: linkedSignal.id },
            data: { status: 'PENDING', upstoxOrderId: null, lastNotifiedAt: null }
          });

          if (bot && chatId && telegramUser.isActive) {
            const reason = status.message || 'Unknown reason';
            await bot.sendMessage(chatId,
              `🔴 *ORDER FAILED — THIS IS MY FAILURE*\n\n${linkedSignal.side} ${linkedSignal.symbol} was *${orderStatus.toUpperCase()}*\nReason: _${reason}_\n\nSignal has been reset. It will re-appear in your next notification cycle.`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🔄 Retry as MARKET', callback_data: `sig_mkt_${linkedSignal.id}` },
                    { text: '⏰ Snooze 1hr', callback_data: `sig_snooze_${linkedSignal.id}` },
                    { text: '🚫 Dismiss', callback_data: `sig_dismiss_${linkedSignal.id}` }
                  ]]
                }
              }
            );
          }

          logger.warn(`Signal #${linkedSignal.id} rolled back via cron: order ${order.orderId} = ${orderStatus}`);
        }

        // Small delay between API calls
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (orderErr) {
        logger.error(`Failed to poll order ${order.orderId}:`, orderErr.message);
      }
    }
  } catch (error) {
    logger.error('Order polling cron error:', error);
  }
}

/**
 * Conditional midday signal generation.
 * Only fires if: no active pending/snoozed signals today OR target >30% behind.
 * Saves 1 Claude call on good days.
 */
async function generateSignalsConditional() {
  if (!isTradingDay(new Date())) return;

  const pauseState = await getSystemPauseState();
  if (pauseState) {
    logger.info(`[Signal Generator] Paused (${pauseState.reason}) — skipping conditional midday generation`);
    return;
  }

  try {
    const portfolios = await prisma.portfolio.findMany({
      where: { isActive: true, isPaused: false },
      include: {
        holdings: true,
        user: { include: { telegramUser: true } }
      }
    });

    const eligible = portfolios.filter(p =>
      p.user?.telegramUser?.isActive && !p.user?.telegramUser?.isMuted
    );

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let generated = 0;
    for (const portfolio of eligible) {
      try {
        // Check if there are active signals today
        const activeSignals = await prisma.tradeSignal.count({
          where: {
            portfolioId: portfolio.id,
            status: { in: ['PENDING', 'SNOOZED'] },
            createdAt: { gte: today }
          }
        });

        // Check if target is >30% behind
        const target = await prisma.dailyTarget.findUnique({
          where: { portfolioId_date: { portfolioId: portfolio.id, date: today } }
        });

        const targetAmount = parseFloat(target?.aiTarget || target?.userTarget || 0);
        const earned = parseFloat(target?.earnedActual || 0);
        const isBehind = targetAmount > 0 && earned < targetAmount * 0.7;

        if (activeSignals > 0 && !isBehind) {
          logger.info(`Portfolio ${portfolio.id}: ${activeSignals} active signals + on track — skipping midday generation`);
          continue;
        }

        logger.info(`Portfolio ${portfolio.id}: midday signal generation triggered (signals: ${activeSignals}, behind: ${isBehind})`);
        await generateSignalsForAllPortfoliosForOne(portfolio);
        generated++;
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        logger.error(`Conditional midday signals failed for portfolio ${portfolio.id}:`, err.message);
      }
    }

    logger.info(`Conditional midday signals: generated for ${generated}/${eligible.length} portfolios`);
  } catch (error) {
    logger.error('Conditional midday signal error:', error);
  }
}

/**
 * Generate signals for a single portfolio (extracted from batch function).
 */
async function generateSignalsForAllPortfoliosForOne(portfolio) {
  // Gate: non-Upstox portfolios must have recently verified capital
  if (portfolio.broker !== 'UPSTOX') {
    const lastVerified = portfolio.lastVerifiedAt;
    const now = new Date();
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const isStale = !lastVerified || (now.getTime() - new Date(lastVerified).getTime() > twoDaysMs);
    if (isStale) {
      logger.info(`Skipping midday signal for portfolio ${portfolio.id}: capital data stale`);
      return;
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const existingToday = await prisma.tradeSignal.count({
    where: {
      portfolioId: portfolio.id,
      createdAt: { gte: today },
      status: { notIn: ['EXPIRED'] }
    }
  });

  if (existingToday >= 3) {
    logger.info(`Portfolio ${portfolio.id} already has ${existingToday} signals today, skipping`);
    return;
  }

  const signals = await generateTradeSignals(portfolio.id);
  logger.info(`[Midday Signals] Portfolio ${portfolio.id}: ${signals.length} signals generated`);
}

// ─── Intraday pivot context ────────────────────────────────────────────────────
// Time-specific market intelligence injected into pivot-window signal generation.
const PIVOT_TIME_CONTEXTS = {
  '11:00 AM': `
⏰ MID-MORNING PIVOT SCAN (11:00 AM):
The first 90 minutes have played out. The opening setup is now confirmed or invalidated. Scan for:
- Stocks that HELD breakouts from the open and are consolidating near the breakout level — these are continuation entries
- Opening gaps that have FILLED completely — the filling = exhaustion, potential reversal with defined risk
- Any sector ETF that changed direction vs the pre-market thesis — rotate into the NEW leader, exit the laggard
- Stocks sitting at today's Pivot Point (PP): above PP = bullish bias for rest of day, below PP = bearish
- R1 resistance breaks with volume confirmation = strong momentum entry for the day's move
- S1 support holds with volume dry-up = high R:R bounce entry

Focus ONLY on NEW setups that weren't visible at 9:30 AM. If morning signals are still pending and technically valid, acknowledge them but don't duplicate. The market has given you more information — use it.`,

  '2:30 PM': `
⏰ PRE-CLOSE PIVOT SCAN (2:30 PM):
Final 60 minutes before NSE close — institutional positioning window. This is when smart money takes its stance:
- Stocks holding NEAR-HIGH for the day = institutions accumulated = strong overnight longs (delivery)
- Stocks with late-day volume surges at R1 or R2 = institutional accumulation = buy before close
- Stocks at day's LOW with declining sell volume = exhaustion = reversal setup for tomorrow's open
- Holdings that CLOSED below EMA20 today and are now drifting lower = exit before tomorrow gap-down
- Any stock showing price fade + rising volume = distribution = SELL signal NOW before 3:15 PM cutoff

For BUY signals: these are overnight/delivery trades. Only recommend if the stock is strong enough to gap UP (not down) at tomorrow's open. CNC delivery — execution must happen before 3:15 PM.
For SELL signals: deteriorating momentum + closing weak = act now. Every minute past 2:30 PM costs slippage.`,
};

/**
 * Generate signals at intraday pivot times — 11:00 AM and 2:30 PM.
 * Fires only if signals are stale (>60 min old) or no active signals remain.
 * Injects time-specific market context so Claude reasons about intraday structure.
 *
 * @param {string} timeLabel - '11:00 AM' or '2:30 PM'
 */
async function generateSignalsAtPivot(timeLabel) {
  if (!isTradingDay(new Date())) return;

  const pauseState = await getSystemPauseState();
  if (pauseState) {
    logger.info(`[${timeLabel}] System paused — skipping pivot scan`);
    return;
  }

  const portfolios = await prisma.portfolio.findMany({
    where: { isActive: true, isPaused: false },
    include: { holdings: true, user: { include: { telegramUser: true } } }
  });

  const eligible = portfolios.filter(p =>
    p.user?.telegramUser?.isActive && !p.user?.telegramUser?.isMuted
  );
  if (eligible.length === 0) return;

  // Sync Upstox funds and expire stale SELL signals before generating
  await syncAllUpstoxFunds();
  await syncAllUpstoxHoldingsAndExpireStaleSignals();

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const nowMs = Date.now();
  const timeContext   = PIVOT_TIME_CONTEXTS[timeLabel] || '';
  const preMarketCtx  = getTodayPreMarketThesis();

  let generated = 0;
  for (const portfolio of eligible) {
    try {
      // Capital staleness gate for non-Upstox portfolios
      if (portfolio.broker !== 'UPSTOX') {
        const lastVerified = portfolio.lastVerifiedAt;
        const twoDaysMs    = 2 * 24 * 60 * 60 * 1000;
        const isStale      = !lastVerified || (nowMs - new Date(lastVerified).getTime() > twoDaysMs);
        if (isStale) {
          logger.info(`[${timeLabel}] Portfolio ${portfolio.id}: capital stale — skipping`);
          continue;
        }
      }

      // Fire only if signals are older than 60 min OR fewer than 2 active signals remain
      const lastSignal = await prisma.tradeSignal.findFirst({
        where: { portfolioId: portfolio.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true }
      });
      const minsSinceLast = lastSignal
        ? (nowMs - new Date(lastSignal.createdAt).getTime()) / 60000
        : 9999;

      const activeCount = await prisma.tradeSignal.count({
        where: {
          portfolioId: portfolio.id,
          status: { in: ['PENDING', 'SNOOZED', 'ACKED'] },
          createdAt: { gte: today }
        }
      });

      if (activeCount >= 2 && minsSinceLast < 60) {
        logger.info(`[${timeLabel}] Portfolio ${portfolio.id}: ${activeCount} active signals (${Math.round(minsSinceLast)}min old) — skipping pivot scan`);
        continue;
      }

      const fullContext = [timeContext, preMarketCtx].filter(Boolean).join('\n\n');
      const signals = await generateTradeSignals(portfolio.id, fullContext);
      generated++;
      logger.info(`[${timeLabel}] Portfolio ${portfolio.id}: ${signals.length} signals from pivot scan`);
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      logger.error(`[${timeLabel}] Portfolio ${portfolio.id}:`, err.message);
    }
  }

  logger.info(`[${timeLabel}] Pivot scan complete: ${generated}/${eligible.length} portfolios generated`);

  // Record heartbeat
  const heartbeatName = timeLabel === '11:00 AM' ? '11:00-pivot' : '14:30-pivot';
  recordScanRun(heartbeatName, generated);

  // Notify if scan ran but found nothing — user should know system is alive
  if (eligible.length > 0 && generated === 0) {
    // All portfolios had enough active signals — this is normal, just log
    logger.info(`[${timeLabel}] All portfolios had sufficient active signals — pivot scan skipped`);
  }
}

/**
 * Initialize the signal notifier cron jobs.
 */
export function initSignalNotifier() {
  logger.info('Initializing signal notifier...');

  // Pre-market intelligence at 8:30 AM — sector analysis + today's thesis
  cron.schedule('30 8 * * 1-5', async () => {
    logger.info('[Pre-Market] Generating morning intelligence brief...');
    await generatePreMarketIntelligence();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Remind to re-auth Upstox at 9:15 AM if token expired
  cron.schedule('15 9 * * 1-5', async () => {
    if (!isTradingDay(new Date())) return;
    await remindUpstoxAuth();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Sync Upstox funds at 9:17 AM (after auth reminder, before signals)
  cron.schedule('17 9 * * 1-5', async () => {
    if (!isTradingDay(new Date())) return;
    logger.info('Running Upstox fund sync...');
    await syncAllUpstoxFunds();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Morning targets now handled by War Room (9:00 AM in telegramAlerts.js)

  // Generate signals at 9:30 AM (market open)
  cron.schedule('30 9 * * 1-5', async () => {
    logger.info('Running morning signal generation...');
    await generateSignalsForAllPortfolios();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Mid-morning pivot scan at 11:00 AM — direction confirmed, new setups emerging
  cron.schedule('0 11 * * 1-5', async () => {
    logger.info('[11:00 AM] Running mid-morning pivot signal scan...');
    await generateSignalsAtPivot('11:00 AM');
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Midday full scan at 1:00 PM — unconditional, complete market sweep
  cron.schedule('0 13 * * 1-5', async () => {
    logger.info('[1:00 PM] Running midday signal generation...');
    await generateSignalsForAllPortfolios();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Pre-close pivot scan at 2:30 PM — institutional positioning window
  cron.schedule('30 14 * * 1-5', async () => {
    logger.info('[2:30 PM] Running pre-close pivot signal scan...');
    await generateSignalsAtPivot('2:30 PM');
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Notify pending signals every 5 minutes during market hours
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    await notifyPendingSignals();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Poll pending Upstox orders every 5 min during market hours
  cron.schedule('*/5 9-16 * * 1-5', async () => {
    await pollPendingOrders();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Mid-day holdings sync every 30 min during market hours (DDPI SELL awareness)
  // Runs even when paused so data is fresh on resume
  cron.schedule('*/30 9-15 * * 1-5', async () => {
    if (!isTradingDay(new Date())) return;
    logger.info('Running mid-day Upstox holdings sync...');
    await syncAllUpstoxHoldingsAndExpireStaleSignals();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // EOD review at 3:45 PM — Sonnet reviews today's signals + overnight watchlist
  cron.schedule('45 15 * * 1-5', async () => {
    if (!isTradingDay(new Date())) return;
    logger.info('[EOD Review] Running end-of-day signal review...');
    await eodReview();
    recordScanRun('eod-review');
  }, {
    timezone: 'Asia/Kolkata'
  });

  // ─── Reliability: Watchdog + Startup Recovery ──────────────────────────────

  // Watchdog: every 15 min from pre-market through evening — detects missed scans.
  // Covers 8 AM (pre-market) through 8:30 PM (evening playbook grace window).
  cron.schedule('*/15 8-20 * * 1-5', async () => {
    await checkScanHealthAndRecover();
  }, {
    timezone: 'Asia/Kolkata'
  });

  // Startup recovery: fires 12s after init (gives DB/bot time to stabilize).
  // If a deploy happened during market hours and missed the 9:30 AM scan,
  // this detects it and runs signal generation immediately.
  setTimeout(async () => {
    try {
      await runStartupRecovery();
    } catch (err) {
      logger.error('[Startup Recovery] Error:', err.message);
    }
  }, 12000);

  logger.info('Signal notifier initialized:');
  logger.info('  Pre-market intelligence: 8:30 AM IST');
  logger.info('  Upstox fund sync: 9:17 AM IST');
  logger.info('  Signal generation: 9:30 AM (full) | 11:00 AM (pivot) | 1:00 PM (full) | 2:30 PM (pivot) IST');
  logger.info('  Signal notifications: every 5 min, 9-3:30 PM IST');
  logger.info('  Order status polling: every 5 min, 9 AM-4 PM IST');
  logger.info('  Mid-day holdings sync (DDPI): every 30 min, 9-3:30 PM IST');
  logger.info('  EOD review: 3:45 PM IST');
  logger.info('  Watchdog (missed scan recovery): every 15 min, 8 AM–8:30 PM IST');
  logger.info('  Startup recovery: fires 12s after init');
}

export default { initSignalNotifier, notifyPendingSignals, generateSignalsForAllPortfolios, pollPendingOrders, generateSignalsConditional, syncAllUpstoxFunds, generateSignalsAtPivot };

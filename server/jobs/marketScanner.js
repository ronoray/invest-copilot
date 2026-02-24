import prisma from '../services/prisma.js';
import { getCurrentPrice, getWatchlistSignals } from '../services/marketData.js';
import { triageSignalRegen } from '../services/signalTriage.js';
import { generateTradeSignals, expireOldSignals } from '../services/signalGenerator.js';
import { getPrevDayHighLow } from '../services/marketIntelligence.js';
import { getBot } from '../services/telegramBot.js';
import { isTradingDay } from '../utils/marketHolidays.js';
import logger from '../services/logger.js';

// ─── Daily price snapshot ─────────────────────────────────────────────────────
// Prices captured on the first market scan of each day (after 9:15 AM).
// Used as baseline to detect intraday moves that may invalidate signals.
const dailyOpenPrices  = new Map(); // symbol → price at first scan today
let dailyOpenDate      = null;      // 'YYYY-MM-DD' IST — prevents re-init on same day

// ─── Previous day high/low (for breakout detection) ──────────────────────────
// Fetched once per day from TIME_SERIES_DAILY.
// A close above prev day high is the #1 momentum confirmation signal.
const prevDayHighLow = new Map(); // symbol → {high, low, close}
let prevDayHLDate    = null;

// ─── Triage rate limits ───────────────────────────────────────────────────────
// Keep Claude API costs minimal: Haiku is cheap but still gated by cooldowns.
// Max 2 market-triggered Sonnet regens per day (morning + midday are separate).
let lastTriageTime = 0;          // ms timestamp of last Haiku triage call
let marketRegenCountToday = 0;   // Sonnet regens triggered by price moves today
let marketRegenDate = null;      // 'YYYY-MM-DD' IST for the counter above

const MOVE_THRESHOLD_PCT    = 3;                  // % from open to flag a move
const BREAKOUT_BUFFER_PCT   = 0.3;                // % above prev high to confirm breakout
const TRIAGE_COOLDOWN_MS    = 60 * 60 * 1000;     // 60 min between Haiku calls (was 90)
const MAX_MARKET_REGENS     = 3;                   // Sonnet regens/day via this path (was 2)
const TRIAGE_WINDOW_START   = 10;                  // Don't triage before 10 AM IST
const TRIAGE_WINDOW_END     = 15;                  // Don't triage after 3 PM IST (was 2 PM)
const FRESH_SIGNAL_HOURS    = 1.5;                 // Signals younger than this are safe
const MAJOR_MOVE_PCT        = 6;                   // Skip freshness gate if move ≥ this

/**
 * Main market scanner — runs every 5 min during market hours via index.js cron.
 * 1. Update all portfolio holding prices in DB.
 * 2. Check watchlist price alerts.
 * 3. Detect significant intraday price deviations; triage with Haiku and
 *    regenerate signals with Sonnet only when warranted.
 */
export async function scanMarket() {
  logger.info('=== Market Scanner Started ===');

  try {
    // Fetch previous day H/L once per day (used for breakout detection)
    await ensurePrevDayHighLow();

    const updatedPrices = await updatePortfolioTask();
    await checkWatchlistTask();

    if (updatedPrices.length > 0) {
      await checkPriceDeviationsAndTriage(updatedPrices);
    }

    logger.info('=== Market Scanner Completed ===');
  } catch (error) {
    logger.error('Market scanner error:', error);
  }
}

/**
 * Fetch previous day high/low for all portfolio holdings (once per trading day).
 * Used to detect breakouts above the previous session's high — the primary
 * momentum confirmation signal used by institutional traders.
 */
async function ensurePrevDayHighLow() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (prevDayHLDate === today) return;

  const holdings = await prisma.holding.findMany({
    select: { symbol: true, exchange: true }
  });

  prevDayHighLow.clear();

  for (const h of holdings) {
    try {
      const hl = await getPrevDayHighLow(h.symbol, h.exchange || 'NSE');
      if (hl) {
        prevDayHighLow.set(h.symbol, hl);
        logger.info(`[Market Scanner] ${h.symbol} prev day H/L: ₹${hl.high.toFixed(2)} / ₹${hl.low.toFixed(2)}`);
      }
      await sleep(12000);
    } catch (e) {
      logger.warn(`[Market Scanner] Could not fetch prev day H/L for ${h.symbol}: ${e.message}`);
    }
  }

  prevDayHLDate = today;
  logger.info(`[Market Scanner] Prev day H/L initialised for ${prevDayHighLow.size} holdings`);
}

/**
 * Update all portfolio holdings with current prices.
 * Returns [{symbol, price}] for deviation tracking.
 */
async function updatePortfolioTask() {
  const updatedPrices = [];

  try {
    const holdings = await prisma.holding.findMany();
    let updated = 0;

    for (const holding of holdings) {
      try {
        const priceData = await getCurrentPrice(holding.symbol, holding.exchange);

        await prisma.holding.update({
          where: { id: holding.id },
          data: { currentPrice: priceData.price }
        });

        updatedPrices.push({ symbol: holding.symbol, price: priceData.price });
        updated++;
        logger.info(`Updated ${holding.symbol}: ₹${priceData.price}`);

        await sleep(12000); // Alpha Vantage free-tier: 5 calls/min
      } catch (error) {
        logger.error(`Failed to update ${holding.symbol}:`, error.message);
      }
    }

    logger.info(`Portfolio update: ${updated}/${holdings.length} stocks`);
  } catch (error) {
    logger.error('Portfolio update task error:', error);
  }

  return updatedPrices;
}

/**
 * Check watchlist items for price alerts.
 */
async function checkWatchlistTask() {
  try {
    const signals = await getWatchlistSignals();

    if (signals.length > 0) {
      logger.info(`Watchlist signals: ${signals.length}`);
      for (const signal of signals) {
        await prisma.alert.create({
          data: {
            symbol: signal.symbol,
            alertType: signal.type,
            message: `${signal.symbol}: ${signal.type}`,
            data: signal
          }
        });
      }
    }
  } catch (error) {
    logger.error('Watchlist check task error:', error);
  }
}

/**
 * Handle breakouts above previous day's high.
 * These are higher-conviction signals that bypass the standard time-window
 * gate. A 0.75h freshness threshold is used (vs 1.5h for regular moves).
 */
async function handleBreakouts(breakouts) {
  const nowMs = Date.now();

  // Still respect the Haiku cooldown to cap costs
  if (nowMs - lastTriageTime < TRIAGE_COOLDOWN_MS) return;

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (marketRegenDate !== today) { marketRegenCountToday = 0; marketRegenDate = today; }
  if (marketRegenCountToday >= MAX_MARKET_REGENS) return;

  const portfolios = await prisma.portfolio.findMany({
    where: { isActive: true, isPaused: false },
    include: { holdings: true, user: { include: { telegramUser: true } } }
  });

  for (const portfolio of portfolios) {
    const telegramUser = portfolio.user?.telegramUser;
    if (!telegramUser?.isActive || telegramUser?.isMuted) continue;

    // Only regen if one of the breakout stocks is in this portfolio or a pending signal
    const portfolioSymbols = new Set(portfolio.holdings.map(h => h.symbol));
    const pendingSymbols = await prisma.tradeSignal.findMany({
      where: { portfolioId: portfolio.id, status: { in: ['PENDING', 'SNOOZED'] } },
      select: { symbol: true }
    }).then(sigs => new Set(sigs.map(s => s.symbol)));

    const relevantBreakouts = breakouts.filter(b =>
      portfolioSymbols.has(b.symbol) || pendingSymbols.has(b.symbol)
    );
    if (relevantBreakouts.length === 0) continue;

    // Skip if signals are very fresh (< 45 min)
    const lastSignal = await prisma.tradeSignal.findFirst({
      where: { portfolioId: portfolio.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true }
    });
    const minsSinceLast = lastSignal
      ? (nowMs - new Date(lastSignal.createdAt).getTime()) / 60000
      : 9999;
    if (minsSinceLast < 45) continue;

    const pendingCount = await prisma.tradeSignal.count({
      where: { portfolioId: portfolio.id, status: { in: ['PENDING', 'SNOOZED'] } }
    });

    lastTriageTime = nowMs;
    const { shouldRegen, reason } = await triageSignalRegen(portfolio, relevantBreakouts, pendingCount);

    if (!shouldRegen) {
      logger.info(`[Breakout] Portfolio ${portfolio.id}: Haiku says hold — ${reason}`);
      continue;
    }

    const bot = getBot();
    if (bot) {
      const breakoutText = relevantBreakouts.map(b =>
        `*${b.symbol}* ₹${b.currentPrice.toFixed(2)} 📈 (prev high ₹${b.prevHigh.toFixed(2)})`
      ).join('\n');
      await bot.sendMessage(
        parseInt(telegramUser.telegramId),
        `🚀 *Breakout Detected — Refreshing Signals*\n\n${breakoutText}\n\n_${reason}_`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }

    await expireOldSignals();
    const newSignals = await generateTradeSignals(
      portfolio.id,
      `🚀 BREAKOUT SIGNAL: ${relevantBreakouts.map(b => `${b.symbol} broke prev-day high ₹${b.prevHigh.toFixed(0)}`).join(', ')}. ${reason}`
    );

    marketRegenCountToday++;
    logger.info(`[Breakout] Portfolio ${portfolio.id}: ${newSignals.length} signals after breakout (regen ${marketRegenCountToday}/${MAX_MARKET_REGENS})`);
  }
}

/**
 * Compare freshly updated prices to today's opening snapshot.
 * If any holding has moved ≥ MOVE_THRESHOLD_PCT from the daily open,
 * call Haiku to decide whether to regenerate signals via Sonnet.
 *
 * Gating (in order):
 *   1. Not a trading day → skip
 *   2. First scan of the day → initialise snapshot, return (no comparison yet)
 *   3. Outside triage window (10 AM – 2 PM IST) → skip
 *   4. No significant moves → skip
 *   5. Haiku cooldown (90 min) active → skip
 *   6. Daily Sonnet regen cap (2/day) reached → skip
 *   7. Per-portfolio: signals are fresh (<1.5h) AND no major move (≥6%) → skip
 *   8. Haiku says hold → skip
 *   9. Haiku says regen → expire pending signals, call Sonnet, notify user
 */
async function checkPriceDeviationsAndTriage(updatedPrices) {
  if (!isTradingDay(new Date())) return;

  const nowIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // ── Init daily snapshot on first scan of the day ──────────────────────────
  if (dailyOpenDate !== nowIST) {
    dailyOpenDate = nowIST;
    dailyOpenPrices.clear();
    for (const { symbol, price } of updatedPrices) {
      dailyOpenPrices.set(symbol, price);
    }
    logger.info(`[Market Scanner] Daily price snapshot set for ${nowIST} (${updatedPrices.length} symbols)`);
    return; // First scan = establish baseline; nothing to compare against yet
  }

  // ── Only triage during 10 AM – 2 PM IST ───────────────────────────────────
  const hourIST = new Date().toLocaleString('en-IN', {
    hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata'
  });
  const hour = parseInt(hourIST);
  if (hour < TRIAGE_WINDOW_START || hour >= TRIAGE_WINDOW_END) return;

  // ── Detect significant intraday moves ────────────────────────────────────
  const significantMoves = [];
  for (const { symbol, price } of updatedPrices) {
    const openPrice = dailyOpenPrices.get(symbol);
    if (!openPrice) continue;
    const changePct = ((price - openPrice) / openPrice) * 100;
    if (Math.abs(changePct) >= MOVE_THRESHOLD_PCT) {
      significantMoves.push({ symbol, prevPrice: openPrice, currentPrice: price, changePct });
    }
  }

  // ── Detect prev-day-high breakouts (primary momentum signal) ─────────────
  // A stock closing above yesterday's high = institutional confirmation.
  // This is a stronger signal than a simple % move — bypass the time window
  // gate and use a shorter freshness threshold.
  const breakouts = [];
  for (const { symbol, price } of updatedPrices) {
    const hl = prevDayHighLow.get(symbol);
    if (!hl || !hl.high) continue;
    const threshold = hl.high * (1 + BREAKOUT_BUFFER_PCT / 100);
    if (price >= threshold) {
      breakouts.push({
        symbol,
        prevHigh: hl.high,
        currentPrice: price,
        changePct: ((price - hl.high) / hl.high) * 100,
        type: 'BREAKOUT_PREV_HIGH'
      });
      logger.info(`[Market Scanner] BREAKOUT: ${symbol} ₹${price.toFixed(2)} > prev high ₹${hl.high.toFixed(2)}`);
    }
  }

  // Handle breakouts separately — these are high-conviction signals that
  // don't wait for the 10 AM triage window and have a shorter freshness gate
  if (breakouts.length > 0) {
    await handleBreakouts(breakouts);
  }

  if (significantMoves.length === 0) return;

  const moveLog = significantMoves.map(m =>
    `${m.symbol} ${m.changePct > 0 ? '+' : ''}${m.changePct.toFixed(1)}%`
  ).join(', ');
  logger.info(`[Market Scanner] Significant moves: ${moveLog}`);

  // ── Haiku cooldown ─────────────────────────────────────────────────────────
  const nowMs = Date.now();
  if (nowMs - lastTriageTime < TRIAGE_COOLDOWN_MS) {
    const remainMin = Math.round((TRIAGE_COOLDOWN_MS - (nowMs - lastTriageTime)) / 60000);
    logger.info(`[Market Scanner] Triage cooldown: ${remainMin} min remaining`);
    return;
  }

  // ── Daily Sonnet regen cap ─────────────────────────────────────────────────
  if (marketRegenDate !== nowIST) {
    marketRegenCountToday = 0;
    marketRegenDate = nowIST;
  }
  if (marketRegenCountToday >= MAX_MARKET_REGENS) {
    logger.info(`[Market Scanner] Daily regen cap (${MAX_MARKET_REGENS}) reached — skipping`);
    return;
  }

  // ── Per-portfolio triage ───────────────────────────────────────────────────
  const portfolios = await prisma.portfolio.findMany({
    where: { isActive: true, isPaused: false },
    include: {
      holdings: true,
      user: { include: { telegramUser: true } }
    }
  });

  const hasMajorMove = significantMoves.some(m => Math.abs(m.changePct) >= MAJOR_MOVE_PCT);

  for (const portfolio of portfolios) {
    try {
      const telegramUser = portfolio.user?.telegramUser;
      if (!telegramUser?.isActive || telegramUser?.isMuted) continue;

      // How old are the last generated signals?
      const lastSignal = await prisma.tradeSignal.findFirst({
        where: { portfolioId: portfolio.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true }
      });
      const hoursSinceLastGen = lastSignal
        ? (nowMs - new Date(lastSignal.createdAt).getTime()) / (60 * 60 * 1000)
        : 99;

      // Skip if signals are fresh and no major move justifies early regen
      if (hoursSinceLastGen < FRESH_SIGNAL_HOURS && !hasMajorMove) {
        logger.info(`[Market Scanner] Portfolio ${portfolio.id}: signals fresh (${hoursSinceLastGen.toFixed(1)}h) — skip triage`);
        continue;
      }

      const pendingCount = await prisma.tradeSignal.count({
        where: { portfolioId: portfolio.id, status: { in: ['PENDING', 'SNOOZED'] } }
      });

      // ── Haiku triage call ────────────────────────────────────────────────
      lastTriageTime = nowMs; // Set before call to block parallel triggers
      const { shouldRegen, reason } = await triageSignalRegen(
        portfolio, significantMoves, pendingCount
      );

      if (!shouldRegen) {
        logger.info(`[Market Scanner] Portfolio ${portfolio.id}: Haiku says hold — ${reason}`);
        continue;
      }

      logger.info(`[Market Scanner] Portfolio ${portfolio.id}: Haiku says REGEN — ${reason}`);

      // ── Notify user before regenerating ──────────────────────────────────
      const bot = getBot();
      if (bot) {
        const moveText = significantMoves
          .map(m => `${m.symbol} ${m.changePct > 0 ? '📈 +' : '📉 '}${m.changePct.toFixed(1)}%`)
          .join(', ');
        await bot.sendMessage(
          parseInt(telegramUser.telegramId),
          `🔄 *Market Move — Refreshing Signals*\n${moveText}\n\n_${reason}_\n\nGenerating fresh signals...`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }

      // ── Expire stale signals and regenerate with Sonnet ───────────────────
      await expireOldSignals();
      const newSignals = await generateTradeSignals(
        portfolio.id,
        `⚡ INTRADAY ALERT: ${reason} (moves: ${moveLog})`
      );

      marketRegenCountToday++;
      logger.info(`[Market Scanner] Portfolio ${portfolio.id}: ${newSignals.length} fresh signals generated (market regen ${marketRegenCountToday}/${MAX_MARKET_REGENS} today)`);

    } catch (err) {
      logger.error(`[Market Scanner] Triage/regen error for portfolio ${portfolio.id}:`, err.message);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

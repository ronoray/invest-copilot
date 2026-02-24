import prisma from '../services/prisma.js';
import { getCurrentPrice, getWatchlistSignals } from '../services/marketData.js';
import { triageSignalRegen } from '../services/signalTriage.js';
import { generateTradeSignals, expireOldSignals } from '../services/signalGenerator.js';
import { getBot } from '../services/telegramBot.js';
import { isTradingDay } from '../utils/marketHolidays.js';
import logger from '../services/logger.js';

// ─── Daily price snapshot ─────────────────────────────────────────────────────
// Prices captured on the first market scan of each day (after 9:15 AM).
// Used as baseline to detect intraday moves that may invalidate signals.
const dailyOpenPrices = new Map(); // symbol → price at first scan today
let dailyOpenDate = null;          // 'YYYY-MM-DD' IST — prevents re-init on same day

// ─── Triage rate limits ───────────────────────────────────────────────────────
// Keep Claude API costs minimal: Haiku is cheap but still gated by cooldowns.
// Max 2 market-triggered Sonnet regens per day (morning + midday are separate).
let lastTriageTime = 0;          // ms timestamp of last Haiku triage call
let marketRegenCountToday = 0;   // Sonnet regens triggered by price moves today
let marketRegenDate = null;      // 'YYYY-MM-DD' IST for the counter above

const MOVE_THRESHOLD_PCT    = 3;                  // % from open to flag a move
const TRIAGE_COOLDOWN_MS    = 90 * 60 * 1000;     // 90 min between Haiku calls
const MAX_MARKET_REGENS     = 2;                   // Sonnet regens/day via this path
const TRIAGE_WINDOW_START   = 10;                  // Don't triage before 10 AM IST
const TRIAGE_WINDOW_END     = 14;                  // Don't triage after 2 PM IST
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

  // ── Detect significant moves ───────────────────────────────────────────────
  const significantMoves = [];
  for (const { symbol, price } of updatedPrices) {
    const openPrice = dailyOpenPrices.get(symbol);
    if (!openPrice) continue;
    const changePct = ((price - openPrice) / openPrice) * 100;
    if (Math.abs(changePct) >= MOVE_THRESHOLD_PCT) {
      significantMoves.push({ symbol, prevPrice: openPrice, currentPrice: price, changePct });
    }
  }

  if (significantMoves.length === 0) return;

  const moveLog = significantMoves.map(m =>
    `${m.symbol} ${m.changePct > 0 ? '+' : ''}${m.changePct.toFixed(1)}%`
  ).join(', ');
  logger.info(`[Market Scanner] Significant moves detected: ${moveLog}`);

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

/**
 * priceGuard.js — Real-time stop-loss and profit-taking monitor.
 *
 * Runs every 5 minutes during market hours (9:00 AM – 3:30 PM IST).
 *
 * Three triggers — all generate SELL signals immediately without waiting for Claude:
 *   1. STOP-LOSS:      ltp ≤ holding.stopLoss (or default 8% below avg)   → MARKET SELL
 *   2. PROFIT TARGET:  ltp ≥ avg × (1 + profitTargetPct)                  → LIMIT SELL, full qty
 *   3. PARTIAL PROFIT: ltp ≥ avg × (1 + profitTargetPct × 0.75)           → LIMIT SELL, 50% qty
 *
 * On trigger:
 *   - SELL signal created in DB (PENDING status, expires end of day)
 *   - Immediate Telegram alert sent (plain text, urgent tone)
 *   - Within ≤5 min, notifyPendingSignals sends the signal card with Execute button
 */

import prisma from '../services/prisma.js';
import { getUpstoxLTP } from '../services/upstoxMarketData.js';
import { isTradingDay } from '../utils/marketHolidays.js';
import logger from '../services/logger.js';

// Default stop: 8% below entry price when no explicit stopLoss is set on the Holding.
// Tighter default (6%) applies to broad-market ETFs (NIFTYBEES, BANKBEES, etc.)
// since they track indices and tend to recover faster than individual stocks.
const DEFAULT_STOP_PCT_ETF   = 0.06;
const DEFAULT_STOP_PCT_STOCK = 0.08;

const isEtf = (symbol) => symbol.endsWith('BEES') || symbol.endsWith('ETF');

/**
 * Build an end-of-day expiry timestamp (3:30 PM IST = 10:00 UTC).
 */
function buildExpiresAt() {
  const t = new Date();
  t.setUTCHours(10, 0, 0, 0);
  if (t <= new Date()) t.setDate(t.getDate() + 1);
  return t;
}

/**
 * Create a SELL signal in the DB.
 */
async function createSellSignal({ portfolioId, symbol, exchange, quantity, triggerType, triggerPrice, confidence, rationale }) {
  try {
    const signal = await prisma.tradeSignal.create({
      data: {
        portfolioId,
        symbol,
        exchange: exchange || 'NSE',
        side: 'SELL',
        quantity: Math.max(1, quantity),
        triggerType,
        triggerPrice: triggerPrice || null,
        confidence,
        rationale,
        status: 'PENDING',
        expiresAt: buildExpiresAt()
      }
    });
    logger.info(`[PriceGuard] SELL #${signal.id} created: ${symbol} ${quantity}x ${triggerType}${triggerPrice ? ` @ ₹${triggerPrice}` : ''}`);
    return signal;
  } catch (e) {
    logger.error(`[PriceGuard] createSellSignal failed for ${symbol}: ${e.message}`);
    return null;
  }
}

/**
 * Send an immediate Telegram alert for a price trigger.
 * The signal card with Execute button follows within ≤5 min via notifyPendingSignals.
 */
async function sendAlert(chatId, { symbol, holding, ltp, type, pnlPct, pnlAmt, stopLevel, targetLevel }) {
  try {
    const { getBot } = await import('../services/telegramBot.js');
    const bot = getBot();
    if (!bot) return;

    const configs = {
      STOP_LOSS: {
        emoji: '🛑',
        header: 'STOP-LOSS TRIGGERED',
        note: `Stop level: ₹${stopLevel.toFixed(2)}\n_SELL signal ready — tap Execute to exit now._`
      },
      PROFIT_TARGET: {
        emoji: '🎯',
        header: 'PROFIT TARGET HIT',
        note: `Target: ₹${targetLevel.toFixed(2)}\n_Full SELL signal ready — lock in the gain._`
      },
      PARTIAL_PROFIT: {
        emoji: '💰',
        header: 'PARTIAL PROFIT OPPORTUNITY',
        note: `Target: ₹${targetLevel.toFixed(2)}\n_50% SELL signal ready — book half, let the rest ride._`
      }
    };

    const cfg = configs[type];
    const sign = pnlPct >= 0 ? '+' : '−';
    const absAmt = Math.abs(pnlAmt).toFixed(0);
    const absPct = Math.abs(pnlPct * 100).toFixed(1);

    await bot.sendMessage(
      chatId,
      `${cfg.emoji} *${cfg.header}*\n\n` +
      `*${symbol}* — ${holding.quantity} shares\n` +
      `Avg ₹${parseFloat(holding.avgPrice).toFixed(2)}  →  Now ₹${ltp.toFixed(2)}\n` +
      `P&L: ${sign}₹${absAmt} (${sign}${absPct}%)\n\n` +
      cfg.note,
      { parse_mode: 'Markdown' }
    ).catch(e => logger.warn(`[PriceGuard] Telegram alert failed for ${symbol}: ${e.message}`));
  } catch (e) {
    logger.warn(`[PriceGuard] sendAlert error: ${e.message}`);
  }
}

/**
 * Main price guard — checks all holdings every 5 minutes.
 */
export async function runPriceGuard() {
  if (!isTradingDay(new Date())) return;

  try {
    const portfolios = await prisma.portfolio.findMany({
      where: { isActive: true, isPaused: false },
      include: {
        holdings: true,
        user: { include: { telegramUser: true } }
      }
    });

    const eligible = portfolios.filter(p =>
      p.holdings?.length > 0 &&
      p.user?.telegramUser?.isActive &&
      !p.user?.telegramUser?.isMuted
    );

    if (eligible.length === 0) return;

    // Batch-fetch live LTP for every held symbol in one call
    const allSymbols = [...new Set(eligible.flatMap(p => p.holdings.map(h => h.symbol)))];
    if (allSymbols.length === 0) return;

    let ltpMap = new Map();
    try {
      ltpMap = await getUpstoxLTP(allSymbols);
    } catch (e) {
      logger.warn(`[PriceGuard] LTP batch fetch failed: ${e.message}`);
      return;
    }

    if (ltpMap.size === 0) {
      logger.warn('[PriceGuard] LTP returned empty — skipping');
      return;
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);

    for (const portfolio of eligible) {
      const profitTargetPct = parseFloat(portfolio.profitTargetPct || 10) / 100;
      const chatId = parseInt(portfolio.user.telegramUser.telegramId);
      const tgUserId = portfolio.user.telegramUser.id;

      for (const holding of portfolio.holdings) {
        const ltp = ltpMap.get(holding.symbol)?.price;
        if (!ltp || ltp <= 0) continue;

        const avgPrice = parseFloat(holding.avgPrice);
        if (!avgPrice || avgPrice <= 0) continue;

        const pnlPct = (ltp - avgPrice) / avgPrice;
        const pnlAmt = (ltp - avgPrice) * holding.quantity;

        // Effective stop level
        const defaultStopPct = isEtf(holding.symbol) ? DEFAULT_STOP_PCT_ETF : DEFAULT_STOP_PCT_STOCK;
        const stopLevel = holding.stopLoss
          ? parseFloat(holding.stopLoss)
          : parseFloat((avgPrice * (1 - defaultStopPct)).toFixed(2));

        // Profit levels
        const profitTarget   = avgPrice * (1 + profitTargetPct);
        const partialTrigger = avgPrice * (1 + profitTargetPct * 0.75);

        // Skip if SELL signal already active for this holding
        const existingSell = await prisma.tradeSignal.findFirst({
          where: {
            portfolioId: portfolio.id,
            symbol: holding.symbol,
            side: 'SELL',
            status: { in: ['PENDING', 'ACKED', 'SNOOZED', 'PLACING', 'EXECUTING'] }
          }
        });
        if (existingSell) continue;

        // ── 1. STOP-LOSS ──────────────────────────────────────────────────────
        if (ltp <= stopLevel) {
          logger.warn(`[PriceGuard] STOP-LOSS: ${holding.symbol} ₹${ltp.toFixed(2)} ≤ stop ₹${stopLevel.toFixed(2)} (${(pnlPct * 100).toFixed(1)}%)`);

          await createSellSignal({
            portfolioId: portfolio.id,
            symbol: holding.symbol,
            exchange: holding.exchange,
            quantity: holding.quantity,
            triggerType: 'MARKET',
            triggerPrice: null,
            confidence: 95,
            rationale: `Stop-loss triggered. ${holding.symbol} has fallen to ₹${ltp.toFixed(2)}, breaching the stop at ₹${stopLevel.toFixed(2)} — a ${Math.abs(pnlPct * 100).toFixed(1)}% loss from your avg ₹${avgPrice.toFixed(2)}. Exit at market immediately. Capital protection comes before everything. Every rupee saved now is a rupee available for the next setup.`
          });

          await sendAlert(chatId, { symbol: holding.symbol, holding, ltp, type: 'STOP_LOSS', pnlPct, pnlAmt, stopLevel, targetLevel: profitTarget });
          continue;
        }

        // ── 2. FULL PROFIT TARGET ─────────────────────────────────────────────
        if (ltp >= profitTarget) {
          logger.info(`[PriceGuard] PROFIT TARGET: ${holding.symbol} ₹${ltp.toFixed(2)} ≥ ₹${profitTarget.toFixed(2)} (+${(pnlPct * 100).toFixed(1)}%)`);

          await createSellSignal({
            portfolioId: portfolio.id,
            symbol: holding.symbol,
            exchange: holding.exchange,
            quantity: holding.quantity,
            triggerType: 'LIMIT',
            triggerPrice: parseFloat((ltp * 0.998).toFixed(2)), // 0.2% below LTP for quick fill
            confidence: 90,
            rationale: `Profit target reached. ${holding.symbol} is up ${(pnlPct * 100).toFixed(1)}% — ₹${pnlAmt.toFixed(0)} gain on ${holding.quantity} shares. Your ${(profitTargetPct * 100).toFixed(0)}% target has been hit. Book it. A realised profit compounds; an unrealised one can evaporate on the next macro shock. Redeploy into the next setup.`
          });

          await sendAlert(chatId, { symbol: holding.symbol, holding, ltp, type: 'PROFIT_TARGET', pnlPct, pnlAmt, stopLevel, targetLevel: profitTarget });
          continue;
        }

        // ── 3. PARTIAL PROFIT (75% of target) ────────────────────────────────
        if (ltp >= partialTrigger) {
          // One alert per day per symbol per portfolio (don't spam every 5 min)
          const alreadyAlerted = await prisma.alertHistory.count({
            where: {
              telegramUserId: tgUserId,
              alertType: 'PARTIAL_PROFIT',
              symbol: holding.symbol,
              createdAt: { gte: today }
            }
          });
          if (alreadyAlerted > 0) continue;

          const partialQty = Math.max(1, Math.floor(holding.quantity / 2));
          const halfGain = (ltp - avgPrice) * partialQty;

          logger.info(`[PriceGuard] PARTIAL PROFIT: ${holding.symbol} ₹${ltp.toFixed(2)} at ${(pnlPct * 100).toFixed(1)}% — selling half (${partialQty} of ${holding.quantity})`);

          await createSellSignal({
            portfolioId: portfolio.id,
            symbol: holding.symbol,
            exchange: holding.exchange,
            quantity: partialQty,
            triggerType: 'LIMIT',
            triggerPrice: parseFloat((ltp * 0.998).toFixed(2)),
            confidence: 78,
            rationale: `Partial profit — ${holding.symbol} is up ${(pnlPct * 100).toFixed(1)}% (${(profitTargetPct * 75).toFixed(0)}% of your ${(profitTargetPct * 100).toFixed(0)}% target). Selling half (${partialQty} shares, ₹${halfGain.toFixed(0)} gain) locks in real money while the remaining ${holding.quantity - partialQty} shares ride for the full target. Risk-free from here on the booked portion.`
          });

          await prisma.alertHistory.create({
            data: {
              telegramUserId: tgUserId,
              alertType: 'PARTIAL_PROFIT',
              symbol: holding.symbol,
              price: ltp,
              message: `Partial profit: ${holding.symbol} at ₹${ltp.toFixed(2)} (+${(pnlPct * 100).toFixed(1)}%)`,
              sent: true
            }
          });

          await sendAlert(chatId, { symbol: holding.symbol, holding, ltp, type: 'PARTIAL_PROFIT', pnlPct, pnlAmt, stopLevel, targetLevel: profitTarget });
        }
      }
    }
  } catch (error) {
    logger.error('[PriceGuard] runPriceGuard error:', error.message);
    if (error.stack) logger.error(error.stack.slice(0, 400));
  }
}

export default { runPriceGuard };

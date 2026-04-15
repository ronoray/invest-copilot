/**
 * priceGuard.js — Real-time stop-loss, trailing stop, and profit-taking monitor.
 *
 * Runs every 5 minutes during market hours (9:00 AM – 3:30 PM IST).
 *
 * Four operations per holding (in order):
 *   0. TRAILING STOP: if ltp has risen, advance stopLoss upward (never downward)
 *      - Activates once position is +3% profitable (stocks) or +2% (ETFs)
 *      - Trails 4% behind LTP (stocks) or 3% (ETFs)
 *      - Milestone alerts: when stop crosses avg (break-even) and avg×1.05 (5% locked)
 *   1. STOP-LOSS:     ltp ≤ holding.stopLoss   → MARKET SELL, full qty
 *   2. PROFIT TARGET: ltp ≥ avg × (1 + targetPct) → LIMIT SELL, full qty
 *   3. PARTIAL PROFIT: ltp ≥ avg × (1 + targetPct×0.75) → LIMIT SELL, 50% qty (once/day)
 *
 * On trigger (1-3):
 *   - SELL signal created in DB (PENDING status, expires end of day)
 *   - Immediate Telegram alert sent
 *   - Within ≤5 min, notifyPendingSignals sends the signal card with Execute button
 */

import prisma from '../services/prisma.js';
import { getUpstoxLTP } from '../services/upstoxMarketData.js';
import { isTradingDay, getISTMidnight } from '../utils/marketHolidays.js';
import logger from '../services/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Default stop: X% below avg when no explicit stopLoss is set on the Holding.
const DEFAULT_STOP_PCT_ETF   = 0.05;   // 5% — tightened to cut losses faster
const DEFAULT_STOP_PCT_STOCK = 0.06;   // 6% — tightened from 8%; accept smaller losses

// Trailing stop: trails X% behind LTP once position becomes profitable.
// Rule: stop ONLY moves up (ratchet). Never moves down.
const TRAIL_PCT_ETF   = 0.025;  // trail 2.5% below LTP for ETFs (tightened from 3%)
const TRAIL_PCT_STOCK = 0.03;   // trail 3% below LTP for stocks (tightened from 4%)

// Trailing activates once position is this profitable.
// Below threshold: fixed stop at DEFAULT_STOP_PCT applies.
const TRAIL_ACTIVATE_ETF   = 0.015; // +1.5% profit → start trailing (was 2%)
const TRAIL_ACTIVATE_STOCK = 0.02;  // +2% profit → start trailing (was 3%)

// Minimum stop improvement (as % of avgPrice) before updating DB + alerting.
// Prevents DB writes + Telegram noise on tiny ₹0.01 moves.
const TRAIL_MIN_STEP_PCT = 0.005; // 0.5% of avgPrice

const isEtf = (symbol) => symbol.endsWith('BEES') || symbol.endsWith('ETF');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildExpiresAt() {
  const t = new Date();
  t.setUTCHours(10, 0, 0, 0); // 3:30 PM IST = 10:00 UTC
  if (t <= new Date()) t.setDate(t.getDate() + 1);
  return t;
}

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

async function getBot() {
  const { getBot: _getBot } = await import('../services/telegramBot.js');
  return _getBot();
}

async function sendAlert(chatId, { symbol, holding, ltp, type, pnlPct, pnlAmt, stopLevel, targetLevel }) {
  try {
    const bot = await getBot();
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
 * Send a milestone alert when the trailing stop crosses a meaningful threshold.
 * Uses AlertHistory to fire each milestone only once per symbol per day.
 *
 * Milestones:
 *   TRAIL_BREAKEVEN — stop just crossed above avgPrice (you cannot lose on this trade)
 *   TRAIL_5PCT      — stop just crossed above avgPrice × 1.05 (5% profit locked in)
 */
async function sendTrailMilestoneAlert(chatId, tgUserId, { symbol, avgPrice, newStop, ltp, pnlPct, milestone }) {
  try {
    const today = getISTMidnight();
    const alreadySent = await prisma.alertHistory.count({
      where: { telegramUserId: tgUserId, alertType: milestone, symbol, createdAt: { gte: today } }
    });
    if (alreadySent > 0) return;

    await prisma.alertHistory.create({
      data: {
        telegramUserId: tgUserId,
        alertType: milestone,
        symbol,
        price: newStop,
        message: `Trail milestone ${milestone}: ${symbol} stop ₹${newStop.toFixed(2)}`,
        sent: true
      }
    });

    const bot = await getBot();
    if (!bot) return;

    const msgs = {
      TRAIL_BREAKEVEN: {
        emoji: '🔒',
        header: 'BREAK-EVEN FLOOR LOCKED',
        body: `Stop is now ₹${newStop.toFixed(2)} — *above your entry* (avg ₹${avgPrice.toFixed(2)}).\n\nThis trade *cannot lose money* unless you ignore the stop. The floor has been secured. Hold for the target or let the trail carry you higher.`
      },
      TRAIL_5PCT: {
        emoji: '💎',
        header: '5% PROFIT LOCKED IN',
        body: `Stop is now ₹${newStop.toFixed(2)} — guaranteeing at least *+5% profit* even if the market reverses.\n\nCurrent gain: +${(pnlPct * 100).toFixed(1)}%. The trailing stop will keep climbing as long as price does.`
      }
    };

    const m = msgs[milestone];
    if (!m) return;

    await bot.sendMessage(
      chatId,
      `${m.emoji} *${symbol} — ${m.header}*\n\n${m.body}`,
      { parse_mode: 'Markdown' }
    ).catch(e => logger.warn(`[PriceGuard] Trail milestone alert failed for ${symbol}: ${e.message}`));
  } catch (e) {
    logger.warn(`[PriceGuard] sendTrailMilestoneAlert error: ${e.message}`);
  }
}

/**
 * Send the execute signal card immediately after priceGuard creates a SELL signal.
 * This avoids the ≤5 min lag before notifyPendingSignals picks it up.
 * Updates lastNotifiedAt so notifyPendingSignals won't re-send for 30 min.
 */
async function sendImmediateSignalCard(signal, { portfolio, holding, ltp, pnlPct, pnlAmt }) {
  try {
    const bot = await getBot();
    if (!bot) return;

    const telegramUser = portfolio.user?.telegramUser;
    if (!telegramUser) return;

    const chatId = parseInt(telegramUser.telegramId);
    const upstoxIntegration = portfolio.user?.upstoxIntegration;
    const hasUpstox = portfolio.broker === 'UPSTOX' && upstoxIntegration?.isConnected && upstoxIntegration?.accessToken;

    const sign = pnlPct >= 0 ? '+' : '−';
    const absPct = Math.abs(pnlPct * 100).toFixed(1);
    const absAmt = Math.abs(pnlAmt).toFixed(0);

    let priceInfo = signal.triggerType === 'MARKET' ? 'At Market Price' : `Limit: ₹${signal.triggerPrice}`;
    let actionGuide = signal.triggerType === 'MARKET'
      ? `\n👉 *What to do:* Tap *Execute* to *SELL IMMEDIATELY* at market price.\n_Stop-loss — act quickly._`
      : `\n👉 *What to do:* Tap *Execute* to place a LIMIT SELL at ₹${parseFloat(signal.triggerPrice).toFixed(2)}.\n_Fills automatically when price reaches that level. Or tap Dismiss to keep holding._`;

    const msgText =
      `🔴 *SELL: ${signal.symbol}* (${signal.exchange})\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `Qty: *${signal.quantity} shares* | ${priceInfo}\n` +
      `📍 Now: ₹${ltp.toFixed(2)}  _(${sign}${absPct}%, ${sign}₹${absAmt})_` +
      actionGuide + `\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `_${signal.rationale || ''}_`;

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

    await bot.sendMessage(chatId, msgText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [buttons] }
    }).catch(e => logger.warn(`[PriceGuard] sendImmediateSignalCard failed for ${signal.symbol}: ${e.message}`));

    // Mark notified so notifyPendingSignals won't re-fire for 30 min
    await prisma.tradeSignal.update({
      where: { id: signal.id },
      data: { lastNotifiedAt: new Date(), notifyCount: 1 }
    });

    logger.info(`[PriceGuard] Immediate signal card sent: #${signal.id} ${signal.symbol} to ${chatId}`);
  } catch (e) {
    logger.warn(`[PriceGuard] sendImmediateSignalCard error: ${e.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

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
        user: { include: { telegramUser: true, upstoxIntegration: true } }
      }
    });

    const eligible = portfolios.filter(p =>
      p.holdings?.length > 0 &&
      p.user?.telegramUser?.isActive &&
      !p.user?.telegramUser?.isMuted
    );

    if (eligible.length === 0) return;

    // Batch-fetch live LTP for every held symbol in one API call
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

    const today = getISTMidnight();

    for (const portfolio of eligible) {
      const profitTargetPct = parseFloat(portfolio.profitTargetPct || 10) / 100;
      const chatId   = parseInt(portfolio.user.telegramUser.telegramId);
      const tgUserId = portfolio.user.telegramUser.id;

      for (const holding of portfolio.holdings) {
        const ltp = ltpMap.get(holding.symbol)?.price;
        if (!ltp || ltp <= 0) continue;

        const avgPrice = parseFloat(holding.avgPrice);
        if (!avgPrice || avgPrice <= 0) continue;

        const pnlPct = (ltp - avgPrice) / avgPrice;
        const pnlAmt = (ltp - avgPrice) * holding.quantity;

        const etf            = isEtf(holding.symbol);
        const defaultStopPct = etf ? DEFAULT_STOP_PCT_ETF : DEFAULT_STOP_PCT_STOCK;
        const trailActivate  = etf ? TRAIL_ACTIVATE_ETF   : TRAIL_ACTIVATE_STOCK;
        const trailPct       = etf ? TRAIL_PCT_ETF        : TRAIL_PCT_STOCK;

        // Current effective stop (DB value, or default if not set)
        let stopLevel = holding.stopLoss
          ? parseFloat(holding.stopLoss)
          : parseFloat((avgPrice * (1 - defaultStopPct)).toFixed(2));

        // ── 0. TRAILING STOP — ratchet the floor upward as price rises ─────────
        if (pnlPct >= trailActivate) {
          const newTrailingStop = parseFloat((ltp * (1 - trailPct)).toFixed(2));
          const minStep         = avgPrice * TRAIL_MIN_STEP_PCT;

          if (newTrailingStop > stopLevel + minStep) {
            const oldStop = stopLevel;
            stopLevel = newTrailingStop; // use updated stop for checks below

            await prisma.holding.update({
              where: { id: holding.id },
              data: { stopLoss: newTrailingStop }
            });

            logger.info(`[PriceGuard] TRAIL: ${holding.symbol} stop ₹${oldStop.toFixed(2)} → ₹${newTrailingStop.toFixed(2)} (LTP ₹${ltp.toFixed(2)}, +${(pnlPct * 100).toFixed(1)}%)`);

            // Milestone: stop just crossed above entry → break-even guaranteed
            if (newTrailingStop >= avgPrice && oldStop < avgPrice) {
              await sendTrailMilestoneAlert(chatId, tgUserId, {
                symbol: holding.symbol, avgPrice, newStop: newTrailingStop, ltp, pnlPct,
                milestone: 'TRAIL_BREAKEVEN'
              });
            }
            // Milestone: stop just crossed above entry + 5% → 5% profit guaranteed
            else if (newTrailingStop >= avgPrice * 1.05 && oldStop < avgPrice * 1.05) {
              await sendTrailMilestoneAlert(chatId, tgUserId, {
                symbol: holding.symbol, avgPrice, newStop: newTrailingStop, ltp, pnlPct,
                milestone: 'TRAIL_5PCT'
              });
            }
          }
        }

        // Skip SELL signal checks if one is already active for this holding
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
          const stopSrc = holding.stopLoss ? 'trailing' : 'default';
          logger.warn(`[PriceGuard] STOP-LOSS (${stopSrc}): ${holding.symbol} ₹${ltp.toFixed(2)} ≤ stop ₹${stopLevel.toFixed(2)} (${(pnlPct * 100).toFixed(1)}%)`);

          // Stop-loss: MARKET order — exit immediately, price doesn't matter
          const stopSignal = await createSellSignal({
            portfolioId: portfolio.id,
            symbol: holding.symbol,
            exchange: holding.exchange,
            quantity: holding.quantity,
            triggerType: 'MARKET',
            triggerPrice: null,
            confidence: 95,
            rationale: `Stop-loss triggered (${stopSrc} stop). ${holding.symbol} at ₹${ltp.toFixed(2)}, breached stop ₹${stopLevel.toFixed(2)} (${Math.abs(pnlPct * 100).toFixed(1)}% from avg ₹${avgPrice.toFixed(2)}). MARKET exit — price is irrelevant, capital protection is everything. Every rupee saved now compounds into the next setup.`
          });

          if (stopSignal) await sendImmediateSignalCard(stopSignal, { portfolio, holding, ltp, pnlPct, pnlAmt });
          continue;
        }

        // Profit levels
        const profitTarget   = avgPrice * (1 + profitTargetPct);
        const partialTrigger = avgPrice * (1 + profitTargetPct * 0.75);

        // ── 2. FULL PROFIT TARGET ─────────────────────────────────────────────
        if (ltp >= profitTarget) {
          logger.info(`[PriceGuard] PROFIT TARGET: ${holding.symbol} ₹${ltp.toFixed(2)} ≥ ₹${profitTarget.toFixed(2)} (+${(pnlPct * 100).toFixed(1)}%)`);

          // Profit target: LIMIT at current price (not target) — locks in what's available now
          const sellPrice = parseFloat((ltp * 0.998).toFixed(2)); // 0.2% below LTP for quick fill
          const profitSignal = await createSellSignal({
            portfolioId: portfolio.id,
            symbol: holding.symbol,
            exchange: holding.exchange,
            quantity: holding.quantity,
            triggerType: 'LIMIT',
            triggerPrice: sellPrice,
            confidence: 90,
            rationale: `Profit target hit. ${holding.symbol} at ₹${ltp.toFixed(2)} (+${(pnlPct * 100).toFixed(1)}%, ₹${pnlAmt.toFixed(0)} gain). LIMIT sell at ₹${sellPrice.toFixed(2)} — locks in today's price, not a stale number. Execute now. A realised ₹${pnlAmt.toFixed(0)} compounds. An unrealised gain evaporates on the next shock.`
          });

          if (profitSignal) await sendImmediateSignalCard(profitSignal, { portfolio, holding, ltp, pnlPct, pnlAmt });
          continue;
        }

        // ── 3. PARTIAL PROFIT (75% of target) ────────────────────────────────
        if (ltp >= partialTrigger) {
          // One alert per day per symbol (don't spam every 5 min)
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
          const halfGain   = (ltp - avgPrice) * partialQty;

          logger.info(`[PriceGuard] PARTIAL PROFIT: ${holding.symbol} ₹${ltp.toFixed(2)} at ${(pnlPct * 100).toFixed(1)}% — selling half (${partialQty} of ${holding.quantity})`);

          const partialSignal = await createSellSignal({
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

          if (partialSignal) await sendImmediateSignalCard(partialSignal, { portfolio, holding, ltp, pnlPct, pnlAmt });
        }
      }
    }
  } catch (error) {
    logger.error('[PriceGuard] runPriceGuard error:', error.message);
    if (error.stack) logger.error(error.stack.slice(0, 400));
  }
}

export default { runPriceGuard };

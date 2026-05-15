// server/services/capitalGuard.js
// Central capital enforcement — ensures recommendations never exceed portfolio capital.
// "Capital is the mother of all recommendations."

import prisma from './prisma.js';
import logger from './logger.js';
import { getFunds, getHoldings, getPositions, getOrderStatus } from './upstoxService.js';
import { getCurrentPrice } from './marketData.js';
import { getUpstoxLTP } from './upstoxMarketData.js';

/**
 * Get effective cash for a portfolio, accounting for pending signal reservations.
 * Pending/Acked/Snoozed BUY signals reserve cash even before execution.
 *
 * @param {number} portfolioId
 * @param {number|null} excludeSignalId - Optional signal ID to exclude from reserved sum (use when executing that signal)
 * @returns {{ rawCash: number, reservedCash: number, effectiveCash: number }}
 */
export async function getEffectiveCash(portfolioId, excludeSignalId = null) {
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    select: { availableCash: true }
  });

  const rawCash = parseFloat(portfolio?.availableCash || 0);

  // Sum cost of all active BUY signals (PENDING, ACKED, SNOOZED only).
  // PLACING signals are excluded — their cost is already deducted from Upstox's
  // available_margin (which feeds availableCash), so counting them here would
  // double-subtract the same capital and push effectiveCash to ₹0 incorrectly.
  const activeSignals = await prisma.tradeSignal.findMany({
    where: {
      portfolioId,
      side: 'BUY',
      status: { in: ['PENDING', 'ACKED', 'SNOOZED'] },
      ...(excludeSignalId ? { id: { not: excludeSignalId } } : {})
    },
    select: { quantity: true, triggerPrice: true, triggerLow: true, triggerHigh: true }
  });

  const reservedCash = activeSignals.reduce((sum, sig) => {
    // For LIMIT/ZONE: use trigger price. For MARKET: triggerHigh may hold a live-price anchor
    // set during execution validation. Fall through to 0 if unavailable — acceptable for now
    // since MARKET signals are high-confidence and execute quickly.
    const price = parseFloat(sig.triggerPrice || sig.triggerLow || sig.triggerHigh || 0);
    return sum + (sig.quantity * price);
  }, 0);

  const effectiveCash = Math.max(0, rawCash - reservedCash);

  logger.info(`[Capital Guard] Portfolio ${portfolioId}: raw=₹${rawCash.toFixed(0)}, reserved=₹${reservedCash.toFixed(0)}, effective=₹${effectiveCash.toFixed(0)}`);

  return { rawCash, reservedCash, effectiveCash };
}

/**
 * Validate AI-generated trade signals against available capital.
 * BUY signals are sorted by confidence (highest first — best signals get funded).
 * Over-budget signals get quantity reduced or dropped entirely.
 * SELL signals are validated against holding quantity.
 *
 * @param {Array} signals - Array of signal objects from AI
 * @param {number} portfolioId
 * @returns {Array} Validated signals (may be fewer or with reduced quantities)
 */
export async function validateSignals(signals, portfolioId) {
  if (!signals || signals.length === 0) return [];

  const { effectiveCash } = await getEffectiveCash(portfolioId);

  // Fetch portfolio for concentration cap
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    select: { startingCapital: true }
  });
  const startingCapital = parseFloat(portfolio?.startingCapital || 20000);
  const MAX_STOCK_ALLOCATION = startingCapital * 0.25; // 25% of starting capital per stock

  // Fetch holdings for SELL validation and concentration check
  const holdings = await prisma.holding.findMany({
    where: { portfolioId },
    select: { symbol: true, quantity: true, avgPrice: true, currentPrice: true }
  });
  const holdingMap = {};
  const holdingValueMap = {}; // existing market value per symbol
  for (const h of holdings) {
    holdingMap[h.symbol] = h.quantity;
    const hPrice = parseFloat(h.currentPrice || h.avgPrice || 0);
    holdingValueMap[h.symbol] = h.quantity * hPrice;
  }

  const validated = [];
  let remainingCash = effectiveCash;

  // Separate BUY and SELL signals
  const buySignals = signals.filter(s => s.side === 'BUY');
  const sellSignals = signals.filter(s => s.side === 'SELL');

  // Sort BUY signals by confidence descending (best signals get funded first)
  buySignals.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  // Batch-fetch Upstox LTP for all BUY symbols (single API call, real-time)
  const buySymbols = buySignals.map(s => s.symbol);
  let upstoxLTPMap = new Map();
  try {
    if (buySymbols.length > 0) {
      upstoxLTPMap = await getUpstoxLTP(buySymbols);
    }
  } catch (e) {
    logger.warn(`[Capital Guard] Upstox batch LTP failed: ${e.message}`);
  }

  // Validate BUY signals against remaining cash
  for (const sig of buySignals) {
    let aiPrice = parseFloat(sig.triggerPrice || sig.triggerLow || sig.price || 0);

    // Primary: Upstox real-time LTP. Secondary: Alpha Vantage / NSE scraper.
    let upstoxPrice = upstoxLTPMap.get(sig.symbol)?.price || 0;
    let avPrice = 0;
    if (!upstoxPrice) {
      try {
        const liveData = await getCurrentPrice(sig.symbol, sig.exchange || 'NSE');
        avPrice = parseFloat(liveData?.price || liveData?.lastPrice || 0);
      } catch (e) {
        logger.warn(`[Capital Guard] AV price fetch failed for ${sig.symbol}: ${e.message}`);
      }
    }
    const livePrice = upstoxPrice || avPrice;

    // Determine price to use for capital check
    let price = 0;

    if (upstoxPrice > 0 && aiPrice > 0) {
      // Upstox is real-time — always trust it over AI training data
      const deviation = Math.abs(aiPrice - upstoxPrice) / upstoxPrice * 100;
      if (deviation > 20) {
        logger.warn(`[Capital Guard] ${sig.symbol}: Upstox ₹${upstoxPrice.toFixed(0)} vs AI ₹${aiPrice.toFixed(0)} (${deviation.toFixed(0)}% deviation — AI price is stale, using Upstox LTP)`);
        price = upstoxPrice;
        // Also correct the signal price so DB stores the real value
        sig.price = upstoxPrice;
        if (sig.triggerPrice) sig.triggerPrice = parseFloat((upstoxPrice * 0.999).toFixed(2));
      } else {
        price = upstoxPrice;
      }
    } else if (livePrice > 0 && aiPrice > 0) {
      // Alpha Vantage can be stale — only use if within 40% of AI estimate
      const deviation = Math.abs(aiPrice - livePrice) / livePrice * 100;
      if (deviation > 40) {
        logger.warn(`[Capital Guard] ${sig.symbol}: AV ₹${livePrice.toFixed(0)} vs AI ₹${aiPrice.toFixed(0)} (${deviation.toFixed(0)}% — AV may be stale, using AI price)`);
        price = aiPrice;
      } else {
        price = livePrice;
      }
    } else if (livePrice > 0) {
      // MARKET order or no AI price — use live price
      price = livePrice;
      logger.info(`[Capital Guard] MARKET order ${sig.symbol}: using live ₹${price.toFixed(2)} for validation`);
    } else if (aiPrice > 0) {
      // Live fetch failed — fall back to AI price but log a warning
      price = aiPrice;
      logger.warn(`[Capital Guard] ${sig.symbol}: live price unavailable, using AI estimate ₹${price.toFixed(0)} (unverified)`);
    } else {
      // No price at all — drop signal
      logger.warn(`[Capital Guard] BUY ${sig.symbol}: DROPPED — no price available for capital check`);
      continue;
    }

    let quantity = Math.max(1, parseInt(sig.quantity) || 1);

    // Per-stock concentration cap: existing holding value + new position <= 25% of startingCapital.
    // Prevents the PFC-style disaster (77% of capital in one stock from two same-day BUYs).
    const existingValue = holdingValueMap[sig.symbol] || 0;
    const newCost = quantity * price;
    if (existingValue + newCost > MAX_STOCK_ALLOCATION) {
      const headroom = Math.max(0, MAX_STOCK_ALLOCATION - existingValue);
      if (headroom < 2500) {
        logger.warn(`[Capital Guard] BUY ${sig.symbol}: DROPPED — concentration cap hit (existing ₹${existingValue.toFixed(0)} + new ₹${newCost.toFixed(0)} > 25% limit ₹${MAX_STOCK_ALLOCATION.toFixed(0)})`);
        continue;
      }
      const cappedQty = Math.floor(headroom / price);
      logger.warn(`[Capital Guard] BUY ${sig.symbol}: qty capped ${quantity}→${cappedQty} (concentration cap: ₹${MAX_STOCK_ALLOCATION.toFixed(0)} max per stock)`);
      sig.quantity = cappedQty;
      quantity = cappedQty;
    }

    const totalCost = quantity * price;

    if (totalCost <= remainingCash) {
      // Fits within budget
      validated.push(sig);
      remainingCash -= totalCost;
      logger.info(`[Capital Guard] BUY ${sig.symbol}: ${quantity}x₹${price.toFixed(0)} = ₹${totalCost.toFixed(0)} — APPROVED (remaining: ₹${remainingCash.toFixed(0)})`);
    } else if (remainingCash >= price) {
      // Can afford fewer shares — reduce quantity
      const affordableQty = Math.floor(remainingCash / price);
      const reducedCost = affordableQty * price;
      // Minimum viable position: ₹2,500. Below this, STT + friction erode any gain.
      // At ₹20k capital, ₹2,500 = 12.5% — the smallest position worth holding.
      if (reducedCost < 2500) {
        logger.warn(`[Capital Guard] BUY ${sig.symbol}: DROPPED — reduced position ₹${reducedCost.toFixed(0)} < ₹2,500 minimum (insufficient capital for meaningful position)`);
        continue;
      }
      sig.quantity = affordableQty;
      validated.push(sig);
      remainingCash -= reducedCost;
      logger.warn(`[Capital Guard] BUY ${sig.symbol}: reduced ${quantity}→${affordableQty} shares (budget: ₹${reducedCost.toFixed(0)}, remaining: ₹${remainingCash.toFixed(0)})`);
    } else {
      // Can't afford even 1 share — drop signal
      logger.warn(`[Capital Guard] BUY ${sig.symbol}: DROPPED — need ₹${price.toFixed(0)} but only ₹${remainingCash.toFixed(0)} left`);
    }
  }

  // Validate SELL signals against holding quantity
  for (const sig of sellSignals) {
    const heldQty = holdingMap[sig.symbol] || 0;
    if (heldQty <= 0) {
      logger.warn(`[Capital Guard] SELL ${sig.symbol}: DROPPED — not in holdings`);
      continue;
    }
    if (sig.quantity > heldQty) {
      sig.quantity = heldQty;
      logger.warn(`[Capital Guard] SELL ${sig.symbol}: reduced to ${heldQty} (max held)`);
    }
    validated.push(sig);
  }

  logger.info(`[Capital Guard] Validated ${validated.length}/${signals.length} signals (${buySignals.length} BUY, ${sellSignals.length} SELL)`);
  return validated;
}

/**
 * Validate allocation amounts against a budget.
 * If total exceeds budget, scale down proportionally.
 * Used by advancedScreener and multiAssetRecommendations.
 *
 * @param {Array} items - Array of objects with allocation/suggestedAmount field
 * @param {number} budget - Maximum total allocation
 * @param {string} field - Name of the amount field ('suggestedAmount' or 'allocation')
 * @returns {Array} Items with scaled allocations
 */
export function validateAllocations(items, budget, field = 'suggestedAmount') {
  if (!items || items.length === 0 || budget <= 0) return items || [];

  const total = items.reduce((sum, item) => sum + (parseFloat(item[field]) || 0), 0);

  if (total <= budget) {
    return items; // Within budget
  }

  // Scale down proportionally
  const ratio = budget / total;
  for (const item of items) {
    const original = parseFloat(item[field]) || 0;
    item[field] = Math.round(original * ratio);
  }

  logger.warn(`[Capital Guard] Allocations scaled: ₹${total.toFixed(0)} → ₹${budget.toFixed(0)} (ratio: ${ratio.toFixed(2)})`);
  return items;
}

/**
 * Pre-order capital check — gate before Upstox order placement.
 * For BUY orders: checks quantity * price <= effectiveCash.
 *
 * @param {number} portfolioId
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} quantity
 * @param {number} price - Estimated price (live price for MARKET, limit price for LIMIT)
 * @param {number|null} signalId - Signal being executed; excluded from reserved sum to avoid self-blocking
 * @returns {{ allowed: boolean, reason: string, effectiveCash: number, orderCost: number }}
 */
export async function preOrderCapitalCheck(portfolioId, side, quantity, price, signalId = null) {
  if (side === 'SELL') {
    return { allowed: true, reason: 'SELL orders do not consume cash', effectiveCash: 0, orderCost: 0 };
  }

  const { effectiveCash } = await getEffectiveCash(portfolioId, signalId);
  const orderCost = quantity * price;

  if (orderCost <= effectiveCash) {
    logger.info(`[Capital Guard] Pre-order check PASSED: ₹${orderCost.toFixed(0)} <= ₹${effectiveCash.toFixed(0)}`);
    return { allowed: true, reason: 'Within capital limits', effectiveCash, orderCost };
  }

  logger.warn(`[Capital Guard] Pre-order check FAILED: ₹${orderCost.toFixed(0)} > ₹${effectiveCash.toFixed(0)}`);
  return {
    allowed: false,
    reason: `Order cost ₹${orderCost.toLocaleString('en-IN')} exceeds available cash ₹${effectiveCash.toLocaleString('en-IN')}`,
    effectiveCash,
    orderCost
  };
}

/**
 * Update portfolio cash when an order is confirmed COMPLETE.
 * BUY: availableCash -= filledQuantity * averagePrice
 * SELL: availableCash += filledQuantity * averagePrice
 *
 * @param {number} dbOrderId - The UpstoxOrder record ID
 */
export async function updateCashOnExecution(dbOrderId) {
  try {
    const order = await prisma.upstoxOrder.findUnique({
      where: { id: dbOrderId },
      include: { integration: true }
    });

    if (!order) {
      logger.warn(`[Capital Guard] updateCash: order ${dbOrderId} not found`);
      return;
    }

    const filledQty = order.filledQuantity || order.quantity;
    const avgPrice = parseFloat(order.averagePrice || order.price || 0);

    if (avgPrice <= 0 || filledQty <= 0) {
      logger.warn(`[Capital Guard] updateCash: invalid qty=${filledQty} or price=${avgPrice} for order ${dbOrderId}`);
      return;
    }

    const amount = filledQty * avgPrice;
    const portfolioId = order.portfolioId;

    if (!portfolioId) {
      logger.warn(`[Capital Guard] updateCash: no portfolioId on order ${dbOrderId}`);
      return;
    }

    const side = (order.transactionType || '').toUpperCase();

    if (side === 'BUY') {
      await prisma.portfolio.update({
        where: { id: portfolioId },
        data: { availableCash: { decrement: amount } }
      });
      logger.info(`[Capital Guard] Cash decremented ₹${amount.toFixed(0)} for BUY order ${dbOrderId} (portfolio ${portfolioId})`);
    } else if (side === 'SELL') {
      await prisma.portfolio.update({
        where: { id: portfolioId },
        data: { availableCash: { increment: amount } }
      });
      logger.info(`[Capital Guard] Cash incremented ₹${amount.toFixed(0)} for SELL order ${dbOrderId} (portfolio ${portfolioId})`);
    }
  } catch (error) {
    logger.error(`[Capital Guard] updateCashOnExecution failed for order ${dbOrderId}:`, error.message);
  }
}

/**
 * Upsert holding when an order is confirmed COMPLETE.
 * BUY: create or add to existing holding (weighted avg price).
 * SELL: reduce quantity; delete if 0 remaining.
 *
 * @param {number} dbOrderId - The UpstoxOrder record ID
 */
export async function upsertHoldingOnExecution(dbOrderId) {
  try {
    const order = await prisma.upstoxOrder.findUnique({
      where: { id: dbOrderId }
    });

    if (!order || !order.portfolioId) {
      logger.warn(`[Capital Guard] upsertHolding: order ${dbOrderId} not found or no portfolioId`);
      return;
    }

    const filledQty = order.filledQuantity || order.quantity;
    const avgPrice = parseFloat(order.averagePrice || order.price || 0);
    const side = (order.transactionType || '').toUpperCase();
    // Strip _EQ suffix from exchange (e.g. NSE_EQ → NSE)
    const exchange = (order.exchange || 'NSE').replace(/_EQ$/, '');

    if (avgPrice <= 0 || filledQty <= 0) {
      logger.warn(`[Capital Guard] upsertHolding: invalid qty=${filledQty} or price=${avgPrice} for order ${dbOrderId}`);
      return;
    }

    const existing = await prisma.holding.findUnique({
      where: {
        portfolioId_symbol_exchange: {
          portfolioId: order.portfolioId,
          symbol: order.symbol,
          exchange
        }
      }
    });

    // Auto stop-loss: ETFs (endsWith BEES/ETF) get 6% below avg; stocks get 8% below avg
    const isEtf = order.symbol.endsWith('BEES') || order.symbol.endsWith('ETF');
    const stopPct = isEtf ? 0.06 : 0.08;

    if (side === 'BUY') {
      if (existing) {
        // Weighted average price
        const oldTotal = existing.quantity * parseFloat(existing.avgPrice);
        const newTotal = filledQty * avgPrice;
        const combinedQty = existing.quantity + filledQty;
        const weightedAvg = (oldTotal + newTotal) / combinedQty;
        const newStop = parseFloat((weightedAvg * (1 - stopPct)).toFixed(2));

        await prisma.holding.update({
          where: { id: existing.id },
          data: {
            quantity: combinedQty,
            avgPrice: weightedAvg,
            stopLoss: newStop   // recalculate stop on average-down/up
          }
        });
        logger.info(`[Capital Guard] Holding updated: ${order.symbol} ${existing.quantity}→${combinedQty} @ ₹${weightedAvg.toFixed(2)}, stop=₹${newStop} (portfolio ${order.portfolioId})`);
      } else {
        const autoStop = parseFloat((avgPrice * (1 - stopPct)).toFixed(2));
        await prisma.holding.create({
          data: {
            portfolioId: order.portfolioId,
            symbol: order.symbol,
            exchange,
            quantity: filledQty,
            avgPrice,
            stopLoss: autoStop
          }
        });
        logger.info(`[Capital Guard] Holding created: ${order.symbol} ${filledQty}x @ ₹${avgPrice.toFixed(2)}, stop=₹${autoStop} (${stopPct * 100}% below avg) (portfolio ${order.portfolioId})`);
      }
    } else if (side === 'SELL') {
      if (!existing) {
        logger.warn(`[Capital Guard] upsertHolding: SELL but no existing holding for ${order.symbol} (portfolio ${order.portfolioId})`);
        return;
      }

      const remainingQty = existing.quantity - filledQty;
      if (remainingQty <= 0) {
        await prisma.holding.delete({ where: { id: existing.id } });
        logger.info(`[Capital Guard] Holding deleted: ${order.symbol} fully sold (portfolio ${order.portfolioId})`);
      } else {
        await prisma.holding.update({
          where: { id: existing.id },
          data: { quantity: remainingQty }
        });
        logger.info(`[Capital Guard] Holding reduced: ${order.symbol} ${existing.quantity}→${remainingQty} (portfolio ${order.portfolioId})`);
      }
    }
  } catch (error) {
    logger.error(`[Capital Guard] upsertHoldingOnExecution failed for order ${dbOrderId}:`, error.message);
  }
}

/**
 * Sync Upstox available margin to portfolio.availableCash.
 * Also expires stale PENDING/SNOOZED signals older than 24 hours.
 *
 * @param {number} userId
 * @returns {{ synced: number, availableMargin: number }}
 */
export async function syncUpstoxFunds(userId) {
  try {
    const funds = await getFunds(userId);
    const availableMargin = funds.availableMargin;

    // Find Upstox portfolios for this user
    const portfolios = await prisma.portfolio.findMany({
      where: {
        userId,
        broker: 'UPSTOX',
        isActive: true
      }
    });

    let synced = 0;
    for (const portfolio of portfolios) {
      const oldCash = parseFloat(portfolio.availableCash || 0);
      if (Math.abs(oldCash - availableMargin) > 0.01) {
        await prisma.portfolio.update({
          where: { id: portfolio.id },
          data: { availableCash: availableMargin, lastVerifiedAt: new Date() }
        });
        logger.info(`[Capital Guard] Upstox funds synced: portfolio ${portfolio.id} cash ₹${oldCash.toFixed(0)} → ₹${availableMargin.toFixed(0)}`);
        synced++;

        // Capital increase detection: if cash rose by > ₹3,000 this likely means
        // a fresh deposit (not just a sell — sells also update holdings).
        // Alert the user so they know their capital has been recognised.
        const cashDelta = availableMargin - oldCash;
        if (cashDelta > 3000) {
          logger.info(`[Capital Guard] Capital increase detected: +₹${cashDelta.toFixed(0)} for portfolio ${portfolio.id}`);
          try {
            const portfolioFull = await prisma.portfolio.findUnique({
              where: { id: portfolio.id },
              include: { user: { include: { telegramUser: true } } }
            });
            const tg = portfolioFull?.user?.telegramUser;
            if (tg?.isActive && !tg?.isMuted) {
              const { getBot } = await import('./telegramBot.js');
              const bot = getBot();
              if (bot) {
                const startCap = parseFloat(portfolio.startingCapital || 0);
                const baselineNote = cashDelta > 5000 && availableMargin > startCap * 1.15
                  ? `\n\n_If this is a fresh deposit, run /upstox sync to update your P&L baseline._`
                  : '';
                await bot.sendMessage(
                  parseInt(tg.telegramId),
                  `💰 *Capital Increase Detected*\n\nUpstox cash: ₹${oldCash.toLocaleString('en-IN')} → ₹${availableMargin.toLocaleString('en-IN')} (+₹${cashDelta.toFixed(0)})\n\nAll new capital is immediately available for signal generation. Next scan will size positions to the full updated amount.${baselineNote}`,
                  { parse_mode: 'Markdown' }
                ).catch(() => {});
              }
            }
          } catch (alertErr) {
            logger.warn('[Capital Guard] Capital increase alert failed:', alertErr.message);
          }
        }
      } else {
        // Cash unchanged but still mark as verified
        await prisma.portfolio.update({
          where: { id: portfolio.id },
          data: { lastVerifiedAt: new Date() }
        });
      }
    }

    // Expire stale signals older than 24 hours (safety net)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const expired = await prisma.tradeSignal.updateMany({
      where: {
        status: { in: ['PENDING', 'ACKED', 'SNOOZED'] },
        createdAt: { lt: twentyFourHoursAgo }
      },
      data: { status: 'EXPIRED' }
    });

    if (expired.count > 0) {
      logger.info(`[Capital Guard] Expired ${expired.count} stale signals (>24h old)`);
    }

    return { synced, availableMargin };
  } catch (error) {
    logger.error(`[Capital Guard] syncUpstoxFunds failed for user ${userId}:`, error.message);
    return { synced: 0, availableMargin: 0 };
  }
}

/**
 * Sync holdings from Upstox API into the DB for all UPSTOX portfolios of a user.
 * Merges long-term holdings (demat, T+1 delayed) with short-term positions
 * (today's buys/sells) for an accurate real-time picture.
 *
 * @param {number} userId
 * @returns {{ synced: number, created: number, removed: number }}
 */
export async function syncUpstoxHoldings(userId) {
  try {
    const { holdings: upstoxHoldings } = await getHoldings(userId);

    // Fetch today's positions to detect same-day sells (before T+1 settlement)
    let todayPositions = [];
    try {
      const posResult = await getPositions(userId);
      todayPositions = posResult.positions || [];
    } catch (err) {
      logger.warn(`[Capital Guard] Could not fetch positions (non-blocking): ${err.message}`);
    }

    // Build a map of today's sell/buy adjustments: symbol → { sellQty, buyQty }
    const positionAdjustments = new Map();
    for (const pos of todayPositions) {
      const symbol = (pos.tradingsymbol || pos.trading_symbol || '').replace(/-EQ$/, '');
      if (!symbol) continue;
      const exchange = (pos.exchange || 'NSE').replace(/_EQ$/, '');
      const key = `${symbol}:${exchange}`;
      positionAdjustments.set(key, {
        sellQty: pos.day_sell_quantity || 0,
        buyQty: pos.day_buy_quantity || 0,
        lastPrice: parseFloat(pos.last_price || 0),
        // sell_price = average price of today's sells (Upstox field)
        sellPrice: parseFloat(pos.sell_price || pos.average_sell_price || pos.last_price || 0)
      });
    }

    // Build effective holdings: start with long-term, adjust for today's activity
    const effectiveHoldings = new Map();
    for (const uh of (upstoxHoldings || [])) {
      const symbol = (uh.tradingsymbol || uh.trading_symbol || '').replace(/-EQ$/, '');
      const exchange = (uh.exchange || 'NSE').replace(/_EQ$/, '');
      if (!symbol) continue;

      const key = `${symbol}:${exchange}`;
      let quantity = uh.quantity || 0;
      const avgPrice = parseFloat(uh.average_price || 0);
      const currentPrice = parseFloat(uh.last_price || uh.close_price || 0);

      // t1_quantity = shares bought today (T+1 delivery, not yet settled, cannot be sold same-day CNC).
      // These are excluded from sellable quantity.
      // cnc_used_quantity = shares committed to OPEN (unfilled) sell orders — we still OWN these,
      // so do NOT subtract them. Subtracting cnc_used caused holdings to disappear from DB when a
      // LIMIT sell order was open for the full position (e.g. PFC with 33 shares locked in open orders).
      const t1Qty = uh.t1_quantity || 0;
      if (t1Qty > 0) {
        quantity = Math.max(0, quantity - t1Qty);
        logger.info(`[Capital Guard] ${symbol}: total=${uh.quantity}, t1=${t1Qty}, sellable=${quantity}`);
      }

      // day_sell_quantity = shares ACTUALLY SOLD today (filled). Upstox holdings API won't reflect
      // these until T+1 settlement, so the raw quantity is still inflated. Subtract confirmed fills
      // to avoid ghost sell signals on positions that were already trimmed today.
      // Unlike cnc_used_quantity (which includes open limit orders), day_sell_quantity is fills only.
      const adj = positionAdjustments.get(key);
      if (adj && adj.sellQty > 0) {
        const adjusted = Math.max(0, quantity - adj.sellQty);
        if (adjusted !== quantity) {
          logger.info(`[Capital Guard] ${symbol}: subtracting ${adj.sellQty} today-sold (T+1 pending) → ${quantity}→${adjusted}`);
          quantity = adjusted;
        }
      }

      if (quantity > 0) {
        effectiveHoldings.set(key, { symbol, exchange, quantity, avgPrice, currentPrice });
      }
    }

    // Also add any same-day buys not yet in long-term holdings
    for (const pos of todayPositions) {
      const symbol = (pos.tradingsymbol || pos.trading_symbol || '').replace(/-EQ$/, '');
      const exchange = (pos.exchange || 'NSE').replace(/_EQ$/, '');
      if (!symbol) continue;
      const key = `${symbol}:${exchange}`;
      if (!effectiveHoldings.has(key) && (pos.day_buy_quantity || 0) > 0 && (pos.quantity || 0) > 0) {
        effectiveHoldings.set(key, {
          symbol, exchange,
          quantity: pos.quantity,
          avgPrice: parseFloat(pos.buy_price || pos.average_price || 0),
          currentPrice: parseFloat(pos.last_price || 0)
        });
        logger.info(`[Capital Guard] ${symbol}: new same-day buy, qty=${pos.quantity}`);
      }
    }

    if (effectiveHoldings.size === 0) {
      logger.info(`[Capital Guard] syncUpstoxHoldings: no effective Upstox holdings for user ${userId}`);
    }

    // Find all active UPSTOX portfolios for this user
    const portfolios = await prisma.portfolio.findMany({
      where: { userId, broker: 'UPSTOX', isActive: true },
      include: { holdings: true, user: { include: { telegramUser: true } } }
    });

    let synced = 0, created = 0, removed = 0;
    const soldHoldings = []; // populated when a holding disappears — for P&L tracking

    for (const portfolio of portfolios) {
      const existingMap = new Map();
      for (const h of portfolio.holdings) {
        existingMap.set(`${h.symbol}:${h.exchange}`, h);
      }

      const seenKeys = new Set();

      for (const [key, uh] of effectiveHoldings) {
        seenKeys.add(key);
        const existing = existingMap.get(key);

        if (existing) {
          const oldQty = existing.quantity;
          const oldAvg = parseFloat(existing.avgPrice);
          const oldPrice = parseFloat(existing.currentPrice || 0);

          if (oldQty !== uh.quantity || Math.abs(oldAvg - uh.avgPrice) > 0.01 || Math.abs(oldPrice - uh.currentPrice) > 0.5) {
            await prisma.holding.update({
              where: { id: existing.id },
              data: { quantity: uh.quantity, avgPrice: uh.avgPrice, currentPrice: uh.currentPrice }
            });
            synced++;
            logger.info(`[Capital Guard] Upstox holding updated: ${uh.symbol} qty=${oldQty}→${uh.quantity}, avg=₹${oldAvg.toFixed(2)}→₹${uh.avgPrice.toFixed(2)}, price=₹${uh.currentPrice.toFixed(2)} (portfolio ${portfolio.id})`);
          }
        } else {
          await prisma.holding.create({
            data: {
              portfolioId: portfolio.id,
              symbol: uh.symbol,
              exchange: uh.exchange,
              quantity: uh.quantity,
              avgPrice: uh.avgPrice,
              currentPrice: uh.currentPrice
            }
          });
          created++;
          logger.info(`[Capital Guard] Upstox holding created: ${uh.symbol} ${uh.quantity}x @ ₹${uh.avgPrice.toFixed(2)} (portfolio ${portfolio.id})`);
        }
      }

      // Remove holdings that no longer exist (fully sold — including external Upstox app sells)
      for (const [key, holding] of existingMap) {
        if (!seenKeys.has(key)) {
          await prisma.holding.delete({ where: { id: holding.id } });
          removed++;
          logger.info(`[Capital Guard] Upstox holding removed (sold): ${holding.symbol} (portfolio ${portfolio.id})`);
          // Capture sell price from today's positions for P&L tracking
          const posAdj = positionAdjustments.get(key);
          const sellPrice = posAdj?.sellQty > 0 ? posAdj.sellPrice : (posAdj?.lastPrice || 0);
          soldHoldings.push({
            symbol: holding.symbol,
            exchange: holding.exchange,
            portfolioId: portfolio.id,
            quantity: holding.quantity,
            avgPrice: parseFloat(holding.avgPrice),
            sellPrice
          });

          // Expire any pending SELL signals — the holding is gone
          try {
            const expiredSells = await prisma.tradeSignal.updateMany({
              where: {
                portfolioId: portfolio.id,
                symbol: holding.symbol,
                side: 'SELL',
                status: { in: ['PENDING', 'ACKED', 'SNOOZED', 'PLACING'] }
              },
              data: { status: 'EXPIRED' }
            });
            if (expiredSells.count > 0) {
              logger.info(`[Capital Guard] Expired ${expiredSells.count} SELL signal(s) for ${holding.symbol} (external sell detected)`);
            }
          } catch (expireErr) {
            logger.warn(`[Capital Guard] Failed to expire SELL signals for ${holding.symbol}: ${expireErr.message}`);
          }

          // Telegram notification + P&L DB update for externally-sold holdings
          try {
            const tg = portfolio.user?.telegramUser;
            if (tg?.isActive && !tg?.isMuted) {
              const { getBot } = await import('./telegramBot.js');
              const bot = getBot();
              if (bot) {
                let plLine = '';
                // Try to find matching EXECUTED BUY signal for accurate P&L
                if (sellPrice > 0) {
                  try {
                    const matchingBuy = await prisma.tradeSignal.findFirst({
                      where: {
                        portfolioId: portfolio.id,
                        symbol: holding.symbol,
                        side: 'BUY',
                        status: 'EXECUTED',
                        executedPrice: { not: null }
                      },
                      orderBy: { createdAt: 'desc' }
                    });
                    if (matchingBuy?.executedPrice) {
                      const pnl = (sellPrice - matchingBuy.executedPrice) * holding.quantity;
                      const outcome = pnl > 1 ? 'PROFIT' : pnl < -1 ? 'LOSS' : 'BREAKEVEN';
                      const pnlSign = pnl >= 0 ? '+' : '';
                      const emoji = outcome === 'PROFIT' ? '🟢' : outcome === 'LOSS' ? '🔴' : '⚪';
                      plLine = `\nBuy ₹${matchingBuy.executedPrice.toFixed(2)} → Sell ₹${sellPrice.toFixed(2)} | ${emoji} ${pnlSign}₹${Math.abs(pnl).toFixed(2)} (${outcome})`;
                      await prisma.tradeSignal.update({
                        where: { id: matchingBuy.id },
                        data: { exitPrice: sellPrice, realizedPnl: pnl, outcome }
                      }).catch(() => {});
                    }
                  } catch (buyErr) {
                    logger.warn(`[Capital Guard] BUY signal P&L lookup failed for ${holding.symbol}: ${buyErr.message}`);
                  }
                }
                await bot.sendMessage(
                  parseInt(tg.telegramId),
                  `✅ *${holding.symbol} Sold* (detected externally)\n\n${holding.quantity}× *${holding.symbol}* is no longer in your Upstox holdings.${plLine}\n\n_Pending sell signals for this stock have been expired._`,
                  { parse_mode: 'Markdown' }
                ).catch(() => {});
              }
            }
          } catch (notifyErr) {
            logger.warn(`[Capital Guard] External sell notification failed for ${holding.symbol}: ${notifyErr.message}`);
          }
        }
      }
    }

    // Mark all synced portfolios as verified
    for (const portfolio of portfolios) {
      await prisma.portfolio.update({
        where: { id: portfolio.id },
        data: { lastVerifiedAt: new Date() }
      });
    }

    logger.info(`[Capital Guard] syncUpstoxHoldings: synced=${synced}, created=${created}, removed=${removed} for user ${userId}`);
    return { synced, created, removed, soldHoldings };
  } catch (error) {
    logger.error(`[Capital Guard] syncUpstoxHoldings failed for user ${userId}:`, error.message);
    return { synced: 0, created: 0, removed: 0, soldHoldings: [] };
  }
}

const TERMINAL_STATUSES = ['complete', 'traded', 'rejected', 'cancelled'];
const SETTLED_SUCCESS = ['complete', 'traded'];
const SETTLED_FAILURE = ['rejected', 'cancelled'];

/**
 * Poll Upstox order until it reaches a terminal state.
 * Reusable by both Telegram bot and web API.
 *
 * @param {Object} opts
 * @param {number} opts.userId - User ID for Upstox API auth
 * @param {string} opts.orderId - Upstox order ID
 * @param {number} opts.dbOrderId - DB UpstoxOrder record ID
 * @param {number} opts.signalId - TradeSignal ID
 * @param {Object} opts.signal - Signal object (symbol, side, quantity, triggerPrice, etc.)
 * @param {Function} [opts.onSuccess] - Callback({ orderId, status, averagePrice }) on COMPLETE/TRADED
 * @param {Function} [opts.onFailure] - Callback({ orderId, status, reason }) on REJECTED/CANCELLED
 * @param {Function} [opts.onTimeout] - Callback({ orderId }) when polling exhausted
 * @returns {Promise<{ settled: boolean, status: string }>}
 */
export async function pollOrderUntilSettled({ userId, orderId, dbOrderId, signalId, signal, onSuccess, onFailure, onTimeout }) {
  const maxAttempts = 15;   // 15 × 3s = 45s total — handles slow Upstox confirmations
  const intervalMs = 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    try {
      const status = await getOrderStatus(userId, orderId);
      const orderStatus = (status.status || '').toLowerCase();

      logger.info(`Poll attempt ${attempt}/${maxAttempts} for order ${orderId}: ${orderStatus}`);

      if (SETTLED_SUCCESS.includes(orderStatus)) {
        // Order confirmed — mark signal EXECUTED and capture fill price
        const fillPrice = parseFloat(status.averagePrice || status.average_price || 0) || null;
        await prisma.tradeSignal.update({
          where: { id: signalId },
          data: { status: 'EXECUTED', executedPrice: fillPrice }
        });

        // Sync portfolio cash and holdings
        await updateCashOnExecution(dbOrderId);
        await upsertHoldingOnExecution(dbOrderId);

        logger.info(`Signal #${signalId} confirmed: order ${orderId} = ${orderStatus}, fill=₹${fillPrice || '?'}`);

        // DDPI: After SELL confirmed, expire any duplicate SELL signals for same stock
        if (signal?.side === 'SELL' && signal?.portfolioId && signal?.symbol) {
          try {
            const dupeResult = await prisma.tradeSignal.updateMany({
              where: {
                portfolioId: signal.portfolioId,
                symbol: signal.symbol,
                side: 'SELL',
                status: { in: ['PENDING', 'SNOOZED'] },
                id: { not: signalId }
              },
              data: { status: 'EXPIRED' }
            });
            if (dupeResult.count > 0) {
              logger.info(`[Capital Guard] Expired ${dupeResult.count} duplicate SELL signal(s) for ${signal.symbol} after execution`);
            }
          } catch (dupeErr) {
            logger.warn(`[Capital Guard] Failed to expire duplicate SELL signals: ${dupeErr.message}`);
          }
        }

        if (onSuccess) {
          await onSuccess({ orderId, status: orderStatus, averagePrice: status.averagePrice });
        }
        return { settled: true, status: orderStatus };
      }

      if (SETTLED_FAILURE.includes(orderStatus)) {
        // Order rejected — roll back signal
        await prisma.tradeSignal.update({
          where: { id: signalId },
          data: { status: 'PENDING', upstoxOrderId: null, lastNotifiedAt: null }
        });

        const reason = status.message || 'Unknown reason';
        logger.warn(`Signal #${signalId} rolled back: order ${orderId} = ${orderStatus} — ${reason}`);

        if (onFailure) {
          await onFailure({ orderId, status: orderStatus, reason });
        }
        return { settled: true, status: orderStatus };
      }
    } catch (pollErr) {
      logger.warn(`Poll attempt ${attempt} failed for order ${orderId}: ${pollErr.message}`);
    }
  }

  // Timeout — still pending after all attempts
  logger.info(`Signal #${signalId} order ${orderId} still pending after ${maxAttempts} polls`);
  if (onTimeout) {
    await onTimeout({ orderId });
  }
  return { settled: false, status: 'PENDING' };
}

export default {
  getEffectiveCash,
  validateSignals,
  validateAllocations,
  preOrderCapitalCheck,
  updateCashOnExecution,
  upsertHoldingOnExecution,
  syncUpstoxFunds,
  syncUpstoxHoldings,
  pollOrderUntilSettled
};

// server/services/capitalGuard.js
// Central capital enforcement — ensures recommendations never exceed portfolio capital.
// "Capital is the mother of all recommendations."

import prisma from './prisma.js';
import logger from './logger.js';
import { getFunds } from './upstoxService.js';

/**
 * Get effective cash for a portfolio, accounting for pending signal reservations.
 * Pending/Acked/Snoozed BUY signals reserve cash even before execution.
 *
 * @param {number} portfolioId
 * @returns {{ rawCash: number, reservedCash: number, effectiveCash: number }}
 */
export async function getEffectiveCash(portfolioId) {
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    select: { availableCash: true }
  });

  const rawCash = parseFloat(portfolio?.availableCash || 0);

  // Sum cost of all active BUY signals (PENDING, ACKED, SNOOZED, PLACING)
  const activeSignals = await prisma.tradeSignal.findMany({
    where: {
      portfolioId,
      side: 'BUY',
      status: { in: ['PENDING', 'ACKED', 'SNOOZED', 'PLACING'] }
    },
    select: { quantity: true, triggerPrice: true, triggerLow: true }
  });

  const reservedCash = activeSignals.reduce((sum, sig) => {
    const price = parseFloat(sig.triggerPrice || sig.triggerLow || 0);
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

  // Fetch holdings for SELL validation
  const holdings = await prisma.holding.findMany({
    where: { portfolioId },
    select: { symbol: true, quantity: true }
  });
  const holdingMap = {};
  for (const h of holdings) {
    holdingMap[h.symbol] = h.quantity;
  }

  const validated = [];
  let remainingCash = effectiveCash;

  // Separate BUY and SELL signals
  const buySignals = signals.filter(s => s.side === 'BUY');
  const sellSignals = signals.filter(s => s.side === 'SELL');

  // Sort BUY signals by confidence descending (best signals get funded first)
  buySignals.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  // Validate BUY signals against remaining cash
  for (const sig of buySignals) {
    const price = parseFloat(sig.triggerPrice || sig.triggerLow || sig.price || 0);
    const quantity = Math.max(1, parseInt(sig.quantity) || 1);

    if (price <= 0) {
      // MARKET order — no price to validate against, pass through
      validated.push(sig);
      continue;
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
      sig.quantity = affordableQty;
      const reducedCost = affordableQty * price;
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
 * @returns {{ allowed: boolean, reason: string, effectiveCash: number, orderCost: number }}
 */
export async function preOrderCapitalCheck(portfolioId, side, quantity, price) {
  if (side === 'SELL') {
    return { allowed: true, reason: 'SELL orders do not consume cash', effectiveCash: 0, orderCost: 0 };
  }

  const { effectiveCash } = await getEffectiveCash(portfolioId);
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
          data: { availableCash: availableMargin }
        });
        logger.info(`[Capital Guard] Upstox funds synced: portfolio ${portfolio.id} cash ₹${oldCash.toFixed(0)} → ₹${availableMargin.toFixed(0)}`);
        synced++;
      }
    }

    // Expire stale signals older than 24 hours (safety net)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const expired = await prisma.tradeSignal.updateMany({
      where: {
        status: { in: ['PENDING', 'SNOOZED'] },
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

export default {
  getEffectiveCash,
  validateSignals,
  validateAllocations,
  preOrderCapitalCheck,
  updateCashOnExecution,
  syncUpstoxFunds
};

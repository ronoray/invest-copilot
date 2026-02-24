import express from 'express';
import prisma from '../services/prisma.js';
import { generateTradeSignals } from '../services/signalGenerator.js';
import { placeOrder } from '../services/upstoxService.js';
import { getCurrentPrice } from '../services/marketData.js';
import { preOrderCapitalCheck, syncUpstoxFunds, pollOrderUntilSettled } from '../services/capitalGuard.js';
import logger from '../services/logger.js';

const router = express.Router();

/**
 * GET /api/signals?portfolioId=X&status=PENDING
 * List trade signals for a portfolio.
 */
router.get('/', async (req, res) => {
  try {
    const portfolioId = parseInt(req.query.portfolioId);
    const status = req.query.status; // optional filter

    if (!portfolioId) {
      return res.status(400).json({ error: 'portfolioId is required' });
    }

    // Verify portfolio belongs to user
    const portfolio = await prisma.portfolio.findFirst({
      where: { id: portfolioId, userId: req.user.id, isActive: true }
    });
    if (!portfolio) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    const where = { portfolioId };
    if (status) {
      where.status = status;
    }

    const signals = await prisma.tradeSignal.findMany({
      where,
      include: { acknowledgements: true },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    // Count pending for the Telegram status section
    const pendingCount = await prisma.tradeSignal.count({
      where: { portfolioId, status: { in: ['PENDING', 'SNOOZED'] } }
    });

    // Get last notification time
    const lastNotified = await prisma.tradeSignal.findFirst({
      where: { portfolioId, lastNotifiedAt: { not: null } },
      orderBy: { lastNotifiedAt: 'desc' },
      select: { lastNotifiedAt: true }
    });

    res.json({
      success: true,
      data: {
        signals,
        pendingCount,
        lastNotifiedAt: lastNotified?.lastNotifiedAt || null
      }
    });
  } catch (error) {
    logger.error('GET /signals error:', error);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

/**
 * POST /api/signals/generate
 * AI generates BUY/SELL signals for a portfolio.
 * Body: { portfolioId }
 */
router.post('/generate', async (req, res) => {
  try {
    const { portfolioId } = req.body;
    if (!portfolioId) {
      return res.status(400).json({ error: 'portfolioId is required' });
    }

    // Verify portfolio belongs to user
    const portfolio = await prisma.portfolio.findFirst({
      where: { id: parseInt(portfolioId), userId: req.user.id, isActive: true }
    });
    if (!portfolio) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    const signals = await generateTradeSignals(parseInt(portfolioId));

    res.json({
      success: true,
      data: { signals, count: signals.length }
    });
  } catch (error) {
    logger.error('POST /signals/generate error:', error);
    res.status(500).json({ error: 'Failed to generate signals' });
  }
});

/**
 * POST /api/signals/:id/ack
 * Acknowledge, snooze, or dismiss a signal.
 * Body: { action: "ACK" | "SNOOZE_30M" | "DISMISS", note?: string }
 */
router.post('/:id/ack', async (req, res) => {
  try {
    const signalId = parseInt(req.params.id);
    const { action, note } = req.body;

    if (!['ACK', 'SNOOZE_30M', 'DISMISS'].includes(action)) {
      return res.status(400).json({ error: 'action must be ACK, SNOOZE_30M, or DISMISS' });
    }

    // Verify signal belongs to user's portfolio
    const signal = await prisma.tradeSignal.findUnique({
      where: { id: signalId },
      include: { portfolio: true }
    });

    if (!signal || signal.portfolio.userId !== req.user.id) {
      return res.status(404).json({ error: 'Signal not found' });
    }

    // Map action to status
    const statusMap = {
      'ACK': 'ACKED',
      'SNOOZE_30M': 'SNOOZED',
      'DISMISS': 'DISMISSED'
    };

    // Update signal status
    const updated = await prisma.tradeSignal.update({
      where: { id: signalId },
      data: { status: statusMap[action] }
    });

    // Create acknowledgement record
    await prisma.signalAck.create({
      data: {
        signalId,
        action,
        note: note || null
      }
    });

    // For non-Upstox portfolios: update availableCash on ACK
    if (action === 'ACK' && signal.portfolio.broker !== 'UPSTOX') {
      const price = parseFloat(signal.triggerPrice || signal.triggerLow || 0);
      if (price > 0 && signal.quantity > 0) {
        const amount = signal.quantity * price;
        if (signal.side === 'BUY') {
          await prisma.portfolio.update({
            where: { id: signal.portfolioId },
            data: { availableCash: { decrement: amount } }
          });
          logger.info(`[Capital] Web ACK BUY: portfolio ${signal.portfolioId} cash -₹${amount.toFixed(0)} (${signal.symbol})`);
        } else if (signal.side === 'SELL') {
          await prisma.portfolio.update({
            where: { id: signal.portfolioId },
            data: { availableCash: { increment: amount } }
          });
          logger.info(`[Capital] Web ACK SELL: portfolio ${signal.portfolioId} cash +₹${amount.toFixed(0)} (${signal.symbol})`);
        }
      }
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('POST /signals/:id/ack error:', error);
    res.status(500).json({ error: 'Failed to acknowledge signal' });
  }
});

/**
 * GET /api/signals/pending-count
 * Returns total pending signal count across all user portfolios (for nav badge).
 */
router.get('/pending-count', async (req, res) => {
  try {
    const count = await prisma.tradeSignal.count({
      where: {
        portfolio: { userId: req.user.id, isActive: true },
        status: { in: ['PENDING', 'SNOOZED'] }
      }
    });
    res.json({ success: true, count });
  } catch (error) {
    logger.error('GET /signals/pending-count error:', error);
    res.status(500).json({ error: 'Failed to fetch pending count' });
  }
});

/**
 * POST /api/signals/:id/execute
 * Execute a trade signal via Upstox (web equivalent of Telegram Execute button).
 */
router.post('/:id/execute', async (req, res) => {
  try {
    const signalId = parseInt(req.params.id);

    // Load signal with portfolio and user's Upstox integration
    const signal = await prisma.tradeSignal.findUnique({
      where: { id: signalId },
      include: {
        portfolio: {
          include: {
            user: {
              include: { upstoxIntegration: true }
            }
          }
        }
      }
    });

    if (!signal || signal.portfolio.userId !== req.user.id) {
      return res.status(404).json({ error: 'Signal not found' });
    }

    if (signal.status === 'EXECUTED' || signal.status === 'PLACING') {
      return res.status(400).json({ error: signal.status === 'PLACING' ? 'Order is being verified' : 'Already executed' });
    }

    if (signal.status === 'DISMISSED' || signal.status === 'EXPIRED') {
      return res.status(400).json({ error: `Signal is ${signal.status.toLowerCase()}` });
    }

    const userId = signal.portfolio.user.id;
    const upstox = signal.portfolio.user.upstoxIntegration;

    if (!upstox || !upstox.isConnected || !upstox.accessToken) {
      return res.status(400).json({ error: 'Upstox not connected. Please authenticate via /auth in Telegram.' });
    }

    // Map signal trigger type to Upstox order params
    let orderType = 'MARKET';
    let price = 0;
    let triggerPrice = 0;

    if (signal.triggerType === 'LIMIT' && signal.triggerPrice) {
      orderType = 'LIMIT';
      price = parseFloat(signal.triggerPrice);
    } else if (signal.triggerType === 'ZONE' && signal.triggerLow) {
      orderType = 'LIMIT';
      price = parseFloat(signal.triggerLow);
    }

    // Validate LIMIT price against live market price (reject if >20% deviation)
    if (orderType === 'LIMIT' && price > 0) {
      try {
        const liveData = await getCurrentPrice(signal.symbol, signal.exchange);
        const currentPrice = liveData?.price || liveData?.lastPrice;
        if (currentPrice && currentPrice > 0) {
          const deviation = Math.abs(price - currentPrice) / currentPrice;
          if (deviation > 0.20) {
            return res.status(400).json({
              error: `Price deviation too high (${(deviation * 100).toFixed(1)}%). Signal: ₹${price}, Market: ₹${currentPrice}. Consider dismissing and re-scanning.`
            });
          }
        }
      } catch (priceErr) {
        logger.warn(`Could not validate price for signal #${signalId}: ${priceErr.message}`);
      }
    }

    // Sync Upstox funds before capital check
    try {
      await syncUpstoxFunds(userId);
    } catch (syncErr) {
      logger.warn(`Pre-execution fund sync failed for signal #${signalId}: ${syncErr.message}`);
    }

    // Capital check for BUY orders
    if (signal.side === 'BUY') {
      let estimatedPrice = price;
      if (orderType === 'MARKET') {
        try {
          const priceData = await getCurrentPrice(signal.symbol, signal.exchange);
          estimatedPrice = priceData?.price || priceData?.lastPrice || parseFloat(signal.triggerPrice || signal.triggerLow || 0);
        } catch (e) {
          estimatedPrice = parseFloat(signal.triggerPrice || signal.triggerLow || 0);
        }
      }

      if (estimatedPrice > 0) {
        const capitalCheck = await preOrderCapitalCheck(signal.portfolioId, 'BUY', signal.quantity, estimatedPrice, signalId);
        if (!capitalCheck.allowed) {
          return res.status(400).json({ error: capitalCheck.reason });
        }
      }
    }

    const orderParams = {
      symbol: signal.symbol,
      exchange: `${signal.exchange}_EQ`,
      transactionType: signal.side,
      orderType,
      quantity: signal.quantity,
      price,
      triggerPrice,
      portfolioId: signal.portfolioId
    };

    logger.info(`Executing signal #${signalId} via web:`, orderParams);

    const result = await placeOrder(userId, orderParams);

    // Mark as PLACING
    await prisma.tradeSignal.update({
      where: { id: signalId },
      data: { status: 'PLACING', upstoxOrderId: result.dbOrderId }
    });

    // Create ack record
    await prisma.signalAck.create({
      data: {
        signalId,
        action: 'EXECUTE',
        note: `Upstox order ${result.orderId} placed via web by user ${req.user.id}`
      }
    });

    // Return immediately, poll in background
    res.json({
      success: true,
      data: { orderId: result.orderId, message: 'Order placed, verifying with exchange...' }
    });

    // Async polling (non-blocking)
    pollOrderUntilSettled({
      userId,
      orderId: result.orderId,
      dbOrderId: result.dbOrderId,
      signalId,
      signal
    }).catch(err => logger.error(`Web polling failed for signal #${signalId}:`, err));

  } catch (error) {
    logger.error(`POST /signals/:id/execute error:`, error);
    res.status(500).json({ error: error.message || 'Failed to execute signal' });
  }
});

export default router;

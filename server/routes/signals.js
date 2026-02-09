import express from 'express';
import prisma from '../services/prisma.js';
import { generateTradeSignals } from '../services/signalGenerator.js';
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

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('POST /signals/:id/ack error:', error);
    res.status(500).json({ error: 'Failed to acknowledge signal' });
  }
});

export default router;

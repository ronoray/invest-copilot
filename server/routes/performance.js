import express from 'express';
import prisma from '../services/prisma.js';
import {
  getSummaryMetrics,
  getEquityCurve,
  getMonthlyPnl,
  getTradeJournal,
  getSignalQuality,
  getLearningLedger,
  createTodaySnapshot,
} from '../services/performanceService.js';
import logger from '../services/logger.js';

const router = express.Router();

// ─── Verify portfolio ownership ───────────────────────────────────────────────

async function getPortfolio(portfolioId, userId) {
  return prisma.portfolio.findFirst({
    where: { id: portfolioId, userId, isActive: true }
  });
}

// ─── GET /api/performance/:portfolioId/overview ───────────────────────────────

router.get('/:portfolioId/overview', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const metrics = await getSummaryMetrics(portfolioId);
    res.json(metrics);
  } catch (err) {
    logger.error('Performance overview error:', err);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// ─── GET /api/performance/:portfolioId/equity-curve ───────────────────────────

router.get('/:portfolioId/equity-curve', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const data = await getEquityCurve(portfolioId);
    res.json(data);
  } catch (err) {
    logger.error('Equity curve error:', err);
    res.status(500).json({ error: 'Failed to fetch equity curve' });
  }
});

// ─── GET /api/performance/:portfolioId/monthly-pnl ───────────────────────────

router.get('/:portfolioId/monthly-pnl', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const data = await getMonthlyPnl(portfolioId);
    res.json({ monthly: data });
  } catch (err) {
    logger.error('Monthly P&L error:', err);
    res.status(500).json({ error: 'Failed to fetch monthly P&L' });
  }
});

// ─── GET /api/performance/:portfolioId/trades ─────────────────────────────────

router.get('/:portfolioId/trades', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const filters = {
      symbol: req.query.symbol,
      type: req.query.type,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 50,
    };

    const data = await getTradeJournal(portfolioId, filters);
    res.json(data);
  } catch (err) {
    logger.error('Trade journal error:', err);
    res.status(500).json({ error: 'Failed to fetch trades' });
  }
});

// ─── GET /api/performance/:portfolioId/signal-quality ────────────────────────

router.get('/:portfolioId/signal-quality', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const data = await getSignalQuality(portfolioId);
    res.json(data);
  } catch (err) {
    logger.error('Signal quality error:', err);
    res.status(500).json({ error: 'Failed to fetch signal quality' });
  }
});

// ─── GET /api/performance/:portfolioId/learning ───────────────────────────────

router.get('/:portfolioId/learning', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const data = await getLearningLedger(portfolioId);
    res.json(data);
  } catch (err) {
    logger.error('Learning ledger error:', err);
    res.status(500).json({ error: 'Failed to fetch learning ledger' });
  }
});

// ─── POST /api/performance/:portfolioId/snapshot ─────────────────────────────

router.post('/:portfolioId/snapshot', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const snapshot = await createTodaySnapshot(portfolioId);
    res.json({ ok: true, snapshot });
  } catch (err) {
    logger.error('Snapshot create error:', err);
    res.status(500).json({ error: 'Failed to create snapshot' });
  }
});

// ─── POST /api/performance/:portfolioId/mistakes ──────────────────────────────

router.post('/:portfolioId/mistakes', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const { symbol, tradeId, signalId, mistakeCategory, description, reason, lesson, pnlImpact } = req.body;
    if (!symbol || !mistakeCategory || !description) {
      return res.status(400).json({ error: 'symbol, mistakeCategory, description required' });
    }

    const mistake = await prisma.mistakeLog.create({
      data: {
        portfolioId,
        symbol: symbol.toUpperCase(),
        tradeId: tradeId ? parseInt(tradeId) : null,
        signalId: signalId ? parseInt(signalId) : null,
        mistakeCategory,
        description,
        reason,
        lesson,
        pnlImpact: pnlImpact ? parseFloat(pnlImpact) : null,
      }
    });
    res.json({ ok: true, mistake });
  } catch (err) {
    logger.error('Mistake create error:', err);
    res.status(500).json({ error: 'Failed to create mistake log' });
  }
});

// ─── PUT /api/performance/:portfolioId/mistakes/:id ──────────────────────────

router.put('/:portfolioId/mistakes/:id', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const id = parseInt(req.params.id);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const existing = await prisma.mistakeLog.findFirst({ where: { id, portfolioId } });
    if (!existing) return res.status(404).json({ error: 'Mistake not found' });

    const { mistakeCategory, description, reason, lesson, ruleImplemented, pnlImpact } = req.body;
    const updated = await prisma.mistakeLog.update({
      where: { id },
      data: {
        ...(mistakeCategory && { mistakeCategory }),
        ...(description && { description }),
        ...(reason !== undefined && { reason }),
        ...(lesson !== undefined && { lesson }),
        ...(ruleImplemented !== undefined && { ruleImplemented }),
        ...(pnlImpact !== undefined && { pnlImpact: parseFloat(pnlImpact) }),
        updatedAt: new Date(),
      }
    });
    res.json({ ok: true, mistake: updated });
  } catch (err) {
    logger.error('Mistake update error:', err);
    res.status(500).json({ error: 'Failed to update mistake' });
  }
});

// ─── DELETE /api/performance/:portfolioId/mistakes/:id ───────────────────────

router.delete('/:portfolioId/mistakes/:id', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const id = parseInt(req.params.id);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const existing = await prisma.mistakeLog.findFirst({ where: { id, portfolioId } });
    if (!existing) return res.status(404).json({ error: 'Mistake not found' });

    await prisma.mistakeLog.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Mistake delete error:', err);
    res.status(500).json({ error: 'Failed to delete mistake' });
  }
});

// ─── POST /api/performance/:portfolioId/rules ─────────────────────────────────

router.post('/:portfolioId/rules', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const { title, description, sourceMistakeId, status } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'title and description required' });
    }

    const rule = await prisma.learningRule.create({
      data: {
        portfolioId,
        title,
        description,
        sourceMistakeId: sourceMistakeId ? parseInt(sourceMistakeId) : null,
        status: status || 'PROPOSED',
      }
    });
    res.json({ ok: true, rule });
  } catch (err) {
    logger.error('Rule create error:', err);
    res.status(500).json({ error: 'Failed to create rule' });
  }
});

// ─── PUT /api/performance/:portfolioId/rules/:id ──────────────────────────────

router.put('/:portfolioId/rules/:id', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const id = parseInt(req.params.id);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const existing = await prisma.learningRule.findFirst({ where: { id, portfolioId } });
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    const { title, description, status, impact } = req.body;
    const updated = await prisma.learningRule.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(description && { description }),
        ...(status && { status }),
        ...(impact !== undefined && { impact: parseFloat(impact) }),
        updatedAt: new Date(),
      }
    });
    res.json({ ok: true, rule: updated });
  } catch (err) {
    logger.error('Rule update error:', err);
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

// ─── DELETE /api/performance/:portfolioId/rules/:id ──────────────────────────

router.delete('/:portfolioId/rules/:id', async (req, res) => {
  try {
    const portfolioId = parseInt(req.params.portfolioId);
    const id = parseInt(req.params.id);
    const portfolio = await getPortfolio(portfolioId, req.user.id);
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const existing = await prisma.learningRule.findFirst({ where: { id, portfolioId } });
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    await prisma.learningRule.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Rule delete error:', err);
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

export default router;

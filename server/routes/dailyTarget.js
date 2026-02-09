import express from 'express';
import prisma from '../services/prisma.js';
import { getOrCreateTodayTarget, refreshAiTarget } from '../services/dailyTargetService.js';
import logger from '../services/logger.js';

const router = express.Router();

/**
 * GET /api/daily-target/today?portfolioId=X
 * Get today's daily target for a portfolio.
 */
router.get('/today', async (req, res) => {
  try {
    const portfolioId = parseInt(req.query.portfolioId);
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

    const record = await getOrCreateTodayTarget(portfolioId);

    const gap = record.aiTarget - record.earnedActual;
    const userGap = record.userTarget != null ? record.userTarget - record.earnedActual : null;

    res.json({
      success: true,
      data: {
        ...record,
        gap,
        userGap,
        gapLabel: gap > 0 ? `Behind by ₹${gap.toFixed(0)}` : gap < 0 ? `Ahead by ₹${Math.abs(gap).toFixed(0)}` : 'On target'
      }
    });
  } catch (error) {
    logger.error('GET /daily-target/today error:', error);
    res.status(500).json({ error: 'Failed to fetch daily target' });
  }
});

/**
 * POST /api/daily-target/today
 * Update earnedActual or userTarget for today.
 * Body: { portfolioId, earnedActual?, userTarget? }
 */
router.post('/today', async (req, res) => {
  try {
    const { portfolioId, earnedActual, userTarget } = req.body;
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

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const updateData = {};
    if (earnedActual !== undefined) {
      updateData.earnedActual = parseFloat(earnedActual) || 0;
      updateData.earnedUpdatedAt = new Date();
    }
    if (userTarget !== undefined) {
      updateData.userTarget = userTarget !== null ? parseFloat(userTarget) : null;
      updateData.userUpdatedAt = new Date();
    }

    const record = await prisma.dailyTarget.upsert({
      where: {
        portfolioId_date: { portfolioId: parseInt(portfolioId), date: today }
      },
      update: updateData,
      create: {
        portfolioId: parseInt(portfolioId),
        date: today,
        earnedActual: parseFloat(earnedActual) || 0,
        userTarget: userTarget !== undefined && userTarget !== null ? parseFloat(userTarget) : null,
        earnedUpdatedAt: earnedActual !== undefined ? new Date() : null,
        userUpdatedAt: userTarget !== undefined ? new Date() : null
      }
    });

    res.json({ success: true, data: record });
  } catch (error) {
    logger.error('POST /daily-target/today error:', error);
    res.status(500).json({ error: 'Failed to update daily target' });
  }
});

/**
 * POST /api/daily-target/today/ai-refresh
 * Trigger AI to compute today's target for a portfolio.
 * Body: { portfolioId }
 */
router.post('/today/ai-refresh', async (req, res) => {
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

    const record = await refreshAiTarget(parseInt(portfolioId));
    const gap = record.aiTarget - record.earnedActual;

    res.json({
      success: true,
      data: {
        ...record,
        gap,
        gapLabel: gap > 0 ? `Behind by ₹${gap.toFixed(0)}` : gap < 0 ? `Ahead by ₹${Math.abs(gap).toFixed(0)}` : 'On target'
      }
    });
  } catch (error) {
    logger.error('POST /daily-target/today/ai-refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh AI target' });
  }
});

export default router;

import express from 'express';
import { PrismaClient } from '@prisma/client';
import logger from '../services/logger.js';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * GET /api/proposals - Get all proposals
 */
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;

    const proposals = await prisma.proposal.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' }
    });

    res.json(proposals);
  } catch (error) {
    logger.error('Proposals fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch proposals' });
  }
});

/**
 * GET /api/proposals/:id - Get single proposal
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const proposal = await prisma.proposal.findUnique({
      where: { id: parseInt(id) }
    });

    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    res.json(proposal);
  } catch (error) {
    logger.error('Proposal fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch proposal' });
  }
});

/**
 * POST /api/proposals - Create new proposal (AI-generated)
 */
router.post('/', async (req, res) => {
  try {
    const {
      symbol,
      exchange = 'NSE',
      type,
      quantity,
      targetPrice,
      stopLoss,
      confidence,
      reasoning
    } = req.body;

    if (!symbol || !type || !quantity || !targetPrice || !stopLoss) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const proposal = await prisma.proposal.create({
      data: {
        symbol,
        exchange,
        type,
        quantity,
        targetPrice,
        stopLoss,
        confidence: confidence || 50,
        reasoning: reasoning || {}
      }
    });

    logger.info(`Created proposal: ${type} ${symbol} x${quantity}`);
    res.status(201).json(proposal);
  } catch (error) {
    logger.error('Create proposal error:', error);
    res.status(500).json({ error: 'Failed to create proposal' });
  }
});

/**
 * PUT /api/proposals/:id/approve - Approve proposal
 */
router.put('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;

    const proposal = await prisma.proposal.update({
      where: { id: parseInt(id) },
      data: {
        status: 'APPROVED',
        reviewedAt: new Date()
      }
    });

    logger.info(`Approved proposal ID: ${id}`);
    res.json(proposal);
  } catch (error) {
    logger.error('Approve proposal error:', error);
    res.status(500).json({ error: 'Failed to approve proposal' });
  }
});

/**
 * PUT /api/proposals/:id/reject - Reject proposal
 */
router.put('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const proposal = await prisma.proposal.update({
      where: { id: parseInt(id) },
      data: {
        status: 'REJECTED',
        reviewedAt: new Date(),
        reasoning: {
          ...(typeof proposal.reasoning === 'object' ? proposal.reasoning : {}),
          rejectionReason: reason
        }
      }
    });

    logger.info(`Rejected proposal ID: ${id}`);
    res.json(proposal);
  } catch (error) {
    logger.error('Reject proposal error:', error);
    res.status(500).json({ error: 'Failed to reject proposal' });
  }
});

/**
 * DELETE /api/proposals/:id - Delete proposal
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.proposal.delete({
      where: { id: parseInt(id) }
    });

    logger.info(`Deleted proposal ID: ${id}`);
    res.json({ message: 'Proposal deleted' });
  } catch (error) {
    logger.error('Delete proposal error:', error);
    res.status(500).json({ error: 'Failed to delete proposal' });
  }
});

export default router;

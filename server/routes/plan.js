// server/routes/plan.js
import express from 'express';
import { authenticate } from '../middleware/auth.js';
import prisma from '../config/database.js';

const router = express.Router();

/**
 * GET /api/plan/snapshot
 * Returns portfolio snapshot with starting capital, invested amount, available cash, P&L
 */
router.get('/snapshot', authenticate, async (req, res) => {
  try {
    // Get starting capital from Config table
    const config = await prisma.config.findFirst({
      where: { key: 'starting_capital' }
    });
    
    const startingCapital = parseFloat(config?.startingCapital || 0);
    
    // Get user's holdings
    const holdings = await prisma.holding.findMany({
      where: { userId: req.user.id }
    });
    
    // Calculate currently invested amount (quantity × average price)
    const currentlyInvested = holdings.reduce((sum, holding) => {
      const invested = parseFloat(holding.quantity) * parseFloat(holding.avgPrice);
      return sum + invested;
    }, 0);
    
    // Calculate current value (quantity × current price)
    const currentValue = holdings.reduce((sum, holding) => {
      const value = parseFloat(holding.quantity) * parseFloat(holding.currentPrice);
      return sum + value;
    }, 0);
    
    // Calculate available cash
    const availableCash = startingCapital - currentlyInvested;
    
    // Calculate total P&L
    const totalPnL = currentValue - currentlyInvested;
    
    // Calculate P&L percentage
    const totalPnLPercent = currentlyInvested > 0 
      ? ((totalPnL / currentlyInvested) * 100)
      : 0;
    
    res.json({
      startingCapital: parseFloat(startingCapital.toFixed(2)),
      currentlyInvested: parseFloat(currentlyInvested.toFixed(2)),
      availableCash: parseFloat(availableCash.toFixed(2)),
      currentValue: parseFloat(currentValue.toFixed(2)),
      totalPnL: parseFloat(totalPnL.toFixed(2)),
      totalPnLPercent: parseFloat(totalPnLPercent.toFixed(2))
    });
    
  } catch (error) {
    console.error('❌ Plan snapshot error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch portfolio snapshot',
      details: error.message 
    });
  }
});

/**
 * POST /api/plan/update-capital
 * Update starting capital
 */
router.post('/update-capital', authenticate, async (req, res) => {
  try {
    const { capital } = req.body;
    
    if (!capital || capital <= 0) {
      return res.status(400).json({ error: 'Invalid capital amount' });
    }
    
    // Update or create config
    const config = await prisma.config.upsert({
      where: { key: 'starting_capital' },
      update: {
        value: capital.toString(),
        startingCapital: parseFloat(capital)
      },
      create: {
        key: 'starting_capital',
        value: capital.toString(),
        startingCapital: parseFloat(capital)
      }
    });
    
    res.json({
      message: 'Starting capital updated successfully',
      capital: parseFloat(config.startingCapital)
    });
    
  } catch (error) {
    console.error('❌ Update capital error:', error);
    res.status(500).json({ 
      error: 'Failed to update capital',
      details: error.message 
    });
  }
});

export default router;
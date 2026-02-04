import { PrismaClient } from '@prisma/client';
import logger from './logger.js';

const prisma = new PrismaClient();

/**
 * Portfolio Calculator Service
 * Tracks capital, P&L, and calculates reinvestment capacity
 */

/**
 * Calculate complete portfolio summary
 * @returns {object} Portfolio snapshot with reinvestment capacity
 */
export async function calculatePortfolioSummary() {
  try {
    // Get all holdings
    const holdings = await prisma.holding.findMany({
      include: {
        latestPrice: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    // Get all trades
    const trades = await prisma.trade.findMany({
      orderBy: { executedAt: 'desc' },
    });

    // Calculate portfolio metrics
    let totalInvested = 0;
    let currentValue = 0;
    let realizedPL = 0;

    // Current holdings
    holdings.forEach(holding => {
      const invested = holding.quantity * holding.avgPrice;
      const current = holding.quantity * (holding.latestPrice[0]?.price || holding.avgPrice);
      
      totalInvested += invested;
      currentValue += current;
    });

    // Realized P&L from trades
    const sellTrades = trades.filter(t => t.type === 'SELL');
    sellTrades.forEach(trade => {
      if (trade.profit) {
        realizedPL += trade.profit;
      }
    });

    const unrealizedPL = currentValue - totalInvested;
    const totalPL = unrealizedPL + realizedPL;
    const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

    // Calculate today's P&L (mock - needs daily snapshot feature)
    const todayPL = currentValue * 0.01; // Simplified
    const todayPLPercent = (todayPL / currentValue) * 100;

    // Get starting capital (from config or first investment)
    const config = await getOrCreateConfig();
    const startingCapital = config.startingCapital || totalInvested;
    
    // Calculate available cash
    const totalDeposited = startingCapital + realizedPL;
    const availableCash = totalDeposited - totalInvested;

    // Calculate reinvestment capacity
    const reinvestmentCapacity = availableCash + (realizedPL > 0 ? realizedPL : 0);

    return {
      startingCapital,
      totalInvested,
      currentValue,
      availableCash: Math.max(0, availableCash),
      unrealizedPL,
      realizedPL,
      totalPL,
      totalPLPercent: Math.round(totalPLPercent * 100) / 100,
      todayPL,
      todayPLPercent: Math.round(todayPLPercent * 100) / 100,
      reinvestmentCapacity: Math.max(0, reinvestmentCapacity),
      holdingsCount: holdings.length,
      tradesCount: trades.length,
    };
  } catch (error) {
    logger.error('Portfolio summary error:', error);
    throw error;
  }
}

/**
 * Calculate recommended allocation for new investment
 * @param {number} amount - Amount to invest
 * @param {string} riskProfile - CONSERVATIVE, BALANCED, AGGRESSIVE
 * @returns {object} Recommended allocation
 */
export function calculateAllocation(amount, riskProfile = 'BALANCED') {
  const allocations = {
    CONSERVATIVE: {
      highRisk: 0.2,  // 20%
      mediumRisk: 0.3, // 30%
      lowRisk: 0.5,    // 50%
    },
    BALANCED: {
      highRisk: 0.3,   // 30%
      mediumRisk: 0.4, // 40%
      lowRisk: 0.3,    // 30%
    },
    AGGRESSIVE: {
      highRisk: 0.5,   // 50%
      mediumRisk: 0.3, // 30%
      lowRisk: 0.2,    // 20%
    },
  };

  const profile = allocations[riskProfile] || allocations.BALANCED;

  return {
    total: amount,
    highRisk: Math.round(amount * profile.highRisk),
    mediumRisk: Math.round(amount * profile.mediumRisk),
    lowRisk: Math.round(amount * profile.lowRisk),
    profile: riskProfile,
  };
}

/**
 * Get reinvestment suggestions based on current portfolio
 * @returns {object} Reinvestment analysis
 */
export async function getReinvestmentSuggestions() {
  const summary = await calculatePortfolioSummary();
  
  // Determine if user should reinvest
  const shouldReinvest = summary.reinvestmentCapacity > 1000; // Minimum ₹1000

  // Calculate recommended amount to reinvest
  let recommendedAmount = 0;
  if (shouldReinvest) {
    // Reinvest 70% of available capacity, keep 30% as buffer
    recommendedAmount = Math.round(summary.reinvestmentCapacity * 0.7);
  }

  // Calculate buffer amount
  const bufferAmount = summary.reinvestmentCapacity - recommendedAmount;

  // Get allocation recommendation
  const allocation = calculateAllocation(recommendedAmount, 'BALANCED');

  return {
    reinvestmentCapacity: summary.reinvestmentCapacity,
    shouldReinvest,
    recommendedAmount,
    bufferAmount,
    allocation,
    reason: shouldReinvest 
      ? 'You have profits + cash available. Time to grow your portfolio!'
      : 'Save up more before next investment. Minimum ₹1,000 recommended.',
  };
}

/**
 * Track a deposit/withdrawal
 * @param {string} type - DEPOSIT or WITHDRAWAL
 * @param {number} amount
 * @param {string} note
 */
export async function recordTransaction(type, amount, note = '') {
  try {
    const config = await getOrCreateConfig();
    
    let newCapital = config.startingCapital;
    if (type === 'DEPOSIT') {
      newCapital += amount;
    } else if (type === 'WITHDRAWAL') {
      newCapital -= amount;
    }

    await prisma.config.update({
      where: { id: config.id },
      data: { startingCapital: newCapital },
    });

    logger.info(`${type}: ₹${amount}, New capital: ₹${newCapital}`);

    return { success: true, newCapital };
  } catch (error) {
    logger.error('Transaction record error:', error);
    throw error;
  }
}

/**
 * Get or create config entry
 */
async function getOrCreateConfig() {
  let config = await prisma.config.findFirst();
  
  if (!config) {
    config = await prisma.config.create({
      data: {
        key: 'portfolio_config',
        value: JSON.stringify({ startingCapital: 10000 }), // Default ₹10,000
        startingCapital: 10000,
      },
    });
  }

  return config;
}

/**
 * Calculate expected returns for a portfolio allocation
 * @param {array} stocks - Array of stock recommendations
 * @returns {object} Expected returns (best/likely/worst case)
 */
export function calculateExpectedReturns(stocks) {
  let bestCase = 0;
  let likelyCase = 0;
  let worstCase = 0;
  let totalInvestment = 0;

  stocks.forEach(stock => {
    const { investment, targetReturn, stopLoss } = stock;
    
    totalInvestment += investment;
    
    // Best case: Hit target
    bestCase += investment * (1 + targetReturn / 100);
    
    // Likely case: 60% of target
    likelyCase += investment * (1 + (targetReturn * 0.6) / 100);
    
    // Worst case: Hit stop loss
    worstCase += investment * (1 + stopLoss / 100);
  });

  return {
    totalInvestment,
    bestCase: Math.round(bestCase),
    likelyCase: Math.round(likelyCase),
    worstCase: Math.round(worstCase),
    bestCaseReturn: Math.round(((bestCase - totalInvestment) / totalInvestment) * 100),
    likelyCaseReturn: Math.round(((likelyCase - totalInvestment) / totalInvestment) * 100),
    worstCaseReturn: Math.round(((worstCase - totalInvestment) / totalInvestment) * 100),
  };
}

export default {
  calculatePortfolioSummary,
  calculateAllocation,
  getReinvestmentSuggestions,
  recordTransaction,
  calculateExpectedReturns,
};
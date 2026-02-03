import { PrismaClient } from '@prisma/client';
import { getCurrentPrice, getWatchlistSignals } from '../services/marketData.js';
import logger from '../services/logger.js';

const prisma = new PrismaClient();

/**
 * Market scanner job - runs every 5 minutes during market hours
 * 
 * Tasks:
 * 1. Update portfolio prices
 * 2. Check watchlist alerts
 * 3. Scan for opportunities (future: AI integration)
 */
export async function scanMarket() {
  logger.info('=== Market Scanner Started ===');

  try {
    // 1. Update portfolio prices
    await updatePortfolioTask();

    // 2. Check watchlist signals
    await checkWatchlistTask();

    // 3. TODO: AI scanning for opportunities
    // await scanOpportunitiesTask();

    logger.info('=== Market Scanner Completed ===');
  } catch (error) {
    logger.error('Market scanner error:', error);
  }
}

/**
 * Update all portfolio holdings with current prices
 */
async function updatePortfolioTask() {
  try {
    const holdings = await prisma.holding.findMany();
    let updated = 0;

    for (const holding of holdings) {
      try {
        const priceData = await getCurrentPrice(holding.symbol, holding.exchange);
        
        await prisma.holding.update({
          where: { id: holding.id },
          data: { currentPrice: priceData.price }
        });

        updated++;
        logger.info(`Updated ${holding.symbol}: ₹${priceData.price}`);

        // Rate limiting (5 calls/min for free tier)
        await sleep(12000);
      } catch (error) {
        logger.error(`Failed to update ${holding.symbol}:`, error.message);
      }
    }

    logger.info(`Portfolio update: ${updated}/${holdings.length} stocks`);
  } catch (error) {
    logger.error('Portfolio update task error:', error);
  }
}

/**
 * Check watchlist for price alerts
 */
async function checkWatchlistTask() {
  try {
    const signals = await getWatchlistSignals();

    if (signals.length > 0) {
      logger.info(`Watchlist signals: ${signals.length}`);

      // Save alerts to database
      for (const signal of signals) {
        await prisma.alert.create({
          data: {
            symbol: signal.symbol,
            alertType: signal.type,
            message: `${signal.symbol}: ${signal.type}`,
            data: signal
          }
        });
      }

      // TODO: Send Telegram/WhatsApp notifications
    }
  } catch (error) {
    logger.error('Watchlist check task error:', error);
  }
}

/**
 * Scan market for opportunities (AI-powered)
 * TODO: Implement with Claude API
 */
async function scanOpportunitiesTask() {
  try {
    // Placeholder for AI scanning logic
    logger.info('AI opportunity scanning - Not implemented yet');
    
    // Future implementation:
    // 1. Fetch top 500 stocks from NSE
    // 2. Run technical analysis (RSI, MACD, etc.)
    // 3. Check fundamentals (P/E, Debt/Equity)
    // 4. Send to Claude API for analysis
    // 5. Generate proposals for good opportunities
  } catch (error) {
    logger.error('Opportunity scanning error:', error);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

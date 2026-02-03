import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';

// Route imports
import portfolioRoutes from './routes/portfolio.js';
import marketRoutes from './routes/market.js';
import proposalRoutes from './routes/proposal.js';
import watchlistRoutes from './routes/watchlist.js';

// Service imports
import { scanMarket } from './jobs/marketScanner.js';
import logger from './services/logger.js';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3100;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/proposals', proposalRoutes);
app.use('/api/watchlist', watchlistRoutes);

// Cron Jobs
if (process.env.NODE_ENV === 'production') {
  // Market scanner - every 5 minutes during market hours (9:15 AM - 3:30 PM IST)
  cron.schedule('*/5 9-15 * * 1-5', async () => {
    try {
      logger.info('Running market scanner...');
      await scanMarket();
    } catch (error) {
      logger.error('Market scanner error:', error);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });
  
  logger.info('Cron jobs initialized');
}

// Error handling
app.use((err, req, res, next) => {
  logger.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Investment API running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

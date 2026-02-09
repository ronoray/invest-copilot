import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import cron from 'node-cron';
import prisma from './services/prisma.js';

// Route imports
import authRoutes from './routes/auth.js';
import portfolioRoutes from './routes/portfolio.js';
import marketRoutes from './routes/market.js';
import proposalRoutes from './routes/proposal.js';
import watchlistRoutes from './routes/watchlist.js';
import aiRoutes from './routes/ai.js';
import taxRoutes from './routes/tax.js';
import portfolioCalcRoutes from './routes/portfolioCalc.js';
import upstoxRoutes from './routes/upstox.js';
import dailyTargetRoutes from './routes/dailyTarget.js';
import signalRoutes from './routes/signals.js';

// Service imports
import { scanMarket } from './jobs/marketScanner.js';
import { initTelegramBot } from './services/telegramBot.js';
import { initTelegramAlerts } from './jobs/telegramAlerts.js';
import { initSignalNotifier } from './jobs/signalNotifier.js';
import logger from './services/logger.js';
import { hashPassword } from './services/authService.js';

// Middleware imports
import { authenticate, optionalAuth } from './middleware/auth.js';

import { handleDeployWebhook, triggerManualDeploy } from './services/deploy-webhook.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3100;

// ============================================
// MIDDLEWARE
// ============================================

app.use(helmet());

// CORS Configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || [
    'https://invest.hungrytimes.in',
    'http://localhost:3101'
  ],
  credentials: true
};
app.use(cors(corsOptions));

app.use(express.json());

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ============================================
// HEALTH CHECKS
// ============================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    services: {
      database: 'connected',
      email: process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true' ? 'enabled' : 'disabled',
      sms: process.env.ENABLE_SMS_NOTIFICATIONS === 'true' ? 'enabled' : 'disabled',
      whatsapp: process.env.ENABLE_WHATSAPP_NOTIFICATIONS === 'true' ? 'enabled' : 'disabled',
      telegram: process.env.ENABLE_TELEGRAM_NOTIFICATIONS === 'true' ? 'enabled' : 'disabled'
    }
  });
});

// ============================================
// API ROUTES
// ============================================

// Public routes
app.use('/api/auth', authRoutes);

// Protected routes (require authentication)
app.use('/api/portfolio', authenticate, portfolioRoutes);
app.use('/api/portfolio-calc', authenticate, portfolioCalcRoutes);
app.use('/api/market', optionalAuth, marketRoutes);
app.use('/api/proposals', authenticate, proposalRoutes);
app.use('/api/watchlist', authenticate, watchlistRoutes);
app.use('/api/ai', authenticate, aiRoutes);
app.use('/api/tax', authenticate, taxRoutes);
app.use('/api/upstox', authenticate, upstoxRoutes);
app.use('/api/daily-target', authenticate, dailyTargetRoutes);
app.use('/api/signals', authenticate, signalRoutes);
app.post('/api/deploy/webhook', handleDeployWebhook);
app.post('/api/deploy/trigger', authenticate, triggerManualDeploy);

// ============================================
// CRON JOBS
// ============================================

if (process.env.NODE_ENV === 'production' || process.env.ENABLE_CRON === 'true') {
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

// ============================================
// TELEGRAM BOT INTEGRATION
// ============================================

if (process.env.NODE_ENV !== 'test' && process.env.TELEGRAM_BOT_TOKEN) {
  try {
    initTelegramBot();
    initTelegramAlerts();
    initSignalNotifier();
    logger.info('Telegram bot integrated');
  } catch (error) {
    logger.error('Telegram bot initialization error:', error);
  }
}

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================
// DATABASE INITIALIZATION
// ============================================

async function initializeDatabase() {
  try {
    // Test database connection
    await prisma.$connect();
    logger.info('Database connected');

    // Create admin user if doesn't exist
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const adminExists = await prisma.user.findUnique({
        where: { email: process.env.ADMIN_EMAIL }
      });

      if (!adminExists) {
        const hashedPassword = await hashPassword(process.env.ADMIN_PASSWORD);
        
        await prisma.user.create({
          data: {
            email: process.env.ADMIN_EMAIL,
            phone: process.env.ADMIN_PHONE || null,
            password: hashedPassword,
            name: process.env.ADMIN_NAME || 'Admin',
            role: 'admin',
            isActive: true,
            emailVerified: true,
            phoneVerified: false
          }
        });

        logger.info('Admin user created');
      }
    }
  } catch (error) {
    logger.error('Database initialization error:', error);
    process.exit(1);
  }
}

// ============================================
// SERVER STARTUP
// ============================================

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      logger.info(`Investment Co-Pilot API running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`Frontend URL: ${process.env.FRONTEND_URL}`);
      
      // Log service status
      logger.info('Services status:');
      logger.info(`  Email: ${process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true' ? 'Enabled' : 'Disabled'}`);
      logger.info(`  SMS: ${process.env.ENABLE_SMS_NOTIFICATIONS === 'true' ? 'Enabled' : 'Disabled'}`);
      logger.info(`  WhatsApp: ${process.env.ENABLE_WHATSAPP_NOTIFICATIONS === 'true' ? 'Enabled' : 'Disabled'}`);
      logger.info(`  Telegram: ${process.env.ENABLE_TELEGRAM_NOTIFICATIONS === 'true' ? 'Enabled' : 'Disabled'}`);
    });
  } catch (error) {
    logger.error('Server startup error:', error);
    process.exit(1);
  }
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

// Start the server
startServer();
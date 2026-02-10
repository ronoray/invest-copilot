import express from 'express';
import { exchangeCodeForToken } from '../services/upstoxService.js';
import { getBot } from '../services/telegramBot.js';
import { PrismaClient } from '@prisma/client';
import logger from '../services/logger.js';

const prisma = new PrismaClient();
const router = express.Router();

/**
 * GET /api/upstox/callback
 * Upstox OAuth callback — exchanges code for token.
 * PUBLIC route (no JWT) — Upstox redirects browser here after login.
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).send('Missing authorization code from Upstox.');
    }

    const userId = parseInt(state);
    if (!userId) {
      return res.status(400).send('Invalid state parameter.');
    }

    await exchangeCodeForToken(code, userId);

    // Notify user via Telegram
    try {
      const telegramUser = await prisma.telegramUser.findFirst({
        where: { userId }
      });
      if (telegramUser) {
        const bot = getBot();
        if (bot) {
          await bot.sendMessage(
            parseInt(telegramUser.telegramId),
            '✅ *Upstox Connected!*\nYour token has been refreshed. Execute buttons on signals will work until market close today.',
            { parse_mode: 'Markdown' }
          );
        }
      }
    } catch (tgErr) {
      logger.warn('Could not send Telegram notification after Upstox auth:', tgErr.message);
    }

    // Redirect to frontend with success message
    const frontendUrl = process.env.FRONTEND_URL || 'https://invest.hungrytimes.in';
    res.redirect(`${frontendUrl}?upstox_auth=success`);
  } catch (error) {
    logger.error('Upstox callback error:', error.message);
    const frontendUrl = process.env.FRONTEND_URL || 'https://invest.hungrytimes.in';
    res.redirect(`${frontendUrl}?upstox_auth=failed&error=${encodeURIComponent(error.message)}`);
  }
});

export default router;

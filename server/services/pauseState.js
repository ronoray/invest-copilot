// server/services/pauseState.js
// Shared pause/resume state via Config table.
// Kept separate to avoid circular imports between telegramBot.js and signalNotifier.js.

import prisma from './prisma.js';
import logger from './logger.js';

const PAUSE_KEY = 'signals_paused';

/**
 * Get current pause state, or null if system is active.
 * @returns {{ reason: string, pausedAt: string, pausedByTelegramId: string } | null}
 */
export async function getSystemPauseState() {
  try {
    const config = await prisma.config.findUnique({ where: { key: PAUSE_KEY } });
    if (!config) return null;
    return JSON.parse(config.value);
  } catch {
    return null;
  }
}

/**
 * Activate pause state.
 * @param {{ reason: string, pausedByTelegramId: string }} opts
 */
export async function setPauseState({ reason, pausedByTelegramId }) {
  const value = JSON.stringify({
    reason,
    pausedAt: new Date().toISOString(),
    pausedByTelegramId
  });
  await prisma.config.upsert({
    where: { key: PAUSE_KEY },
    create: { key: PAUSE_KEY, value },
    update: { value }
  });
}

/**
 * Clear pause state (resume system).
 */
export async function clearPauseState() {
  try {
    await prisma.config.delete({ where: { key: PAUSE_KEY } });
  } catch {
    // Already cleared — safe to ignore
  }
}

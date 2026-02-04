import { PrismaClient } from '@prisma/client';
import * as emailService from './emailService.js';
import * as smsService from './smsService.js';
import * as whatsappService from './whatsappService.js';
import { sendAlert as sendTelegramAlert } from './telegramBot.js';
import logger from './logger.js';

const prisma = new PrismaClient();

/**
 * Notification Orchestrator
 * Coordinates sending notifications across all channels
 * (Email, SMS, WhatsApp, Telegram)
 */

// ============================================
// SEND NOTIFICATION TO USER
// ============================================

export async function notifyUser(userId, type, data) {
  try {
    // Get user preferences
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { telegramUser: true }
    });

    if (!user || !user.isActive) {
      logger.warn(`User ${userId} not found or inactive`);
      return;
    }

    const prefs = user.preferences || {};
    const results = [];

    // Email
    if (prefs.emailNotifications !== false && user.emailVerified) {
      try {
        const emailResult = await sendEmailNotification(user.email, type, data);
        results.push({ channel: 'email', ...emailResult });
      } catch (error) {
        logger.error('Email notification error:', error);
      }
    }

    // SMS
    if (prefs.smsNotifications && user.phone && user.phoneVerified) {
      try {
        const smsResult = await sendSMSNotification(user.phone, type, data);
        results.push({ channel: 'sms', ...smsResult });
      } catch (error) {
        logger.error('SMS notification error:', error);
      }
    }

    // WhatsApp
    if (prefs.whatsappNotifications && user.phone && user.phoneVerified) {
      try {
        const whatsappResult = await sendWhatsAppNotification(user.phone, type, data);
        results.push({ channel: 'whatsapp', ...whatsappResult });
      } catch (error) {
        logger.error('WhatsApp notification error:', error);
      }
    }

    // Telegram
    if (prefs.telegramNotifications && user.telegramUser && user.telegramUser.isActive) {
      try {
        const telegramResult = await sendTelegramNotification(user.telegramUser.id, type, data);
        results.push({ channel: 'telegram', ...telegramResult });
      } catch (error) {
        logger.error('Telegram notification error:', error);
      }
    }

    // Log notification
    await prisma.notification.create({
      data: {
        userId,
        channel: results.map(r => r.channel).join(','),
        type,
        message: JSON.stringify(data),
        status: results.some(r => r.success) ? 'sent' : 'failed',
        sentAt: new Date()
      }
    });

    logger.info(`Notification sent to user ${userId} via ${results.length} channels`);
    return results;
  } catch (error) {
    logger.error('Notify user error:', error);
    throw error;
  }
}

// ============================================
// CHANNEL-SPECIFIC SENDERS
// ============================================

async function sendEmailNotification(email, type, data) {
  switch (type) {
    case 'buy_alert':
      return await emailService.sendBuyAlert(email, data);
    case 'sell_alert':
      return await emailService.sendSellAlert(email, data.holding, data.currentPrice, data.reason);
    case 'daily_digest':
      return await emailService.sendDailyDigest(email, data);
    case 'otp':
      return await emailService.sendOTP(email, data.otp);
    case 'welcome':
      return await emailService.sendWelcomeEmail(email, data.name);
    case 'password_reset':
      return await emailService.sendPasswordResetEmail(email, data.resetToken);
    default:
      logger.warn(`Unknown email notification type: ${type}`);
      return { success: false };
  }
}

async function sendSMSNotification(phone, type, data) {
  switch (type) {
    case 'buy_alert':
      return await smsService.sendBuyAlert(phone, data);
    case 'sell_alert':
      return await smsService.sendSellAlert(phone, data.holding, data.currentPrice, data.reason);
    case 'otp':
      return await smsService.sendOTP(phone, data.otp);
    default:
      logger.warn(`Unknown SMS notification type: ${type}`);
      return { success: false };
  }
}

async function sendWhatsAppNotification(phone, type, data) {
  switch (type) {
    case 'buy_alert':
      return await whatsappService.sendBuyAlert(phone, data);
    case 'sell_alert':
      return await whatsappService.sendSellAlert(phone, data.holding, data.currentPrice, data.reason);
    case 'target_approaching':
      return await whatsappService.sendTargetApproaching(phone, data.holding, data.currentPrice, data.targetPrice);
    case 'daily_digest':
      return await whatsappService.sendDailyDigest(phone, data);
    case 'evening_summary':
      return await whatsappService.sendEveningSummary(phone, data);
    case 'otp':
      return await whatsappService.sendOTP(phone, data.otp);
    default:
      logger.warn(`Unknown WhatsApp notification type: ${type}`);
      return { success: false };
  }
}

async function sendTelegramNotification(telegramUserId, type, data) {
  try {
    await sendTelegramAlert(telegramUserId, type.toUpperCase(), data);
    return { success: true };
  } catch (error) {
    logger.error('Telegram send error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================
// BROADCAST TO ALL USERS
// ============================================

export async function broadcastNotification(type, data, filters = {}) {
  try {
    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        ...filters
      },
      include: { telegramUser: true }
    });

    logger.info(`Broadcasting ${type} to ${users.length} users`);

    const results = [];
    for (const user of users) {
      try {
        const result = await notifyUser(user.id, type, data);
        results.push({ userId: user.id, ...result });
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.error(`Broadcast error for user ${user.id}:`, error);
      }
    }

    logger.info(`Broadcast complete: ${results.length} users notified`);
    return results;
  } catch (error) {
    logger.error('Broadcast error:', error);
    throw error;
  }
}

// ============================================
// NOTIFICATION PREFERENCES
// ============================================

export async function updateNotificationPreferences(userId, preferences) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    const currentPrefs = user.preferences || {};
    const updatedPrefs = {
      ...currentPrefs,
      emailNotifications: preferences.email ?? currentPrefs.emailNotifications ?? true,
      smsNotifications: preferences.sms ?? currentPrefs.smsNotifications ?? false,
      whatsappNotifications: preferences.whatsapp ?? currentPrefs.whatsappNotifications ?? false,
      telegramNotifications: preferences.telegram ?? currentPrefs.telegramNotifications ?? true
    };

    await prisma.user.update({
      where: { id: userId },
      data: { preferences: updatedPrefs }
    });

    logger.info(`Notification preferences updated for user ${userId}`);
    return updatedPrefs;
  } catch (error) {
    logger.error('Update preferences error:', error);
    throw error;
  }
}

export default {
  notifyUser,
  broadcastNotification,
  updateNotificationPreferences
};
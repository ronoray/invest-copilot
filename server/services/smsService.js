import axios from 'axios';
import logger from './logger.js';

/**
 * SMS Service - MSG91
 * Sends SMS via MSG91 API
 */

const MSG91_BASE_URL = 'https://api.msg91.com/api';
const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;

// ============================================
// SEND SMS
// ============================================

export async function sendSMS(phone, message) {
  try {
    if (process.env.ENABLE_SMS_NOTIFICATIONS !== 'true') {
      logger.info('SMS notifications disabled');
      return { success: false, disabled: true };
    }

    if (!MSG91_AUTH_KEY) {
      throw new Error('MSG91_AUTH_KEY not configured');
    }

    // Format phone number (remove +)
    const formattedPhone = phone.replace('+', '');

    const response = await axios.post(`${MSG91_BASE_URL}/sendhttp.php`, null, {
      params: {
        authkey: MSG91_AUTH_KEY,
        mobiles: formattedPhone,
        message,
        sender: process.env.MSG91_SENDER_ID || 'INVCO',
        route: process.env.MSG91_ROUTE || '4',
        country: '91'
      }
    });

    logger.info(`SMS sent to ${phone}: ${response.data}`);
    return { success: true, response: response.data };
  } catch (error) {
    logger.error('SMS send error:', error.message);
    throw error;
  }
}

// ============================================
// SEND OTP
// ============================================

export async function sendOTP(phone, otp) {
  try {
    if (process.env.ENABLE_SMS_NOTIFICATIONS !== 'true') {
      logger.info('SMS notifications disabled');
      return { success: false, disabled: true };
    }

    if (!MSG91_AUTH_KEY) {
      throw new Error('MSG91_AUTH_KEY not configured');
    }

    // Format phone number
    const formattedPhone = phone.replace('+', '');

    // Use MSG91 OTP API
    const response = await axios.post(`${MSG91_BASE_URL}/v5/otp`, {
      template_id: process.env.MSG91_OTP_TEMPLATE_ID,
      mobile: formattedPhone,
      authkey: MSG91_AUTH_KEY,
      otp
    });

    logger.info(`OTP SMS sent to ${phone}`);
    return { success: true, response: response.data };
  } catch (error) {
    logger.error('OTP SMS error:', error.message);
    
    // Fallback to regular SMS if template not available
    const message = `Your Investment Co-Pilot login code is: ${otp}. Valid for 10 minutes.`;
    return await sendSMS(phone, message);
  }
}

// ============================================
// SEND BUY ALERT
// ============================================

export async function sendBuyAlert(phone, stock) {
  const message = `🔥 BUY ALERT - ${stock.symbol}
Price: ₹${stock.price.toFixed(0)}
Risk: ${stock.riskCategory.toUpperCase()}
Target: ₹${stock.targetPrice.toFixed(0)}
Stop: ₹${stock.stopLoss.toFixed(0)}

Investment Co-Pilot`;

  return await sendSMS(phone, message);
}

// ============================================
// SEND SELL ALERT
// ============================================

export async function sendSellAlert(phone, holding, currentPrice, reason) {
  const profit = (currentPrice - holding.avgPrice) * holding.quantity;
  const profitPercent = ((currentPrice - holding.avgPrice) / holding.avgPrice) * 100;

  const message = `💰 SELL ALERT - ${holding.symbol}
Current: ₹${currentPrice.toFixed(0)}
P&L: ₹${profit.toFixed(0)} (${profitPercent.toFixed(1)}%)
Reason: ${reason}

Investment Co-Pilot`;

  return await sendSMS(phone, message);
}

// ============================================
// VERIFY PHONE NUMBER
// ============================================

export async function verifyPhone(phone) {
  try {
    // Format phone number
    const formattedPhone = phone.replace('+', '');

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Send verification OTP
    await sendOTP(formattedPhone, otp);

    return { success: true, otp };
  } catch (error) {
    logger.error('Phone verification error:', error);
    throw error;
  }
}

export default {
  sendSMS,
  sendOTP,
  sendBuyAlert,
  sendSellAlert,
  verifyPhone
};
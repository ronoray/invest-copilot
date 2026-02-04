import axios from 'axios';
import logger from './logger.js';

/**
 * WhatsApp Service - MSG91
 * Sends WhatsApp messages via MSG91 WhatsApp API
 */

const MSG91_WHATSAPP_URL = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message';
const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const WHATSAPP_NUMBER = process.env.MSG91_WHATSAPP_NUMBER || '918420829190';

// ============================================
// SEND WHATSAPP MESSAGE
// ============================================

export async function sendWhatsAppMessage(phone, message, templateId = null) {
  try {
    if (process.env.ENABLE_WHATSAPP_NOTIFICATIONS !== 'true') {
      logger.info('WhatsApp notifications disabled');
      return { success: false, disabled: true };
    }

    if (!MSG91_AUTH_KEY) {
      throw new Error('MSG91_AUTH_KEY not configured');
    }

    // Format phone number (with country code, no +)
    const formattedPhone = phone.replace('+', '');

    const payload = {
      integrated_number: WHATSAPP_NUMBER,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        to: formattedPhone,
        type: 'template',
        template: {
          name: templateId || process.env.MSG91_WHATSAPP_TEMPLATE_ID || 'investment_alert',
          language: {
            code: 'en'
          },
          components: [
            {
              type: 'body',
              parameters: [
                {
                  type: 'text',
                  text: message
                }
              ]
            }
          ]
        }
      }
    };

    const response = await axios.post(MSG91_WHATSAPP_URL, payload, {
      headers: {
        'authkey': MSG91_AUTH_KEY,
        'Content-Type': 'application/json'
      }
    });

    logger.info(`WhatsApp sent to ${phone}: ${response.data?.message || 'Success'}`);
    return { success: true, response: response.data };
  } catch (error) {
    logger.error('WhatsApp send error:', error.response?.data || error.message);
    throw error;
  }
}

// ============================================
// SEND BUY ALERT VIA WHATSAPP
// ============================================

export async function sendBuyAlert(phone, stock) {
  const message = `🔥 *BUY ALERT - ${stock.symbol}*

*Price:* ₹${stock.price.toFixed(2)}
*Risk:* ${stock.riskCategory.toUpperCase()} (${stock.riskScore}/10)

*Why Buy?*
${stock.simpleWhy.map(r => `✓ ${r}`).join('\n')}

*Investment:* ₹${stock.suggestedAmount.toLocaleString('en-IN')}
*Target:* ₹${stock.targetPrice.toFixed(0)} (+${((stock.targetPrice - stock.price) / stock.price * 100).toFixed(0)}%)
*Stop Loss:* ₹${stock.stopLoss.toFixed(0)} (${((stock.stopLoss - stock.price) / stock.price * 100).toFixed(0)}%)

*Expected Returns:*
🚀 Best: ${stock.expectedReturns.best}
📊 Likely: ${stock.expectedReturns.likely}
📉 Worst: ${stock.expectedReturns.worst}

_Investment Co-Pilot_`;

  return await sendWhatsAppMessage(phone, message);
}

// ============================================
// SEND SELL ALERT VIA WHATSAPP
// ============================================

export async function sendSellAlert(phone, holding, currentPrice, reason) {
  const profit = (currentPrice - holding.avgPrice) * holding.quantity;
  const profitPercent = ((currentPrice - holding.avgPrice) / holding.avgPrice) * 100;

  const message = `💰 *SELL ALERT - ${holding.symbol}*

*Current:* ₹${currentPrice.toFixed(2)}
*Your Buy:* ₹${holding.avgPrice.toFixed(2)}
*Profit:* ₹${profit.toLocaleString('en-IN')} (${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(2)}%)

*Reason:* ${reason}

${profitPercent > 0 ? '✅ Time to book profit!' : '🛑 Cut losses to protect capital'}

_Investment Co-Pilot_`;

  return await sendWhatsAppMessage(phone, message);
}

// ============================================
// SEND TARGET APPROACHING VIA WHATSAPP
// ============================================

export async function sendTargetApproaching(phone, holding, currentPrice, targetPrice) {
  const percentToTarget = ((currentPrice - holding.avgPrice) / (targetPrice - holding.avgPrice)) * 100;

  const message = `🎯 *TARGET APPROACHING - ${holding.symbol}*

*Current:* ₹${currentPrice.toFixed(2)}
*Target:* ₹${targetPrice.toFixed(2)}
*Progress:* ${percentToTarget.toFixed(0)}% there!

Book profit now or wait for target?

_Investment Co-Pilot_`;

  return await sendWhatsAppMessage(phone, message);
}

// ============================================
// SEND DAILY DIGEST VIA WHATSAPP
// ============================================

export async function sendDailyDigest(phone, data) {
  const message = `☀️ *GOOD MORNING!*

*Today's Market Outlook*

*Portfolio Value:* ₹${data.portfolioValue.toLocaleString('en-IN')}
*Today's P&L:* ${data.todayPL >= 0 ? '📈 +' : '📉 '}₹${Math.abs(data.todayPL).toLocaleString('en-IN')}

*🔥 Top Picks Today:*
${data.topPicks.map((s, i) => `${i + 1}. ${s.symbol} (${s.riskCategory}) - ₹${s.price.toFixed(0)}`).join('\n')}

Good luck today! 💰

_Investment Co-Pilot_`;

  return await sendWhatsAppMessage(phone, message);
}

// ============================================
// SEND EVENING SUMMARY VIA WHATSAPP
// ============================================

export async function sendEveningSummary(phone, data) {
  const message = `🌙 *MARKET CLOSED*

*Your Performance Today*

*Portfolio Value:* ₹${data.portfolioValue.toLocaleString('en-IN')}
*Day's P&L:* ${data.dayPL >= 0 ? '📈 +' : '📉 '}₹${Math.abs(data.dayPL).toLocaleString('en-IN')} (${data.dayPLPercent.toFixed(2)}%)

${data.dayPL > 0 ? '🎉 Great day!' : data.dayPL < 0 ? '💪 Tomorrow is another day!' : '😌 Stable day!'}

_Investment Co-Pilot_`;

  return await sendWhatsAppMessage(phone, message);
}

// ============================================
// SEND OTP VIA WHATSAPP
// ============================================

export async function sendOTP(phone, otp) {
  const message = `🔐 *Your Login Code*

Your Investment Co-Pilot verification code is:

*${otp}*

This code will expire in 10 minutes.

⚠️ Never share this code with anyone.

_Investment Co-Pilot_`;

  return await sendWhatsAppMessage(phone, message);
}

export default {
  sendWhatsAppMessage,
  sendBuyAlert,
  sendSellAlert,
  sendTargetApproaching,
  sendDailyDigest,
  sendEveningSummary,
  sendOTP
};
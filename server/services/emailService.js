import nodemailer from 'nodemailer';
const { createTransport } = nodemailer;
import logger from './logger.js';

/**
 * Email Service - GoDaddy SMTP
 * Sends emails via GoDaddy's SMTP server
 */

// Create transporter
const transporter = createTransport({
  host: process.env.EMAIL_HOST || 'smtpout.secureserver.net',
  port: parseInt(process.env.EMAIL_PORT) || 465,
  secure: process.env.EMAIL_SECURE === 'true' || true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Verify connection on startup
transporter.verify((error, success) => {
  if (error) {
    logger.error('Email service connection failed:', error);
  } else {
    logger.info('Email service ready');
  }
});

// ============================================
// SEND EMAIL
// ============================================

export async function sendEmail({ to, subject, html, text }) {
  try {
    if (process.env.ENABLE_EMAIL_NOTIFICATIONS !== 'true') {
      logger.info('Email notifications disabled');
      return { success: false, disabled: true };
    }

    const mailOptions = {
      from: `${process.env.EMAIL_FROM_NAME || 'Investment Co-Pilot'} <${process.env.EMAIL_FROM_ADDRESS}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, '')
    };

    const info = await transporter.sendMail(mailOptions);
    logger.info(`Email sent: ${info.messageId}`);
    
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error('Email send error:', error);
    throw error;
  }
}

// ============================================
// WELCOME EMAIL
// ============================================

export async function sendWelcomeEmail(email, name) {
  const subject = '🎉 Welcome to Investment Co-Pilot!';
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🚀 Welcome to Investment Co-Pilot!</h1>
        </div>
        <div class="content">
          <h2>Hi ${name},</h2>
          <p>Welcome to your personal AI-powered investment assistant!</p>
          
          <h3>What You Can Do:</h3>
          <ul>
            <li>📊 Track your portfolio in real-time</li>
            <li>📈 Get AI-powered stock recommendations</li>
            <li>🔔 Receive instant buy/sell alerts</li>
            <li>💰 Optimize for tax efficiency</li>
            <li>📱 Manage everything from Telegram</li>
          </ul>
          
          <p><a href="${process.env.FRONTEND_URL}" class="button">Get Started</a></p>
          
          <p>Need help? Just reply to this email!</p>
          
          <p>Happy investing! 💰</p>
          <p><strong>Team Investment Co-Pilot</strong></p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} Investment Co-Pilot. All rights reserved.</p>
          <p>This is an automated message. Please do not reply directly.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmail({ to: email, subject, html });
}

// ============================================
// OTP EMAIL
// ============================================

export async function sendOTP(email, otp) {
  const subject = '🔐 Your Login Code';
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .otp-box { background: #667eea; color: white; font-size: 32px; font-weight: bold; text-align: center; padding: 20px; border-radius: 10px; letter-spacing: 5px; margin: 20px 0; }
        .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🔐 Your Login Code</h2>
        <p>Use this code to log in to Investment Co-Pilot:</p>
        <div class="otp-box">${otp}</div>
        <p>This code will expire in 10 minutes.</p>
        <div class="warning">
          <strong>⚠️ Security Notice:</strong><br>
          Never share this code with anyone. We will never ask for your code via phone or email.
        </div>
        <p>If you didn't request this code, please ignore this email.</p>
      </div>
    </body>
    </html>
  `;

  return await sendEmail({ to: email, subject, html });
}

// ============================================
// PASSWORD RESET EMAIL
// ============================================

export async function sendPasswordResetEmail(email, resetToken) {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
  const subject = '🔒 Reset Your Password';
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .button { display: inline-block; padding: 12px 30px; background: #dc2626; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>🔒 Reset Your Password</h2>
        <p>You requested to reset your password for Investment Co-Pilot.</p>
        <p>Click the button below to set a new password:</p>
        <p><a href="${resetUrl}" class="button">Reset Password</a></p>
        <p>Or copy this link: ${resetUrl}</p>
        <p>This link will expire in 1 hour.</p>
        <p>If you didn't request this, please ignore this email and your password will remain unchanged.</p>
      </div>
    </body>
    </html>
  `;

  return await sendEmail({ to: email, subject, html });
}

// ============================================
// BUY ALERT EMAIL
// ============================================

export async function sendBuyAlert(email, stock) {
  const subject = `🔥 BUY ALERT - ${stock.symbol}`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: Arial, sans-serif;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #dc2626;">🔥 BUY ALERT - ${stock.symbol}</h2>
        <div style="background: #f3f4f6; padding: 20px; border-radius: 10px;">
          <p><strong>Price:</strong> ₹${stock.price.toFixed(2)}</p>
          <p><strong>Risk:</strong> ${stock.riskCategory.toUpperCase()}</p>
          <p><strong>Investment:</strong> ₹${stock.suggestedAmount.toLocaleString('en-IN')}</p>
          <p><strong>Target:</strong> ₹${stock.targetPrice.toFixed(0)}</p>
          <p><strong>Stop Loss:</strong> ₹${stock.stopLoss.toFixed(0)}</p>
        </div>
        <h3>Why Buy?</h3>
        <ul>
          ${stock.simpleWhy.map(r => `<li>${r}</li>`).join('')}
        </ul>
        <p><a href="${process.env.FRONTEND_URL}" style="display: inline-block; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 5px;">View in Dashboard</a></p>
      </div>
    </body>
    </html>
  `;

  return await sendEmail({ to: email, subject, html });
}

// ============================================
// DAILY DIGEST EMAIL
// ============================================

export async function sendDailyDigest(email, data) {
  const subject = `📊 Your Daily Investment Digest`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: Arial, sans-serif;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2>☀️ Good Morning!</h2>
        <h3>Today's Market Outlook</h3>
        <div style="background: #f3f4f6; padding: 20px; border-radius: 10px; margin: 20px 0;">
          <p><strong>Portfolio Value:</strong> ₹${data.portfolioValue.toLocaleString('en-IN')}</p>
          <p><strong>Today's P&L:</strong> ${data.todayPL >= 0 ? '+' : ''}₹${data.todayPL.toLocaleString('en-IN')}</p>
        </div>
        <h3>Top Picks Today:</h3>
        <ol>
          ${data.topPicks.map(s => `<li>${s.symbol} (${s.riskCategory}) - ₹${s.price.toFixed(0)}</li>`).join('')}
        </ol>
        <p><a href="${process.env.FRONTEND_URL}" style="display: inline-block; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 5px;">View Dashboard</a></p>
      </div>
    </body>
    </html>
  `;

  return await sendEmail({ to: email, subject, html });
}

// ============================================
// DEPLOY NOTIFICATION EMAIL
// ============================================

export async function sendDeployNotification(email, { commit, branch, time, commitMessage = '' }) {
  const shortSha = (commit || 'unknown').slice(0, 7);
  const subject = `🚀 Deployed ${shortSha} — invest.hungrytimes.in`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #1a1a1a; background: #f5f5f5; margin: 0; padding: 20px; }
        .container { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .header { background: #111827; padding: 24px 28px; }
        .header h1 { margin: 0; color: #fff; font-size: 18px; font-weight: 600; letter-spacing: -0.3px; }
        .header p { margin: 4px 0 0; color: #9ca3af; font-size: 13px; }
        .body { padding: 24px 28px; }
        .pill { display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; font-family: monospace; }
        .pill-green { background: #dcfce7; color: #15803d; }
        .pill-gray  { background: #f3f4f6; color: #374151; }
        .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
        .row:last-child { border-bottom: none; }
        .label { color: #6b7280; }
        .value { font-weight: 500; color: #111827; font-family: monospace; }
        .value.normal { font-family: Arial, sans-serif; }
        .footer { background: #f9fafb; padding: 14px 28px; font-size: 12px; color: #9ca3af; text-align: center; border-top: 1px solid #e5e7eb; }
        a { color: #4f46e5; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🚀 Deployment Successful</h1>
          <p>invest.hungrytimes.in &nbsp;·&nbsp; ${time}</p>
        </div>
        <div class="body">
          <div class="row">
            <span class="label">Status</span>
            <span class="pill pill-green">✓ LIVE</span>
          </div>
          <div class="row">
            <span class="label">Commit</span>
            <span class="value">${shortSha}</span>
          </div>
          <div class="row">
            <span class="label">Branch</span>
            <span class="pill pill-gray">${branch}</span>
          </div>
          ${commitMessage ? `<div class="row">
            <span class="label">Message</span>
            <span class="value normal" style="max-width:320px;text-align:right;">${commitMessage.replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,120)}</span>
          </div>` : ''}
          <div class="row">
            <span class="label">Full SHA</span>
            <span class="value" style="font-size:11px;">${commit}</span>
          </div>
        </div>
        <div class="footer">
          <a href="https://invest.hungrytimes.in">Open Dashboard</a>
          &nbsp;·&nbsp;
          <a href="https://invest.hungrytimes.in/api/health">Health Check</a>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmail({ to: email, subject, html });
}

export default {
  sendEmail,
  sendWelcomeEmail,
  sendOTP,
  sendPasswordResetEmail,
  sendBuyAlert,
  sendDailyDigest,
  sendDeployNotification
};
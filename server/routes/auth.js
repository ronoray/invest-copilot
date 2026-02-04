import express from 'express';
import * as authService from '../services/authService.js';
import * as emailService from '../services/emailService.js';
import * as smsService from '../services/smsService.js';
import logger from '../services/logger.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

/**
 * Authentication Routes
 * POST /api/auth/register - Register new user
 * POST /api/auth/login - Login with email/password
 * POST /api/auth/login-otp - Request OTP for login
 * POST /api/auth/verify-otp - Verify OTP and login
 * POST /api/auth/logout - Logout
 * POST /api/auth/refresh - Refresh access token
 * GET  /api/auth/me - Get current user
 * POST /api/auth/forgot-password - Request password reset
 * POST /api/auth/reset-password - Reset password
 * POST /api/auth/verify-email - Verify email
 * POST /api/auth/verify-phone - Verify phone
 */

// ============================================
// REGISTER
// ============================================

router.post('/register', async (req, res) => {
  try {
    const { email, phone, password, name } = req.body;

    // Validation
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Password strength
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Register
    const result = await authService.registerUser({ email, phone, password, name });

    // Send welcome email
    if (process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true') {
      await emailService.sendWelcomeEmail(email, name);
    }

    res.status(201).json(result);
  } catch (error) {
    logger.error('Register route error:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// LOGIN WITH PASSWORD
// ============================================

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await authService.loginUser({
      email,
      password,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.json(result);
  } catch (error) {
    logger.error('Login route error:', error);
    res.status(401).json({ error: error.message });
  }
});

// ============================================
// REQUEST OTP FOR LOGIN
// ============================================

router.post('/login-otp', async (req, res) => {
  try {
    const { identifier } = req.body; // email or phone

    if (!identifier) {
      return res.status(400).json({ error: 'Email or phone required' });
    }

    // Generate OTP
    const otp = await authService.generateOTP(identifier, 'login');

    // Send via appropriate channel
    if (identifier.includes('@')) {
      // Email
      if (process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true') {
        await emailService.sendOTP(identifier, otp);
      }
    } else {
      // Phone
      if (process.env.ENABLE_SMS_NOTIFICATIONS === 'true') {
        await smsService.sendOTP(identifier, otp);
      }
    }

    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (error) {
    logger.error('OTP request error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// ============================================
// VERIFY OTP AND LOGIN
// ============================================

router.post('/verify-otp', async (req, res) => {
  try {
    const { identifier, code } = req.body;

    if (!identifier || !code) {
      return res.status(400).json({ error: 'Identifier and code required' });
    }

    // Verify OTP
    await authService.verifyOTP(identifier, code, 'login');

    // Find user
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { phone: identifier }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate tokens
    const accessToken = authService.generateAccessToken(user.id, user.email);
    const refreshToken = authService.generateRefreshToken(user.id);

    // Create session
    await authService.createSession(
      user.id,
      accessToken,
      req.ip,
      req.get('user-agent')
    );

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    const { password, ...userWithoutPassword } = user;

    res.json({
      user: userWithoutPassword,
      accessToken,
      refreshToken
    });
  } catch (error) {
    logger.error('OTP verification error:', error);
    res.status(401).json({ error: error.message });
  }
});

// ============================================
// LOGOUT
// ============================================

router.post('/logout', authenticate, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      await authService.deleteSession(token);
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ============================================
// REFRESH TOKEN
// ============================================

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    const user = await authService.getUserById(decoded.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate new access token
    const accessToken = authService.generateAccessToken(user.id, user.email);

    res.json({ accessToken });
  } catch (error) {
    logger.error('Refresh token error:', error);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ============================================
// GET CURRENT USER
// ============================================

router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await authService.getUserById(req.user.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    logger.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ============================================
// FORGOT PASSWORD
// ============================================

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const result = await authService.requestPasswordReset(email);

    // Send reset email
    if (result.resetToken && process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true') {
      await emailService.sendPasswordResetEmail(email, result.resetToken);
    }

    res.json({ success: true, message: 'If email exists, reset link sent' });
  } catch (error) {
    logger.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ============================================
// RESET PASSWORD
// ============================================

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    await authService.resetPassword(token, password);

    res.json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    logger.error('Reset password error:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// VERIFY EMAIL
// ============================================

router.post('/verify-email', authenticate, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Verification code required' });
    }

    const user = await authService.getUserById(req.user.userId);
    await authService.verifyOTP(user.email, code, 'verify_email');
    await authService.verifyEmail(user.id);

    res.json({ success: true, message: 'Email verified' });
  } catch (error) {
    logger.error('Email verification error:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// VERIFY PHONE
// ============================================

router.post('/verify-phone', authenticate, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Verification code required' });
    }

    const user = await authService.getUserById(req.user.userId);
    await authService.verifyOTP(user.phone, code, 'verify_phone');
    await authService.verifyPhone(user.id);

    res.json({ success: true, message: 'Phone verified' });
  } catch (error) {
    logger.error('Phone verification error:', error);
    res.status(400).json({ error: error.message });
  }
});

// ============================================
// SEND EMAIL VERIFICATION
// ============================================

router.post('/send-email-verification', authenticate, async (req, res) => {
  try {
    const user = await authService.getUserById(req.user.userId);

    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email already verified' });
    }

    const otp = await authService.generateOTP(user.email, 'verify_email');

    if (process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true') {
      await emailService.sendOTP(user.email, otp);
    }

    res.json({ success: true, message: 'Verification code sent' });
  } catch (error) {
    logger.error('Send verification error:', error);
    res.status(500).json({ error: 'Failed to send verification' });
  }
});

// ============================================
// SEND PHONE VERIFICATION
// ============================================

router.post('/send-phone-verification', authenticate, async (req, res) => {
  try {
    const user = await authService.getUserById(req.user.userId);

    if (!user.phone) {
      return res.status(400).json({ error: 'No phone number on file' });
    }

    if (user.phoneVerified) {
      return res.status(400).json({ error: 'Phone already verified' });
    }

    const otp = await authService.generateOTP(user.phone, 'verify_phone');

    if (process.env.ENABLE_SMS_NOTIFICATIONS === 'true') {
      await smsService.sendOTP(user.phone, otp);
    }

    res.json({ success: true, message: 'Verification code sent' });
  } catch (error) {
    logger.error('Send verification error:', error);
    res.status(500).json({ error: 'Failed to send verification' });
  }
});

export default router;
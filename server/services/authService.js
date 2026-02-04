import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import logger from './logger.js';

const prisma = new PrismaClient();

/**
 * Authentication Service
 * Handles user registration, login, OTP verification, password reset
 */

// ============================================
// PASSWORD HASHING
// ============================================

export async function hashPassword(password) {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 10;
  return await bcrypt.hash(password, rounds);
}

export async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

// ============================================
// JWT TOKENS
// ============================================

export function generateAccessToken(userId, email) {
  return jwt.sign(
    { userId, email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

export function generateRefreshToken(userId) {
  return jwt.sign(
    { userId },
    process.env.REFRESH_TOKEN_SECRET,
    { expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d' }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    logger.error('Token verification failed:', error.message);
    return null;
  }
}

// ============================================
// USER REGISTRATION
// ============================================

export async function registerUser({ email, phone, password, name }) {
  try {
    // Check if user exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { phone: phone || undefined }
        ]
      }
    });

    if (existingUser) {
      throw new Error('User already exists with this email or phone');
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        phone,
        password: hashedPassword,
        name,
        role: 'user'
      }
    });

    logger.info(`New user registered: ${email}`);

    // Generate tokens
    const accessToken = generateAccessToken(user.id, user.email);
    const refreshToken = generateRefreshToken(user.id);

    // Create session
    await createSession(user.id, accessToken);

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken
    };
  } catch (error) {
    logger.error('Registration error:', error);
    throw error;
  }
}

// ============================================
// USER LOGIN
// ============================================

export async function loginUser({ email, password, ipAddress, userAgent }) {
  try {
    // Find user
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      throw new Error('Invalid credentials');
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil - new Date()) / 60000);
      throw new Error(`Account locked. Try again in ${minutesLeft} minutes`);
    }

    // Check if account is active
    if (!user.isActive) {
      throw new Error('Account is deactivated');
    }

    // Verify password
    const isValid = await comparePassword(password, user.password);

    if (!isValid) {
      // Increment login attempts
      const attempts = user.loginAttempts + 1;
      const maxAttempts = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5;
      const lockoutMinutes = parseInt(process.env.LOCKOUT_DURATION_MINUTES) || 15;

      if (attempts >= maxAttempts) {
        // Lock account
        await prisma.user.update({
          where: { id: user.id },
          data: {
            loginAttempts: attempts,
            lockedUntil: new Date(Date.now() + lockoutMinutes * 60000)
          }
        });
        throw new Error('Too many failed attempts. Account locked for 15 minutes');
      }

      // Update attempts
      await prisma.user.update({
        where: { id: user.id },
        data: { loginAttempts: attempts }
      });

      throw new Error('Invalid credentials');
    }

    // Reset login attempts and update last login
    await prisma.user.update({
      where: { id: user.id },
      data: {
        loginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date()
      }
    });

    // Generate tokens
    const accessToken = generateAccessToken(user.id, user.email);
    const refreshToken = generateRefreshToken(user.id);

    // Create session
    await createSession(user.id, accessToken, ipAddress, userAgent);

    // Audit log
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'login',
        ipAddress,
        userAgent
      }
    });

    logger.info(`User logged in: ${email}`);

    // Remove password from response
    const { password: _, ...userWithoutPassword } = user;

    return {
      user: userWithoutPassword,
      accessToken,
      refreshToken
    };
  } catch (error) {
    logger.error('Login error:', error);
    throw error;
  }
}

// ============================================
// OTP GENERATION & VERIFICATION
// ============================================

export async function generateOTP(identifier, type = 'login') {
  try {
    // Generate 6-digit OTP
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresMinutes = parseInt(process.env.OTP_EXPIRES_MINUTES) || 10;

    // Save to database
    await prisma.oTP.create({
      data: {
        identifier,
        code,
        type,
        expiresAt: new Date(Date.now() + expiresMinutes * 60000)
      }
    });

    logger.info(`OTP generated for ${identifier}`);
    return code;
  } catch (error) {
    logger.error('OTP generation error:', error);
    throw error;
  }
}

export async function verifyOTP(identifier, code, type = 'login') {
  try {
    const otp = await prisma.oTP.findFirst({
      where: {
        identifier,
        code,
        type,
        used: false,
        expiresAt: { gte: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!otp) {
      throw new Error('Invalid or expired OTP');
    }

    // Mark as used
    await prisma.oTP.update({
      where: { id: otp.id },
      data: { used: true }
    });

    logger.info(`OTP verified for ${identifier}`);
    return true;
  } catch (error) {
    logger.error('OTP verification error:', error);
    throw error;
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================

export async function createSession(userId, token, ipAddress, userAgent) {
  try {
    const expiresMinutes = parseInt(process.env.SESSION_TIMEOUT_MINUTES) || 30;

    return await prisma.session.create({
      data: {
        userId,
        token,
        ipAddress,
        userAgent,
        expiresAt: new Date(Date.now() + expiresMinutes * 60 * 60000)
      }
    });
  } catch (error) {
    logger.error('Session creation error:', error);
    throw error;
  }
}

export async function getSession(token) {
  try {
    return await prisma.session.findUnique({
      where: { token },
      include: { user: true }
    });
  } catch (error) {
    logger.error('Session retrieval error:', error);
    return null;
  }
}

export async function deleteSession(token) {
  try {
    await prisma.session.delete({
      where: { token }
    });
    logger.info('Session deleted');
  } catch (error) {
    logger.error('Session deletion error:', error);
  }
}

// ============================================
// PASSWORD RESET
// ============================================

export async function requestPasswordReset(email) {
  try {
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      // Don't reveal if user exists
      return { success: true };
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60000); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken,
        resetExpires
      }
    });

    logger.info(`Password reset requested for ${email}`);
    return { success: true, resetToken };
  } catch (error) {
    logger.error('Password reset request error:', error);
    throw error;
  }
}

export async function resetPassword(resetToken, newPassword) {
  try {
    const user = await prisma.user.findFirst({
      where: {
        resetToken,
        resetExpires: { gte: new Date() }
      }
    });

    if (!user) {
      throw new Error('Invalid or expired reset token');
    }

    const hashedPassword = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetExpires: null,
        loginAttempts: 0,
        lockedUntil: null
      }
    });

    logger.info(`Password reset successful for user ${user.id}`);
    return { success: true };
  } catch (error) {
    logger.error('Password reset error:', error);
    throw error;
  }
}

// ============================================
// EMAIL VERIFICATION
// ============================================

export async function verifyEmail(userId) {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { emailVerified: true }
    });
    logger.info(`Email verified for user ${userId}`);
  } catch (error) {
    logger.error('Email verification error:', error);
    throw error;
  }
}

// ============================================
// PHONE VERIFICATION
// ============================================

export async function verifyPhone(userId) {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { phoneVerified: true }
    });
    logger.info(`Phone verified for user ${userId}`);
  } catch (error) {
    logger.error('Phone verification error:', error);
    throw error;
  }
}

// ============================================
// USER UTILITIES
// ============================================

export async function getUserById(userId) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        name: true,
        role: true,
        isActive: true,
        emailVerified: true,
        phoneVerified: true,
        preferences: true,
        createdAt: true,
        lastLoginAt: true
      }
    });
    return user;
  } catch (error) {
    logger.error('Get user error:', error);
    return null;
  }
}

export async function updateUserPreferences(userId, preferences) {
  try {
    return await prisma.user.update({
      where: { id: userId },
      data: { preferences }
    });
  } catch (error) {
    logger.error('Update preferences error:', error);
    throw error;
  }
}
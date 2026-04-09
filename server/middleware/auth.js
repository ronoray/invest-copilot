import * as authService from '../services/authService.js';
import logger from '../services/logger.js';

/**
 * Authentication Middleware
 * Protects routes by verifying JWT tokens
 */

// ============================================
// AUTHENTICATE - Verify JWT Token
// ============================================

export async function authenticate(req, res, next) {
  try {
    // MCP service bypass — internal service calls only
    const mcpSecret = req.headers['x-mcp-secret'];
    if (mcpSecret) {
      if (mcpSecret !== process.env.MCP_SERVICE_SECRET) {
        return res.status(401).json({ error: 'Invalid MCP service secret' });
      }
      req.user = { userId: 1, id: 1, role: 'admin' };
      req.session = { user: { isActive: true } };
      return next();
    }

    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    // Verify token
    const decoded = authService.verifyToken(token);
    
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Check if session exists and is valid
    const session = await authService.getSession(token);
    
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    // Check if user is active
    if (!session.user.isActive) {
      return res.status(403).json({ error: 'Account deactivated' });
    }

    // Attach user to request
    req.user = decoded;
    req.session = session;
    
    next();
  } catch (error) {
    logger.error('Authentication middleware error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// ============================================
// REQUIRE ADMIN - Check if user is admin
// ============================================

export async function requireAdmin(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const user = await authService.getUserById(req.user.userId);
    
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    logger.error('Admin middleware error:', error);
    return res.status(403).json({ error: 'Access denied' });
  }
}

// ============================================
// REQUIRE EMAIL VERIFIED
// ============================================

export async function requireEmailVerified(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const user = await authService.getUserById(req.user.userId);
    
    if (!user.emailVerified) {
      return res.status(403).json({ 
        error: 'Email verification required',
        action: 'verify_email'
      });
    }

    next();
  } catch (error) {
    logger.error('Email verification middleware error:', error);
    return res.status(403).json({ error: 'Verification check failed' });
  }
}

// ============================================
// OPTIONAL AUTH - Don't fail if no token
// ============================================

export async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = authService.verifyToken(token);
      
      if (decoded) {
        const session = await authService.getSession(token);
        if (session && session.expiresAt >= new Date()) {
          req.user = decoded;
          req.session = session;
        }
      }
    }
    
    next();
  } catch (error) {
    // Don't fail, just continue without auth
    next();
  }
}

// validateCloudflareAccess removed — was a stub that only checked header presence
// without verifying the JWT signature. CF Access protection is enforced at the
// network/Cloudflare layer before requests reach this server.

// ============================================
// RATE LIMITING MIDDLEWARE
// ============================================

const loginAttempts = new Map();

export function rateLimitLogin(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000; // 15 min
  const maxAttempts = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 5;

  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }

  const attempts = loginAttempts.get(ip);

  if (now > attempts.resetAt) {
    // Reset window
    attempts.count = 1;
    attempts.resetAt = now + windowMs;
    return next();
  }

  if (attempts.count >= maxAttempts) {
    const remainingMs = attempts.resetAt - now;
    const remainingMin = Math.ceil(remainingMs / 60000);
    return res.status(429).json({ 
      error: `Too many login attempts. Try again in ${remainingMin} minutes` 
    });
  }

  attempts.count++;
  next();
}

// ============================================
// AUDIT LOG MIDDLEWARE
// ============================================

export async function auditLog(action, entity = null) {
  return async (req, res, next) => {
    try {
      // Run the route handler first
      const originalSend = res.send;
      
      res.send = function(data) {
        // Log after successful response
        if (res.statusCode < 400 && req.user) {
          prisma.auditLog.create({
            data: {
              userId: req.user.userId,
              action,
              entity,
              entityId: req.params.id ? parseInt(req.params.id) : null,
              ipAddress: req.ip,
              userAgent: req.get('user-agent'),
              metadata: {
                method: req.method,
                path: req.path,
                body: (() => {
                  const SENSITIVE = ['password', 'newPassword', 'currentPassword', 'confirmPassword', 'otp', 'code', 'token', 'refreshToken'];
                  const safe = { ...req.body };
                  for (const f of SENSITIVE) if (f in safe) safe[f] = '[REDACTED]';
                  return safe;
                })()
              }
            }
          }).catch(err => logger.error('Audit log error:', err));
        }
        
        originalSend.call(this, data);
      };
      
      next();
    } catch (error) {
      logger.error('Audit middleware error:', error);
      next();
    }
  };
}

export default {
  authenticate,
  requireAdmin,
  requireEmailVerified,
  optionalAuth,
  rateLimitLogin,
  auditLog
};
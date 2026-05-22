import { Request, Response, NextFunction } from 'express';
import { verifyToken, TenantPayload } from '../auth';
import { hasPermission, hasAnyPermission } from '../auth/permissions';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'api-middleware' });

export interface AuthenticatedRequest extends Request {
  tenant?: TenantPayload;
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const payload = verifyToken(token);
    req.tenant = payload;
    next();
  } catch (error: any) {
    log.debug({ error: error.message }, 'Token verification failed');
    res.status(401).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' },
    });
  }
}

/**
 * Permission middleware factory.
 * Usage: router.post('/x', authMiddleware, requirePermission('orders.manage'), handler)
 *
 * Checks that the authenticated user's permissions (loaded into JWT at login)
 * include the required permission (or a wildcard that covers it).
 *
 * Treats legacy tokens with no permissions array as super admin (backwards compat).
 */
export function requirePermission(...required: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.tenant) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
    // Legacy token (no permissions field) → treat as super admin for backwards compat
    const permissions = req.tenant.permissions;
    if (!permissions) {
      return next();
    }
    const ok = required.length === 1
      ? hasPermission(permissions, required[0])
      : hasAnyPermission(permissions, required);
    if (!ok) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Missing required permission: ${required.join(' or ')}`,
          required,
        },
      });
    }
    next();
  };
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  log.error({ error: err.message, stack: err.stack }, 'Unhandled API error');
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred' },
  });
}

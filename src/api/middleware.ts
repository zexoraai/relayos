import { Request, Response, NextFunction } from 'express';
import { verifyToken, TenantPayload } from '../auth';
import { verifyPackerToken, PackerPayload } from '../packerAuth';
import { hasPermission, hasAnyPermission } from '../auth/permissions';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'api-middleware' });

export interface AuthenticatedRequest extends Request {
  tenant?: TenantPayload;
}

/**
 * Same Bearer-token shape as tenant requests, but the JWT must carry the
 * packer audience claim. A tenant token will fail verification here (and
 * vice versa via authMiddleware) because of the audience mismatch built
 * into generatePackerToken / verifyPackerToken.
 */
export interface PackerAuthenticatedRequest extends Request {
  packer?: PackerPayload;
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
 * Auth middleware for packer-only routes. Packers carry a JWT issued
 * by generatePackerToken (audience='relayos-packer') and these are the
 * only tokens accepted here. Tenant tokens get rejected with the same
 * 401 INVALID_TOKEN as a malformed/expired packer token to avoid
 * leaking which audience the route is gated to.
 */
export function packerAuthMiddleware(req: PackerAuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Packer authentication required' },
    });
    return;
  }
  const token = authHeader.substring(7);
  try {
    const payload = verifyPackerToken(token);
    req.packer = payload;
    next();
  } catch (error: any) {
    log.debug({ error: error.message }, 'Packer token verification failed');
    res.status(401).json({
      success: false,
      error: { code: 'INVALID_TOKEN', message: 'Invalid or expired packer token' },
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
 * Behavior:
 *  - No `permissions` field on the token (legacy / pre-RBAC JWT) → 401 with
 *    code TOKEN_EXPIRED_REAUTH_REQUIRED so the frontend can clear the token
 *    and force re-login. The backfill on next login will mint a token with
 *    the user's actual permissions.
 *  - Empty `permissions: []`         → 403 FORBIDDEN
 *  - Permissions present but missing → 403 FORBIDDEN with the required list
 *  - Match (incl. '*' / 'module.*')  → next()
 */
export function requirePermission(...required: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.tenant) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
    const permissions = req.tenant.permissions;
    // Legacy token (no permissions field) → force re-auth so a fresh token with
    // the proper permissions array is issued.
    if (permissions === undefined || permissions === null) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'TOKEN_EXPIRED_REAUTH_REQUIRED',
          message: 'Your session predates the latest access-control update. Please log in again.',
        },
      });
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

/**
 * Pin the four-branch behavior of `requirePermission` in src/api/middleware.ts.
 *
 * This test makes no source change to middleware.ts; it pins current shape so a
 * future regression of the legacy `if (!permissions) return next()` form fails CI.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 6.1, 6.5
 * Design:    §Components and Interfaces > 1. `src/api/middleware.ts`
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Pin a deterministic JWT secret for the lifetime of this test file. The
// middleware reads `process.env.JWT_SECRET` lazily at request time via
// `verifyToken`, so setting it before any request is sufficient.
const TEST_JWT_SECRET = 'rbac-middleware-test-secret-key';
process.env.JWT_SECRET = TEST_JWT_SECRET;

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { authMiddleware, requirePermission } from '../../src/api/middleware';

/**
 * Build an in-test Express app whose only protected route mounts the exact
 * handler chain under test:
 *   [authMiddleware, requirePermission('orders.view'), handler]
 */
function buildApp(): express.Express {
  const app = express();
  app.get(
    '/protected',
    authMiddleware,
    requirePermission('orders.view'),
    (_req, res) => {
      res.json({ ok: true });
    }
  );
  return app;
}

/**
 * Mint a JWT against the test JWT_SECRET. `payload` is signed verbatim, so
 * callers can produce a token whose `permissions` field is missing entirely
 * (omit the key) or set to a specific array.
 */
function mintToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1h' });
}

describe('requirePermission — four-branch behavior', () => {
  let app: express.Express;

  beforeAll(() => {
    app = buildApp();
  });

  it('Case 1: payload omits `permissions` entirely → 401 TOKEN_EXPIRED_REAUTH_REQUIRED', async () => {
    // A legacy / pre-RBAC token: tenantId + email but no permissions claim.
    const token = mintToken({
      tenantId: 'tenant-legacy',
      email: 'legacy@example.com',
    });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body?.error?.code).toBe('TOKEN_EXPIRED_REAUTH_REQUIRED');
  });

  it('Case 2: payload `permissions: []` → 403 FORBIDDEN with required=["orders.view"]', async () => {
    const token = mintToken({
      tenantId: 'tenant-a',
      email: 'empty@example.com',
      permissions: [],
    });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('FORBIDDEN');
    expect(res.body?.error?.required).toEqual(['orders.view']);
  });

  it('Case 3: payload `permissions: ["customers.view"]` → 403 FORBIDDEN with required=["orders.view"]', async () => {
    const token = mintToken({
      tenantId: 'tenant-a',
      email: 'wrong-perm@example.com',
      permissions: ['customers.view'],
    });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('FORBIDDEN');
    expect(res.body?.error?.required).toEqual(['orders.view']);
  });

  it('Case 4: payload `permissions: ["orders.view"]` → 200 { ok: true }', async () => {
    const token = mintToken({
      tenantId: 'tenant-a',
      email: 'allowed@example.com',
      permissions: ['orders.view'],
    });

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

/**
 * Smoke test for `JWT_SECRET` rotation as the RBAC rollout's token-invalidation
 * strategy (see `.kiro/specs/rbac-enforcement-audit/design.md` §Rollout Plan >
 * Token invalidation strategy).
 *
 * Scenario:
 *
 *   1. A JWT is minted against secret `OLD` (simulates a token issued before
 *      the rollout).
 *   2. The Express app is booted with `process.env.JWT_SECRET = 'NEW'` set
 *      BEFORE any auth code runs (mirrors the deploy step that rotates the
 *      secret).
 *   3. A request to `GET /auth/me` carrying the old-secret JWT is rejected
 *      by `authMiddleware` because `jwt.verify` fails with a signature
 *      mismatch.
 *
 * The signature failure happens entirely inside `authMiddleware`; the
 * `/auth/me` handler is never invoked, and no DB query is reached. The
 * `vi.mock('../../src/db/connection', ...)` shim is included only as a safety
 * net so the test can never accidentally hit a real database.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4
 * Design:    §Rollout Plan > Token invalidation strategy; §Error Handling
 */

import { describe, it, expect, vi } from 'vitest';

// CRITICAL: set the post-rotation secret BEFORE importing any module that
// reads `process.env.JWT_SECRET`. `getJwtSecret()` in `src/auth/index.ts`
// reads `process.env.JWT_SECRET` per call, so the value at request time is
// what matters — but mirroring the pattern in the other rbac tests
// (loginTenantBackfill.test.ts, authMe.test.ts) keeps the failure mode
// identical and removes any ordering ambiguity.
process.env.JWT_SECRET = 'NEW';

// In-memory DB stub. `/auth/me` would normally query `user_permissions`, but
// `authMiddleware` rejects the request first on signature failure, so this
// stub should never be touched. It exists only so an accidental DB hit fails
// loudly rather than connecting to a real Postgres.
vi.mock('../../src/db/connection', () => ({
  getDb: () => {
    throw new Error(
      'getDb() should not be reached: authMiddleware must reject the old-secret JWT before any handler runs',
    );
  },
  closeDb: async () => {},
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import authRoutes from '../../src/api/authRoutes';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  return app;
}

describe('JWT_SECRET rotation forces re-login (task 5.1)', () => {
  it('rejects a token signed with the OLD secret with 401 INVALID_TOKEN when the server runs with the NEW secret', async () => {
    // Mint a JWT against the pre-rotation secret. This simulates a token
    // issued before the deploy that rotates JWT_SECRET.
    const oldSecret = 'OLD';
    const oldToken = jwt.sign(
      {
        tenantId: 'tenant-pre-rotation',
        email: 'user@example.com',
        userId: 'user-pre-rotation',
        permissions: ['orders.view'],
      },
      oldSecret,
      { expiresIn: '1h' },
    );

    // Sanity check: the new-secret value the app sees is in fact different
    // from the secret we just signed with. If these ever match, the test
    // would silently pass for the wrong reason.
    expect(process.env.JWT_SECRET).toBe('NEW');
    expect(process.env.JWT_SECRET).not.toBe(oldSecret);

    const app = buildApp();
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${oldToken}`);

    expect(res.status).toBe(401);
    expect(res.body?.success).toBe(false);
    // INVALID_TOKEN is the signature-failure code emitted by
    // `authMiddleware` in `src/api/middleware.ts`. It is distinct from
    // TOKEN_EXPIRED_REAUTH_REQUIRED (which is the legacy-token branch in
    // `requirePermission` / `/auth/me`) and from UNAUTHORIZED (missing
    // Authorization header).
    expect(res.body?.error?.code).toBe('INVALID_TOKEN');
  });
});

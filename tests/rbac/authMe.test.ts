/**
 * Pin the response shape of `GET /auth/me` and the legacy-token branch in
 * `src/api/authRoutes.ts`.
 *
 * Two cases:
 *
 *   1. Non-Legacy_Token (JWT carries `userId`, `email`, `permissions`, and the
 *      tenant_user has `user_permissions` rows of exactly
 *      ['orders.view', 'orders.manage']) → HTTP 200 with
 *      `data.user.permissions` equal to those two strings (order-insensitive).
 *      The route re-queries permissions live from `user_permissions` so the
 *      DB rows — not the JWT claim — are what gets surfaced.
 *
 *   2. Legacy_Token (JWT payload has no `permissions` field, no `userId`)
 *      → HTTP 401 with body `error.code === 'TOKEN_EXPIRED_REAUTH_REQUIRED'`.
 *
 * This task makes no source change. It pins the existing live-DB query and
 * legacy-token branch so a future regression of either fails CI.
 *
 * Validates: Requirements 3.1, 3.2, 6.1
 * Design:    §Components and Interfaces > 4. `src/api/authRoutes.ts` — `/auth/me`
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Pin JWT secret before any auth code reads it. vi.mock below is hoisted, but
// process.env writes are not — keep this at the very top of the file, mirroring
// loginTenantBackfill.test.ts.
process.env.JWT_SECRET = 'rbac-auth-me-test-secret';

/**
 * In-memory database mock matching the shape used by loginTenantBackfill.test.ts:
 * supports db(table).where(criteria).first() / .select(...cols), and the
 * insert / update / returning forms used elsewhere in the auth module. The
 * `/auth/me` path itself only needs `where().first()` (for tenants) and
 * `where().select('permission')` (for user_permissions).
 */
type FakeTables = {
  tenants: any[];
  tenant_users: any[];
  user_permissions: any[];
  tenant_onboarding_events: any[];
};

const tables: FakeTables = {
  tenants: [],
  tenant_users: [],
  user_permissions: [],
  tenant_onboarding_events: [],
};

function resetTables() {
  tables.tenants = [];
  tables.tenant_users = [];
  tables.user_permissions = [];
  tables.tenant_onboarding_events = [];
}

let idCounter = 0;
function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString().padStart(8, '0')}`;
}

function matchesAll(row: any, criteria: any): boolean {
  for (const k of Object.keys(criteria)) {
    if (row[k] !== criteria[k]) return false;
  }
  return true;
}

function makeBuilder(table: keyof FakeTables) {
  const whereClauses: any[] = [];

  function applyWhere(): any[] {
    return tables[table].filter((row: any) =>
      whereClauses.every((c) => matchesAll(row, c)),
    );
  }

  const builder: any = {
    where(criteria: any) {
      whereClauses.push(criteria);
      return builder;
    },
    async first() {
      return applyWhere()[0];
    },
    async select(...cols: string[]) {
      const rows = applyWhere();
      if (cols.length === 0) return rows.map((r) => ({ ...r }));
      return rows.map((r) => {
        const out: any = {};
        for (const c of cols) out[c] = r[c];
        return out;
      });
    },
    async update(data: any) {
      const matches = applyWhere();
      for (const m of matches) Object.assign(m, data);
      return matches.length;
    },
    insert(data: any) {
      const rows = Array.isArray(data) ? data : [data];
      const inserted = rows.map((row: any) => {
        const newRow = { ...row };
        if (!newRow.id) newRow.id = genId(String(table));
        tables[table].push(newRow);
        return newRow;
      });
      const result: any = {
        then(onF: any, onR: any) {
          return Promise.resolve().then(onF, onR);
        },
        returning(col: string | string[]) {
          const cols = Array.isArray(col) ? col : [col];
          return Promise.resolve(
            inserted.map((r) => {
              const obj: any = {};
              for (const c of cols) obj[c] = r[c];
              return obj;
            }),
          );
        },
      };
      return result;
    },
  };
  return builder;
}

const fakeDb: any = (table: string) => makeBuilder(table as keyof FakeTables);

vi.mock('../../src/db/connection', () => ({
  getDb: () => fakeDb,
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

function signToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: '1h' });
}

describe('GET /auth/me — permissions shape and legacy-token behavior (task 1.5)', () => {
  beforeEach(() => {
    resetTables();
  });

  it('returns the live user_permissions array on a non-legacy token (Requirement 3.1)', async () => {
    const tenantId = genId('tenant');
    const userId = genId('user');
    const email = 'tenant-user@example.com';

    tables.tenants.push({
      id: tenantId,
      email,
      status: 'active',
      onboarding_step: 'completed',
    });
    // The /auth/me handler queries user_permissions directly by user_id; the
    // tenant_users row itself is not consulted in that path, but we seed it
    // for realism.
    tables.tenant_users.push({
      id: userId,
      tenant_id: tenantId,
      email,
      status: 'active',
    });
    tables.user_permissions.push(
      { user_id: userId, permission: 'orders.view' },
      { user_id: userId, permission: 'orders.manage' },
    );

    // Non-legacy token: includes userId AND permissions claim. The exact
    // permissions in the JWT payload don't have to match the DB rows — the
    // route re-queries user_permissions live and uses those.
    const token = signToken({
      tenantId,
      email,
      userId,
      permissions: ['orders.view', 'orders.manage'],
    });

    const app = buildApp();
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    const perms = res.body?.data?.user?.permissions;
    expect(Array.isArray(perms)).toBe(true);
    expect(perms.every((p: unknown) => typeof p === 'string')).toBe(true);
    // Order-insensitive equality.
    expect([...perms].sort()).toEqual(['orders.manage', 'orders.view']);
  });

  it('rejects a legacy token (no permissions claim) with 401 TOKEN_EXPIRED_REAUTH_REQUIRED (Requirements 3.2, 6.1)', async () => {
    const tenantId = genId('tenant');
    const email = 'legacy-tenant@example.com';

    tables.tenants.push({
      id: tenantId,
      email,
      status: 'active',
      onboarding_step: 'completed',
    });

    // Legacy token shape: only tenantId + email, no userId, no permissions.
    const legacyToken = signToken({ tenantId, email });

    const app = buildApp();
    const res = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${legacyToken}`);

    expect(res.status).toBe(401);
    expect(res.body?.success).toBe(false);
    expect(res.body?.error?.code).toBe('TOKEN_EXPIRED_REAUTH_REQUIRED');
  });
});

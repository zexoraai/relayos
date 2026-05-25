/**
 * Verify the bounded backfill behavior of `loginTenant` in src/auth/index.ts.
 *
 * Three scenarios:
 *
 *   1. Happy path — tenant with zero tenant_users rows AND tenants.email
 *      matches the login email. The backfill mints one tenant_users row
 *      with permissions equal to ROLE_PRESETS.super_admin (still ['*'])
 *      and login succeeds.
 *
 *   2. Ambiguous path — tenant has at least one tenant_users row but none
 *      whose email matches tenants.email. Login is rejected with
 *      AuthError('RBAC_REVIEW_REQUIRED'); no user_permissions rows are
 *      written; exactly one tenant_onboarding_events row of type
 *      'rbac_review_required' is recorded with the documented JSON payload
 *      shape; the /auth/login route returns HTTP 401 with that code.
 *
 *   3. Already-migrated path — a tenant_users row exists whose email equals
 *      tenants.email. Login goes through the multi-user RBAC path and
 *      succeeds without any backfill writes or onboarding events.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
 * Design:    §Components and Interfaces > 3. `src/auth/index.ts` —
 *            `loginTenant`; §Error Handling
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Pin the JWT secret before any auth code reads it.
process.env.JWT_SECRET = 'rbac-login-tenant-backfill-test-secret';

/**
 * In-memory database mock. Models a tiny subset of knex's fluent API — enough
 * to drive every db call inside `loginTenant`:
 *   - db(table).where(criteria).first()
 *   - db(table).where(criteria).select(...cols)
 *   - db(table).where(criteria).update(data)
 *   - db(table).insert(data)            // when awaited returns void
 *   - db(table).insert(data).returning(col)  // returns inserted rows
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
      // The returned object is itself a thenable (so `await db('x').insert(...)`
      // resolves with no value), and exposes `.returning(col)` to fetch the
      // inserted rows projected onto the requested columns.
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

// Mock getDb() to return our in-memory builder. vi.mock is hoisted to the
// top of the file, so this takes effect before src/auth imports getDb.
vi.mock('../../src/db/connection', () => ({
  getDb: () => fakeDb,
  closeDb: async () => {},
}));

import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { loginTenant, hashPassword, AuthError, verifyToken } from '../../src/auth';
import authRoutes from '../../src/api/authRoutes';
import { ROLE_PRESETS } from '../../src/auth/permissions';

const TENANT_EMAIL = 'owner@example.com';
const TENANT_PASSWORD = 'CorrectHorseBatteryStaple1!';

let cachedHash: string;

async function getPasswordHash(): Promise<string> {
  if (!cachedHash) {
    cachedHash = await hashPassword(TENANT_PASSWORD);
  }
  return cachedHash;
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  return app;
}

describe('loginTenant — bounded `*` backfill (task 1.4)', () => {
  beforeAll(async () => {
    // Warm the bcrypt hash once; bcrypt is slow.
    await getPasswordHash();
  });

  beforeEach(() => {
    resetTables();
  });

  describe('Happy path: zero tenant_users + matching tenants.email', () => {
    it('mints exactly one tenant_users row with super_admin permissions and succeeds', async () => {
      // Seed: only a tenants row, no tenant_users / user_permissions yet.
      const tenantId = genId('tenant');
      tables.tenants.push({
        id: tenantId,
        email: TENANT_EMAIL,
        password_hash: await getPasswordHash(),
        status: 'active',
        onboarding_step: 'completed',
      });

      const result = await loginTenant(TENANT_EMAIL, TENANT_PASSWORD);

      // Login produced a token whose permissions claim reflects ROLE_PRESETS.super_admin.
      expect(result.token).toBeTruthy();
      const payload = verifyToken(result.token);
      expect(payload.tenantId).toBe(tenantId);
      expect(payload.permissions).toEqual(ROLE_PRESETS.super_admin);

      // Exactly one tenant_users row was inserted.
      expect(tables.tenant_users).toHaveLength(1);
      expect(tables.tenant_users[0].tenant_id).toBe(tenantId);
      expect(tables.tenant_users[0].email).toBe(TENANT_EMAIL);
      expect(tables.tenant_users[0].status).toBe('active');

      // The user_permissions rows match ROLE_PRESETS.super_admin exactly (one row, value '*').
      const perms = tables.user_permissions
        .filter((p) => p.user_id === tables.tenant_users[0].id)
        .map((p) => p.permission);
      expect(perms).toEqual(ROLE_PRESETS.super_admin);

      // No review event written.
      expect(tables.tenant_onboarding_events).toHaveLength(0);
    });
  });

  describe('Ambiguous path: existing tenant_users rows, none match tenants.email', () => {
    it('throws AuthError(RBAC_REVIEW_REQUIRED), writes one onboarding event, writes no permissions', async () => {
      const tenantId = genId('tenant');
      tables.tenants.push({
        id: tenantId,
        email: TENANT_EMAIL,
        password_hash: await getPasswordHash(),
        status: 'active',
        onboarding_step: 'completed',
      });

      // Multiple tenant_users rows that do NOT match tenants.email and also
      // do NOT match the login email (so the multi-user path doesn't pick
      // them up). They might have been created out-of-band before the audit.
      const userA = genId('user');
      const userB = genId('user');
      tables.tenant_users.push(
        {
          id: userA,
          tenant_id: tenantId,
          email: 'alice@example.com',
          password_hash: 'unrelated-hash',
          status: 'disabled',
        },
        {
          id: userB,
          tenant_id: tenantId,
          email: 'bob@example.com',
          password_hash: 'unrelated-hash',
          status: 'disabled',
        },
      );

      await expect(loginTenant(TENANT_EMAIL, TENANT_PASSWORD)).rejects.toMatchObject({
        name: 'AuthError',
        code: 'RBAC_REVIEW_REQUIRED',
      });

      // No permission writes.
      expect(tables.user_permissions).toHaveLength(0);
      // No new tenant_users rows.
      expect(tables.tenant_users).toHaveLength(2);

      // Exactly one onboarding event of the right type and shape.
      expect(tables.tenant_onboarding_events).toHaveLength(1);
      const ev = tables.tenant_onboarding_events[0];
      expect(ev.tenant_id).toBe(tenantId);
      expect(ev.event_type).toBe('rbac_review_required');
      const payload = JSON.parse(ev.event_payload);
      expect(payload).toEqual({
        tenant_id: tenantId,
        candidate_user_ids: expect.arrayContaining([userA, userB]),
        tenant_email: TENANT_EMAIL,
        reason: 'ambiguous_legacy_super_admin',
      });
      expect(payload.candidate_user_ids).toHaveLength(2);
    });

    it('via POST /auth/login responds HTTP 401 with code RBAC_REVIEW_REQUIRED', async () => {
      const tenantId = genId('tenant');
      tables.tenants.push({
        id: tenantId,
        email: TENANT_EMAIL,
        password_hash: await getPasswordHash(),
        status: 'active',
        onboarding_step: 'completed',
      });
      tables.tenant_users.push(
        {
          id: genId('user'),
          tenant_id: tenantId,
          email: 'alice@example.com',
          password_hash: 'unrelated-hash',
          status: 'disabled',
        },
        {
          id: genId('user'),
          tenant_id: tenantId,
          email: 'bob@example.com',
          password_hash: 'unrelated-hash',
          status: 'disabled',
        },
      );

      const app = buildApp();
      const res = await request(app)
        .post('/auth/login')
        .send({ email: TENANT_EMAIL, password: TENANT_PASSWORD });

      expect(res.status).toBe(401);
      expect(res.body?.success).toBe(false);
      expect(res.body?.error?.code).toBe('RBAC_REVIEW_REQUIRED');

      // The route also wrote a single review event — same invariant as the unit case.
      expect(tables.tenant_onboarding_events).toHaveLength(1);
      expect(tables.tenant_onboarding_events[0].event_type).toBe('rbac_review_required');
      expect(tables.user_permissions).toHaveLength(0);
    });
  });

  describe('Already-migrated path: tenant_users row matches tenants.email', () => {
    it('uses the multi-user path, performs no backfill, writes no events', async () => {
      const tenantId = genId('tenant');
      const userId = genId('user');
      const passwordHash = await getPasswordHash();

      tables.tenants.push({
        id: tenantId,
        email: TENANT_EMAIL,
        password_hash: passwordHash,
        status: 'active',
        onboarding_step: 'completed',
      });
      tables.tenant_users.push({
        id: userId,
        tenant_id: tenantId,
        email: TENANT_EMAIL,
        password_hash: passwordHash,
        status: 'active',
        display_name: 'Owner',
      });
      // Pre-existing permissions for that user.
      tables.user_permissions.push(
        { user_id: userId, permission: 'orders.view' },
        { user_id: userId, permission: 'orders.manage' },
      );

      const before = {
        users: tables.tenant_users.length,
        perms: tables.user_permissions.length,
        events: tables.tenant_onboarding_events.length,
      };

      const result = await loginTenant(TENANT_EMAIL, TENANT_PASSWORD);

      expect(result.token).toBeTruthy();
      const payload = verifyToken(result.token);
      expect(payload.tenantId).toBe(tenantId);
      expect(payload.userId).toBe(userId);
      expect(payload.permissions).toEqual(['orders.view', 'orders.manage']);

      // No new tenant_users rows, no new permissions, no events written.
      expect(tables.tenant_users).toHaveLength(before.users);
      expect(tables.user_permissions).toHaveLength(before.perms);
      expect(tables.tenant_onboarding_events).toHaveLength(before.events);
      expect(tables.tenant_onboarding_events).toHaveLength(0);
    });
  });
});

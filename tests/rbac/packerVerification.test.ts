/**
 * Packer-role verification suite — task 4.1.
 *
 * Walks every entry in `ROUTE_PERMISSION_MAP` and asserts the 401/403/2xx
 * status policy from design Property 2 for a packer-role JWT.
 *
 * For each non-`auth-only` route entry `e`:
 *
 *   - allowed = hasAnyPermission(ROLE_PRESETS.packer, normalizeRequired(e.permission))
 *   - If allowed:    response status MUST NOT be 401 or 403.
 *                    (200/201/204/400/404/409/422/500 are all fine — the auth
 *                    gate let the request through to the handler.)
 *   - If !allowed:   HTTP 403, body `error.code === 'FORBIDDEN'`, and body
 *                    `error.required` is an array containing the route's
 *                    required permission(s).
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.6, 2.5
 * Design:    §Testing Strategy > Integration tests; §Correctness Properties > Property 2
 */

import { describe, it, expect } from 'vitest';

// JWT secret has to be set before any auth code reads it. vi.mock below is
// hoisted to the top, but process.env writes are not — keep this above any
// imports of src/auth or src/api.
process.env.JWT_SECRET = 'rbac-packer-verification-test-secret';

import { vi } from 'vitest';

/**
 * In-memory knex shim. Models the fluent subset every authenticated route
 * handler in src/api/*Routes.ts uses:
 *
 *   db(table)
 *     .where(criteria) | .where(col, val) | .where(col, op, val) | .where(fn)
 *     .andWhere(...)   | .orWhere(...)
 *     .whereNotNull(col) | .whereNull(col) | .whereIn(col, vals)
 *     .leftJoin(...)   | .innerJoin(...)   // collected, ignored at filter time
 *     .orderBy(col, dir?)
 *     .limit(n) | .offset(n)
 *     .select(...cols) | .count(expr)      // both await-able; first() too
 *     .max(expr) | .min(expr)
 *     .insert(rows) | .insert(rows).returning(cols)
 *     .update(data)
 *     .delete()
 *     .first(...cols)
 *
 *   db.raw(...)        // returns a tagged opaque value, ignored
 *   db.transaction(fn) // calls fn(trx) where trx is the same db
 *
 * The shim is deliberately permissive: it returns empty arrays / undefined
 * from `first()` so the route handlers usually fall through to a 404 — that
 * still satisfies the "auth gate let me past" condition. When a handler
 * does write, the writes hit the in-memory tables but are not asserted on.
 */

type Row = Record<string, unknown>;

const tables: Record<string, Row[]> = Object.create(null);
function tableOf(name: string): Row[] {
  if (!tables[name]) tables[name] = [];
  return tables[name];
}

let idCounter = 0;
function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString().padStart(8, '0')}`;
}

function rowMatches(row: Row, criteria: Row): boolean {
  for (const k of Object.keys(criteria)) {
    if (row[k] !== criteria[k]) return false;
  }
  return true;
}

function makeBuilder(tableName: string) {
  // Strip a knex alias suffix like 'orders as o' down to 'orders' for the
  // in-memory store. Aliased reads still work; alias-prefixed where clauses
  // (e.g. .where('fj.tenant_id', x)) are filtered loosely below.
  const baseTable = tableName.split(/\s+as\s+/i)[0];

  // Collected filter predicates over the rows in baseTable.
  const predicates: Array<(row: Row) => boolean> = [];

  function applyFilters(): Row[] {
    const rows = tableOf(baseTable);
    return rows.filter((r) => predicates.every((p) => p(r)));
  }

  // Helper: given a column ref that might be 'col' or 'alias.col',
  // return the bare column name we'll look up on rows.
  function bareCol(col: string): string {
    const idx = col.indexOf('.');
    return idx >= 0 ? col.slice(idx + 1) : col;
  }

  const builder: any = {
    // --- WHERE-family --------------------------------------------------------
    where(...args: unknown[]) {
      if (args.length === 1) {
        const arg = args[0];
        if (typeof arg === 'function') {
          // .where(function() { this.where(...).orWhere(...) }) — we don't
          // model OR groups; treat as a no-op so rows pass through.
          return builder;
        }
        if (arg && typeof arg === 'object') {
          const criteria = arg as Row;
          predicates.push((r) => rowMatches(r, criteria));
          return builder;
        }
      }
      if (args.length === 2) {
        const [col, val] = args as [string, unknown];
        const bare = bareCol(col);
        predicates.push((r) => r[bare] === val);
        return builder;
      }
      if (args.length === 3) {
        const [col, op, val] = args as [string, string, unknown];
        const bare = bareCol(col);
        if (op === '=' || op === '==') {
          predicates.push((r) => r[bare] === val);
        } else if (op === '!=' || op === '<>') {
          predicates.push((r) => r[bare] !== val);
        } else if (op === '<') {
          predicates.push((r) => (r[bare] as any) < (val as any));
        } else if (op === '>') {
          predicates.push((r) => (r[bare] as any) > (val as any));
        } else if (op === '>=') {
          predicates.push((r) => (r[bare] as any) >= (val as any));
        } else if (op === '<=') {
          predicates.push((r) => (r[bare] as any) <= (val as any));
        } else {
          // ilike / like / unknown: don't filter, leave rows.
        }
        return builder;
      }
      return builder;
    },
    andWhere(...args: unknown[]) {
      return builder.where(...args);
    },
    orWhere() {
      // We don't model OR semantics; treat as no-op.
      return builder;
    },
    whereNot(criteria: Row) {
      predicates.push((r) => !rowMatches(r, criteria));
      return builder;
    },
    whereNotNull(col: string) {
      const bare = bareCol(col);
      predicates.push((r) => r[bare] !== null && r[bare] !== undefined);
      return builder;
    },
    whereNull(col: string) {
      const bare = bareCol(col);
      predicates.push((r) => r[bare] === null || r[bare] === undefined);
      return builder;
    },
    whereIn(col: string, vals: unknown[]) {
      const bare = bareCol(col);
      predicates.push((r) => vals.includes(r[bare]));
      return builder;
    },
    onConflict() {
      return { ignore: () => Promise.resolve(0), merge: () => Promise.resolve(0) };
    },

    // --- JOINs (no-op; matched rows stay in baseTable) -----------------------
    leftJoin() { return builder; },
    innerJoin() { return builder; },
    join() { return builder; },

    // --- ORDER / LIMIT (no-op for filtering, only affects iteration order) ---
    orderBy() { return builder; },
    limit() { return builder; },
    offset() { return builder; },
    groupBy() { return builder; },

    // --- TERMINAL READS ------------------------------------------------------
    async first(..._cols: unknown[]) {
      return applyFilters()[0];
    },
    async select(..._cols: unknown[]) {
      return applyFilters().map((r) => ({ ...r }));
    },
    async count(_expr: unknown) {
      return [{ count: String(applyFilters().length) }];
    },
    async max(_expr: unknown) {
      return [{ max: null }];
    },
    async min(_expr: unknown) {
      return [{ min: null }];
    },
    async pluck(col: string) {
      return applyFilters().map((r) => r[col]);
    },

    // --- WRITES --------------------------------------------------------------
    insert(data: Row | Row[]) {
      const rows = Array.isArray(data) ? data : [data];
      const inserted: Row[] = rows.map((row) => {
        const out: Row = { ...row };
        if (out.id === undefined) out.id = genId(baseTable);
        tableOf(baseTable).push(out);
        return out;
      });
      const result: any = {
        then(onF: any, onR: any) { return Promise.resolve(undefined).then(onF, onR); },
        returning(col: string | string[]) {
          const cols = Array.isArray(col) ? col : [col];
          if (cols.length === 1 && cols[0] === '*') {
            return Promise.resolve(inserted.map((r) => ({ ...r })));
          }
          return Promise.resolve(
            inserted.map((r) => {
              const obj: Row = {};
              for (const c of cols) obj[c] = r[c];
              return obj;
            }),
          );
        },
        onConflict() {
          return { ignore: () => Promise.resolve(0), merge: () => Promise.resolve(0) };
        },
      };
      return result;
    },
    async update(data: Row) {
      const rows = applyFilters();
      for (const r of rows) Object.assign(r, data);
      return rows.length;
    },
    async delete() {
      const all = tableOf(baseTable);
      const keep: Row[] = [];
      let removed = 0;
      for (const r of all) {
        if (predicates.every((p) => p(r))) removed += 1;
        else keep.push(r);
      }
      tables[baseTable] = keep;
      return removed;
    },
  };

  // Make the builder itself awaitable so that
  // `await db('x').where(...)` resolves to the matched rows.
  builder.then = (onF: any, onR: any) =>
    Promise.resolve(applyFilters().map((r) => ({ ...r }))).then(onF, onR);

  return builder;
}

const fakeDb: any = function db(tableName: string) {
  return makeBuilder(tableName);
};
fakeDb.raw = (s: string) => ({ __raw: s });
fakeDb.transaction = async (fn: (trx: any) => any) => fn(fakeDb);

vi.mock('../../src/db/connection', () => ({
  getDb: () => fakeDb,
  closeDb: async () => {},
}));

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { ROLE_PRESETS, hasAnyPermission } from '../../src/auth/permissions';
import { ROUTE_PERMISSION_MAP, normalizeRequired, type RouteSpec } from '../../src/api/routePermissionMap';
import { REQUEST_BODIES } from './fixtures/requestBodies';

// Per-router imports. Mounting matches src/api/index.ts createApiServer().
import authRoutes from '../../src/api/authRoutes';
import healthRoutes from '../../src/api/healthRoutes';
import pipelineRoutes from '../../src/api/pipelineRoutes';
import fulfillmentRoutes from '../../src/api/fulfillmentRoutes';
import customersRoutes from '../../src/api/customersRoutes';
import settingsRoutes from '../../src/api/settingsRoutes';
import caretakerRoutes from '../../src/api/caretakerRoutes';
import whatsappRoutes from '../../src/api/whatsappRoutes';
import knowledgeRoutes from '../../src/api/knowledgeRoutes';
import idempotencyRoutes from '../../src/api/idempotencyRoutes';
import dlqRoutes from '../../src/api/dlqRoutes';
import usageRoutes from '../../src/api/usageRoutes';
import agentRunsRoutes from '../../src/api/agentRunsRoutes';
import usersRoutes from '../../src/api/usersRoutes';
import packerRoutes from '../../src/api/packerRoutes';
import chatbotSettingsRoutes from '../../src/api/chatbotSettingsRoutes';
import marketingRoutes from '../../src/api/marketingRoutes';
import manualRoutes from '../../src/api/manualRoutes';

// Map every distinct router-name in ROUTE_PERMISSION_MAP to (mountPath, router).
const ROUTER_MOUNTS: Record<string, { mountPath: string; router: express.Router }> = {
  authRoutes:            { mountPath: '/auth',             router: authRoutes },
  healthRoutes:          { mountPath: '/health',           router: healthRoutes },
  pipelineRoutes:        { mountPath: '/pipeline',         router: pipelineRoutes },
  fulfillmentRoutes:     { mountPath: '/fulfillment',      router: fulfillmentRoutes },
  customersRoutes:       { mountPath: '/customers',        router: customersRoutes },
  settingsRoutes:        { mountPath: '/settings',         router: settingsRoutes },
  caretakerRoutes:       { mountPath: '/caretaker',        router: caretakerRoutes },
  whatsappRoutes:        { mountPath: '/whatsapp',         router: whatsappRoutes },
  knowledgeRoutes:       { mountPath: '/knowledge',        router: knowledgeRoutes },
  idempotencyRoutes:     { mountPath: '/idempotency',      router: idempotencyRoutes },
  dlqRoutes:             { mountPath: '/dlq',              router: dlqRoutes },
  usageRoutes:           { mountPath: '/usage',            router: usageRoutes },
  agentRunsRoutes:       { mountPath: '/agent-runs',       router: agentRunsRoutes },
  usersRoutes:           { mountPath: '/users',            router: usersRoutes },
  packerRoutes:          { mountPath: '/packer',           router: packerRoutes },
  chatbotSettingsRoutes: { mountPath: '/chatbot-settings', router: chatbotSettingsRoutes },
  marketingRoutes:       { mountPath: '/marketing',        router: marketingRoutes },
  manualRoutes:          { mountPath: '/manual',           router: manualRoutes },
};

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  for (const { mountPath, router } of Object.values(ROUTER_MOUNTS)) {
    app.use(mountPath, router);
  }
  return app;
}

function mintPackerToken(): string {
  return jwt.sign(
    {
      tenantId: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000002',
      email: 'packer@example.com',
      permissions: ROLE_PRESETS.packer,
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' },
  );
}

/**
 * Substitute URL params with safe placeholders. Anything that looks like a
 * UUID column gets a zero-UUID; named params like :queue / :purpose / :phone
 * / :key get a domain-shaped value the handler is more likely to accept
 * before short-circuiting (a packer never reaches the handler for these,
 * but we still want the app to dispatch the route).
 */
function substituteParams(path: string): string {
  return path
    .replace(/:queue\b/g, 'order-pipeline')
    .replace(/:purpose\b/g, 'order_collected')
    .replace(/:phone\b/g, '+27000000000')
    .replace(/:key\b/g, 'test-key')
    .replace(/:emailId\b/g, '00000000-0000-0000-0000-000000000000')
    .replace(/:msgId\b/g, '00000000-0000-0000-0000-000000000000')
    .replace(/:convId\b/g, '00000000-0000-0000-0000-000000000000')
    .replace(/:campaignId\b/g, '00000000-0000-0000-0000-000000000000')
    .replace(/:stepId\b/g, '00000000-0000-0000-0000-000000000000')
    // Generic :id (and any other unmatched param) last.
    .replace(/:[a-zA-Z][a-zA-Z0-9_]*/g, '00000000-0000-0000-0000-000000000000');
}

const app = buildApp();
const packerToken = mintPackerToken();

/**
 * Decide whether to skip an entry. Currently:
 *  - `auth-only` rows are out of scope for Property 2 (they have no
 *    permission policy to assert).
 *  - `POST /knowledge/sources/upload` is multer multipart; the suite
 *    sends application/json bodies, so multer would reject before
 *    `requirePermission` runs and we'd see 400 instead of the expected
 *    403 for a non-allowed user. Skip it; the 1.3.6 unit tests cover
 *    its declaration.
 */
function shouldSkip(e: RouteSpec): { skip: boolean; reason?: string } {
  if (e.permission === 'auth-only') {
    return { skip: true, reason: 'auth-only — covered by other suites' };
  }
  if (e.method === 'POST' && e.path === '/knowledge/sources/upload') {
    return {
      skip: true,
      reason: 'multer multipart endpoint — JSON body would be rejected before requirePermission',
    };
  }
  return { skip: false };
}

describe('packerVerification — Property 2 over ROUTE_PERMISSION_MAP (task 4.1)', () => {
  for (const entry of ROUTE_PERMISSION_MAP) {
    const { skip, reason } = shouldSkip(entry);
    const label = `${entry.method} ${entry.path}`;

    if (skip) {
      it.skip(`${label} (${reason})`, () => {});
      continue;
    }

    const required = normalizeRequired(entry.permission);
    const allowed = hasAnyPermission(ROLE_PRESETS.packer, required);
    const expectation = allowed ? 'must NOT 401/403' : 'must 403 FORBIDDEN with required';

    it(`${label} → ${expectation}`, async () => {
      const path = substituteParams(entry.path);
      const fixtureKey = `${entry.method} ${entry.path}`;
      const body = REQUEST_BODIES[fixtureKey] ?? {};

      let res: request.Response;
      try {
        // Build the supertest call per HTTP verb.
        let pending: request.Test;
        switch (entry.method) {
          case 'GET':    pending = request(app).get(path); break;
          case 'POST':   pending = request(app).post(path).send(body); break;
          case 'PUT':    pending = request(app).put(path).send(body); break;
          case 'DELETE': pending = request(app).delete(path).send(body); break;
          case 'PATCH':  pending = request(app).patch(path).send(body); break;
          default:
            throw new Error(`Unsupported method ${entry.method} for ${label}`);
        }
        pending = pending.set('Authorization', `Bearer ${packerToken}`);
        // Wrap to swallow handler-level connection errors (a 500 from a route
        // is acceptable for the "allowed" case — the auth gate let us in).
        // supertest still resolves with the response, so try/catch is only
        // for socket-level failures.
        res = await pending;
      } catch (err: any) {
        throw new Error(`[${label}] supertest failed: ${err?.message ?? err}`);
      }

      if (allowed) {
        // The auth gate must let the request through to the handler.
        // The handler is allowed to return any non-auth status code.
        expect(
          res.status,
          `[${label}] expected status not in {401,403} for an allowed packer call, got ${res.status} body=${JSON.stringify(res.body)}`,
        ).not.toBe(401);
        expect(
          res.status,
          `[${label}] expected status not in {401,403} for an allowed packer call, got ${res.status} body=${JSON.stringify(res.body)}`,
        ).not.toBe(403);
      } else {
        // The auth gate must reject with a 403 FORBIDDEN that names the
        // required permission(s) in the body.
        expect(
          res.status,
          `[${label}] expected 403 FORBIDDEN for a denied packer call, got ${res.status} body=${JSON.stringify(res.body)}`,
        ).toBe(403);
        expect(
          res.body?.error?.code,
          `[${label}] expected error.code FORBIDDEN, got ${JSON.stringify(res.body?.error)}`,
        ).toBe('FORBIDDEN');
        const got: unknown = res.body?.error?.required;
        expect(
          Array.isArray(got),
          `[${label}] expected error.required to be an array, got ${JSON.stringify(got)}`,
        ).toBe(true);
        // The route's required permissions must all appear in the response.
        for (const p of required) {
          expect(
            (got as unknown[]).includes(p),
            `[${label}] expected error.required to include "${p}", got ${JSON.stringify(got)}`,
          ).toBe(true);
        }
      }
    });
  }
});

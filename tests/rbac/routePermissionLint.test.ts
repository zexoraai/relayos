/**
 * Static-source CI lint over `src/api/*Routes.ts` and `public/permissions.js`.
 *
 * Walks every router file as text and asserts:
 *
 *   1. For every file in `src/api/*Routes.ts` whose basename is not in the
 *      public-webhook + onboarding allowlist, every `router.<method>(...)`
 *      call either:
 *        a. includes the literal token `requirePermission(` somewhere inside
 *           its argument list, OR
 *        b. the (method, path) pair appears in `ROUTE_PERMISSION_MAP` with
 *           `permission === 'auth-only'` and a non-empty `justification`.
 *
 *   2. Every non-allowlisted router file imports something from `./middleware`
 *      (covers Requirement 8.4 — a router that defines authenticated endpoints
 *      but never references the middleware module fails the build).
 *
 *   3. Every literal permission string referenced as the first argument to
 *      `requirePermission(...)` in any `src/api/*Routes.ts` AND every string
 *      value in `TAB_PERMISSIONS` in `public/permissions.js` is one of:
 *        - `'*'`
 *        - a `<module>.*` wildcard whose `<module>` prefixes at least one
 *          string in `listAllPermissions()` (so `orders.*`, `agents.runs.*`,
 *          `whatsapp.*` all pass; `nope.*` fails).
 *        - exactly equal to a value returned by `listAllPermissions()`.
 *
 * Failure messages name the offending router file, line, and string so a
 * human can fix it without grepping.
 *
 * Validates: Requirements 8.2, 8.3, 8.4, 8.5
 * Design:    §Components and Interfaces > 7. `tests/rbac/`; §Correctness Properties Property 6, 7
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { ROUTE_PERMISSION_MAP, type RouteSpec } from '../../src/api/routePermissionMap';
import { listAllPermissions } from '../../src/auth/permissions';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROUTERS_DIR = path.resolve(__dirname, '..', '..', 'src', 'api');
const PUBLIC_PERMISSIONS_JS = path.resolve(
  __dirname,
  '..',
  '..',
  'public',
  'permissions.js',
);

/**
 * Routers excluded from the permission audit per design §"Routers excluded
 * from the audit": auth (its own auth-only entries cover login/me/logout),
 * the two public webhook routers (Meta + Shopify call them with no JWT),
 * the static reference data router (no tenant data), the SPA fallback
 * router, and the onboarding router (its own auth pattern is intentionally
 * separate while a tenant is still mid-onboarding).
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  'authRoutes.ts',
  'whatsappWebhookRoutes.ts',
  'shopifyWebhookRoutes.ts',
  'referenceRoutes.ts',
  'frontendRoutes.ts',
  'onboardingRoutes.ts',
]);

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

// ---------------------------------------------------------------------------
// Source-walking helpers
// ---------------------------------------------------------------------------

/**
 * Given a `text` and the index of an opening `(`, return the index of the
 * matching close `)`, or -1 if the file is unbalanced. Skips parens inside
 * string literals, template literals, line comments, and block comments.
 *
 * Used by both the `router.<method>(...)` extractor and the
 * `requirePermission(...)` extractor so a regex-only approach (which would
 * stop at the first `)` inside a nested call) is avoided.
 */
function findMatchingParen(text: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  let inStr: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch as '"' | "'" | '`';
      i += 1;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

function lineOf(text: string, idx: number): number {
  // Lines are 1-indexed (matches what an editor and the test failure output expect).
  return text.slice(0, idx).split('\n').length;
}

type RouterCall = {
  method: HttpMethod;
  pathLiteral: string; // first-arg string literal
  args: string; // raw text between the outermost parens (excluding the parens themselves)
  line: number; // 1-indexed line number of the `router.<method>(` start
};

/**
 * Find every `router.<method>(...)` call in a file's text using regex for the
 * call-site start and paren-balanced extraction for the argument list. The
 * first argument MUST be a string literal (this is how Express routes are
 * declared throughout the codebase); calls that don't match this shape are
 * skipped.
 */
function findRouterCalls(text: string): RouterCall[] {
  const calls: RouterCall[] = [];
  const startRe = /\brouter\.(get|post|put|delete|patch)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = startRe.exec(text)) !== null) {
    const method = match[1].toUpperCase() as HttpMethod;
    const openParenIdx = match.index + match[0].length - 1; // index of '('
    const closeParenIdx = findMatchingParen(text, openParenIdx);
    if (closeParenIdx === -1) continue;
    const args = text.slice(openParenIdx + 1, closeParenIdx);
    // First argument must be a string literal (path).
    const pathMatch = args.match(/^\s*(['"`])([^'"`\n]+)\1/);
    if (!pathMatch) continue;
    calls.push({
      method,
      pathLiteral: pathMatch[2],
      args,
      line: lineOf(text, match.index),
    });
  }
  return calls;
}

type RequirePermissionCall = {
  permission: string;
  line: number;
};

/**
 * Find every literal string passed to `requirePermission(...)` anywhere in
 * the file. Supports varargs: `requirePermission('a', 'b')` yields two
 * entries. Skips non-string-literal arguments (e.g. spread, computed values)
 * — those would be a separate code-smell to flag, but the catalog sweep here
 * specifically enforces *literal* strings against `listAllPermissions()`.
 */
function findRequirePermissionCalls(text: string): RequirePermissionCall[] {
  const calls: RequirePermissionCall[] = [];
  const re = /\brequirePermission\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = findMatchingParen(text, openIdx);
    if (closeIdx === -1) continue;
    const args = text.slice(openIdx + 1, closeIdx);

    // Extract every string literal in args. requirePermission's signature is
    // `(...required: string[])`, so every literal string here is a permission
    // expression worth catalog-checking.
    const strRe = /(['"`])([^'"`]+)\1/g;
    let s: RegExpExecArray | null;
    while ((s = strRe.exec(args)) !== null) {
      const absoluteIdx = openIdx + 1 + s.index;
      calls.push({
        permission: s[2],
        line: lineOf(text, absoluteIdx),
      });
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// ROUTE_PERMISSION_MAP indexing
// ---------------------------------------------------------------------------

/**
 * Look up whether a (router, method, internal-path) tuple has a matching
 * `auth-only` entry in ROUTE_PERMISSION_MAP. The map stores the externally
 * mounted path (e.g. `/auth/me`); the router file declares the
 * router-internal path (e.g. `/me`). Match by router basename + method +
 * suffix-equality so we don't need to know each router's mount prefix.
 *
 * Returns `{ ok: true }` only if (a) a matching entry exists, (b) its
 * permission is the literal string `'auth-only'`, and (c) the entry has a
 * non-empty `justification` string. Both clauses (b) and (c) must hold per
 * Requirement 2.2 / 8.2.
 */
function findAuthOnlyMatch(
  routerBase: string,
  method: HttpMethod,
  internalPath: string,
): { ok: boolean; entry?: RouteSpec } {
  for (const entry of ROUTE_PERMISSION_MAP) {
    if (entry.router !== routerBase) continue;
    if (entry.method !== method) continue;
    if (entry.permission !== 'auth-only') continue;
    // External-vs-internal path reconciliation: the entry's path is the full
    // mounted path (e.g. /auth/me) while internalPath is /me. Accept when
    // the entry's path ends with internalPath, optionally preceded by `/`.
    const equalOrSuffix =
      entry.path === internalPath ||
      entry.path.endsWith(internalPath) ||
      entry.path.endsWith(`/${internalPath.replace(/^\/+/, '')}`);
    if (!equalOrSuffix) continue;
    const okJustification =
      typeof entry.justification === 'string' && entry.justification.trim().length > 0;
    return { ok: okJustification, entry };
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Permission catalog validity
// ---------------------------------------------------------------------------

const ALL_PERMISSION_STRINGS: readonly string[] = listAllPermissions();
const ALL_PERMISSIONS_SET: ReadonlySet<string> = new Set(ALL_PERMISSION_STRINGS);

/**
 * A permission string is catalog-valid iff:
 *   - it is the universal wildcard `'*'`, or
 *   - it ends in `.*` and the prefix names a defined module (i.e. at least
 *     one catalog string equals the prefix or starts with `<prefix>.`), or
 *   - it is exactly equal to a value in `listAllPermissions()`.
 *
 * Requirement 8.3 / Property 6.
 */
function isCatalogValidPermission(s: string): boolean {
  if (s === '*') return true;
  if (s.endsWith('.*')) {
    const prefix = s.slice(0, -2);
    if (prefix.length === 0) return false;
    return ALL_PERMISSION_STRINGS.some(
      (p) => p === prefix || p.startsWith(`${prefix}.`),
    );
  }
  return ALL_PERMISSIONS_SET.has(s);
}

// ---------------------------------------------------------------------------
// public/permissions.js TAB_PERMISSIONS extraction
// ---------------------------------------------------------------------------

type TabPermissionValue = null | string | string[];

/**
 * Evaluate `public/permissions.js` inside a sandboxed VM context that exposes
 * a stub `window` object. The file's IIFE attaches `RelayPermissions` to the
 * window; we read `TAB_PERMISSIONS` off that. This avoids hand-rolling a
 * regex parser over the JS object literal (which would miss array-valued
 * entries, line wraps, etc.).
 */
function loadTabPermissions(): Record<string, TabPermissionValue> {
  const code = fs.readFileSync(PUBLIC_PERMISSIONS_JS, 'utf8');
  const ctx: any = { window: {}, document: { querySelectorAll: () => [] } };
  runInNewContext(code, ctx, { filename: 'permissions.js' });
  const exposed = ctx.window?.RelayPermissions;
  if (!exposed || typeof exposed !== 'object') {
    throw new Error(
      'public/permissions.js did not attach window.RelayPermissions when evaluated',
    );
  }
  const tabs = exposed.TAB_PERMISSIONS;
  if (!tabs || typeof tabs !== 'object') {
    throw new Error(
      'public/permissions.js did not expose TAB_PERMISSIONS on window.RelayPermissions',
    );
  }
  return tabs as Record<string, TabPermissionValue>;
}

// ---------------------------------------------------------------------------
// Test fixture: enumerate router files once for all describe blocks below
// ---------------------------------------------------------------------------

const ROUTE_FILES: { basename: string; absPath: string; relPath: string; text: string }[] =
  fs
    .readdirSync(ROUTERS_DIR)
    .filter((f) => /Routes\.ts$/.test(f))
    .sort()
    .map((f) => {
      const absPath = path.join(ROUTERS_DIR, f);
      return {
        basename: f,
        absPath,
        relPath: path.posix.join('src', 'api', f),
        text: fs.readFileSync(absPath, 'utf8'),
      };
    });

const NON_ALLOWLISTED_FILES = ROUTE_FILES.filter((rf) => !ALLOWLIST.has(rf.basename));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routePermissionLint — every authenticated endpoint enforces a permission (Requirements 8.2, 8.4)', () => {
  it('enumerates at least one non-allowlisted router file', () => {
    // Sanity check: catch the case where the directory layout changes and we
    // accidentally skip every file (which would make the lint trivially pass).
    expect(NON_ALLOWLISTED_FILES.length).toBeGreaterThan(0);
  });

  // One sub-test per file so failures point at the exact file in CI output.
  for (const rf of NON_ALLOWLISTED_FILES) {
    describe(rf.relPath, () => {
      it('imports something from "./middleware" (Requirement 8.4)', () => {
        const importsMiddleware =
          /\bfrom\s+['"]\.\/middleware['"]/.test(rf.text) ||
          /\brequire\s*\(\s*['"]\.\/middleware['"]\s*\)/.test(rf.text);
        if (!importsMiddleware) {
          throw new Error(
            `${rf.relPath} defines authenticated endpoints but never imports from './middleware'. ` +
              `Add an import like: import { authMiddleware, requirePermission } from './middleware';`,
          );
        }
      });

      it('every router.<method>(...) call has requirePermission(... or is auth-only in the map (Requirement 8.2)', () => {
        const calls = findRouterCalls(rf.text);
        const failures: string[] = [];

        for (const call of calls) {
          // Pass 1: argument list contains a literal `requirePermission(` token.
          if (call.args.includes('requirePermission(')) continue;

          // Pass 2: (router, method, path) is auth-only in the map.
          const routerBase = rf.basename.replace(/\.ts$/, '');
          const authOnly = findAuthOnlyMatch(routerBase, call.method, call.pathLiteral);
          if (authOnly.ok) continue;

          if (authOnly.entry && !authOnly.ok) {
            failures.push(
              `${rf.relPath}:${call.line} — router.${call.method.toLowerCase()}('${call.pathLiteral}', ...) ` +
                `is mapped as 'auth-only' in ROUTE_PERMISSION_MAP but its 'justification' field is empty. ` +
                `Add a non-empty justification or wrap the route in requirePermission(...).`,
            );
            continue;
          }

          failures.push(
            `${rf.relPath}:${call.line} — router.${call.method.toLowerCase()}('${call.pathLiteral}', ...) ` +
              `has no requirePermission(...) on its handler chain and no matching auth-only entry in ` +
              `ROUTE_PERMISSION_MAP. Either add requirePermission('<perm>') from PERMISSIONS, or add a row ` +
              `to ROUTE_PERMISSION_MAP with permission: 'auth-only' and a non-empty justification.`,
          );
        }

        if (failures.length > 0) {
          throw new Error(
            `Found ${failures.length} unguarded route(s):\n  - ${failures.join('\n  - ')}`,
          );
        }
      });
    });
  }
});

describe('routePermissionLint — every requirePermission literal is catalog-valid (Requirements 8.3)', () => {
  it('every literal permission string in src/api/*Routes.ts is in listAllPermissions(), is "*", or is a valid <module>.* wildcard', () => {
    const failures: string[] = [];

    for (const rf of ROUTE_FILES) {
      const calls = findRequirePermissionCalls(rf.text);
      for (const c of calls) {
        if (!isCatalogValidPermission(c.permission)) {
          failures.push(
            `${rf.relPath}:${c.line} — requirePermission('${c.permission}') references a string that is ` +
              `neither '*', a defined <module>.* wildcard, nor a value in listAllPermissions(). ` +
              `Use a constant from PERMISSIONS in src/auth/permissions.ts.`,
          );
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Found ${failures.length} catalog-invalid permission string(s):\n  - ${failures.join('\n  - ')}`,
      );
    }
  });

  it('every string value in TAB_PERMISSIONS in public/permissions.js is catalog-valid (Requirement 8.5)', () => {
    const tabPerms = loadTabPermissions();
    const failures: string[] = [];

    for (const [tab, value] of Object.entries(tabPerms)) {
      if (value === null) continue; // documented "any authenticated user" sentinel
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (typeof v !== 'string') {
          failures.push(
            `public/permissions.js TAB_PERMISSIONS['${tab}'] — value '${String(v)}' is not a string, ` +
              `null, or array of strings. Allowed shapes: null | string | string[].`,
          );
          continue;
        }
        if (!isCatalogValidPermission(v)) {
          failures.push(
            `public/permissions.js TAB_PERMISSIONS['${tab}'] — '${v}' is neither '*', a defined ` +
              `<module>.* wildcard, nor a value in listAllPermissions(). Fix it to use a value from ` +
              `PERMISSIONS in src/auth/permissions.ts.`,
          );
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Found ${failures.length} catalog-invalid TAB_PERMISSIONS value(s):\n  - ${failures.join('\n  - ')}`,
      );
    }
  });
});

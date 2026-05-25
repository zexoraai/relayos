import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { ROLE_PRESETS } from './permissions';

const log = createChildLogger({ module: 'auth' });

const SALT_ROUNDS = 12;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
}

function getJwtExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN || '24h';
}

export interface TenantPayload {
  tenantId: string;
  email: string;
  userId?: string;            // NEW: which user within the tenant
  permissions?: string[];     // NEW: snapshot of permissions at login time
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(payload: TenantPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: getJwtExpiresIn() } as jwt.SignOptions);
}

export function verifyToken(token: string): TenantPayload {
  return jwt.verify(token, getJwtSecret()) as TenantPayload;
}

export async function registerTenant(email: string, password: string): Promise<{ id: string; email: string; status: string }> {
  const db = getDb();

  // Check for existing tenant
  const existing = await db('tenants').where({ email: email.toLowerCase().trim() }).first();
  if (existing) {
    throw new AuthError('DUPLICATE_EMAIL', 'A tenant with this email already exists');
  }

  const passwordHash = await hashPassword(password);

  const [tenant] = await db('tenants')
    .insert({
      email: email.toLowerCase().trim(),
      password_hash: passwordHash,
      status: 'pending_onboarding',
      onboarding_step: 'account_created',
    })
    .returning(['id', 'email', 'status']);

  log.info({ tenantId: tenant.id }, 'Tenant registered');

  // Record onboarding event
  await db('tenant_onboarding_events').insert({
    tenant_id: tenant.id,
    event_type: 'account_created',
    event_payload: JSON.stringify({ email: tenant.email }),
  });

  return tenant;
}

export async function loginTenant(email: string, password: string): Promise<{ token: string; tenant: any }> {
  const db = getDb();
  const normalizedEmail = email.toLowerCase().trim();

  // Try tenant_users first (multi-user RBAC path)
  const userRow = await db('tenant_users')
    .where({ email: normalizedEmail, status: 'active' })
    .first();

  if (userRow) {
    const valid = await verifyPassword(password, userRow.password_hash);
    if (!valid) throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password');

    // Load permissions
    const permRows = await db('user_permissions').where({ user_id: userRow.id }).select('permission');
    const permissions = permRows.map((r: any) => r.permission);

    const tenant = await db('tenants').where({ id: userRow.tenant_id }).first();
    if (!tenant) throw new AuthError('TENANT_NOT_FOUND', 'Tenant record missing');

    // Update last_login_at
    await db('tenant_users').where({ id: userRow.id }).update({ last_login_at: new Date(), updated_at: new Date() });

    const token = generateToken({
      tenantId: tenant.id,
      email: userRow.email,
      userId: userRow.id,
      permissions,
    });

    log.info({ tenantId: tenant.id, userId: userRow.id }, 'User logged in');

    return {
      token,
      tenant: {
        id: tenant.id,
        email: userRow.email,
        status: tenant.status,
        onboarding_step: tenant.onboarding_step,
        user: { id: userRow.id, display_name: userRow.display_name, permissions },
      },
    };
  }

  // Legacy fallback: existing tenant.email login
  const tenant = await db('tenants').where({ email: normalizedEmail }).first();
  if (!tenant) {
    throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const valid = await verifyPassword(password, tenant.password_hash);
  if (!valid) {
    throw new AuthError('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  // Bounded backfill for legacy tenants. The old code path inserted permission
  // '*' for any tenant that hit the fallback, silently making every legacy
  // tenant a super admin. The new policy:
  //
  //   1. Zero `tenant_users` rows AND `tenants.email` matches the login email
  //      → mint exactly one `tenant_users` row with permissions equal to
  //        `ROLE_PRESETS.super_admin` (still ['*']). This preserves the
  //        original tenant owner's super-admin access.
  //
  //   2. One or more `tenant_users` rows exist but none of them has an
  //      email equal to `tenants.email`
  //      → do NOT auto-promote. Insert a `tenant_onboarding_events` row of
  //        type `rbac_review_required` describing the candidate users and
  //        reject the login with `RBAC_REVIEW_REQUIRED` so an operator can
  //        resolve who keeps super admin via the existing
  //        `PUT /users/:id/permissions` flow.
  //
  // The "tenant_users row whose email matches tenants.email" path is handled
  // by the multi-user code path above (we wouldn't reach this fallback in
  // that case), so this branch only fires for legacy / ambiguous tenants.
  const existingUsers = await db('tenant_users')
    .where({ tenant_id: tenant.id })
    .select('id', 'email');

  let userId: string;
  let permissions: string[];

  if (existingUsers.length === 0 && tenant.email === normalizedEmail) {
    // Bounded backfill: original tenant owner, no users yet.
    const superAdminPerms = ROLE_PRESETS.super_admin;
    const [createdUser] = await db('tenant_users').insert({
      tenant_id: tenant.id,
      email: tenant.email,
      password_hash: tenant.password_hash,
      display_name: tenant.email,
      status: 'active',
    }).returning('id');
    userId = createdUser.id;
    await db('user_permissions').insert(
      superAdminPerms.map((permission) => ({ user_id: userId, permission })),
    );
    permissions = [...superAdminPerms];
  } else {
    // Ambiguous: legacy tenants row authenticates but the existing
    // `tenant_users` rows do not include one whose email matches
    // `tenants.email`. Refuse to pick a super admin automatically; emit a
    // review event so operators can resolve, and reject the login.
    await db('tenant_onboarding_events').insert({
      tenant_id: tenant.id,
      event_type: 'rbac_review_required',
      event_payload: JSON.stringify({
        tenant_id: tenant.id,
        candidate_user_ids: existingUsers.map((u: any) => u.id),
        tenant_email: tenant.email,
        reason: 'ambiguous_legacy_super_admin',
      }),
    });

    log.warn(
      { tenantId: tenant.id, candidateUserIds: existingUsers.map((u: any) => u.id) },
      'Ambiguous legacy super-admin on login; rbac_review_required event emitted',
    );

    throw new AuthError(
      'RBAC_REVIEW_REQUIRED',
      'This tenant requires an RBAC review before login can proceed. An operator must resolve who holds super-admin access.',
    );
  }

  const token = generateToken({
    tenantId: tenant.id,
    email: tenant.email,
    userId,
    permissions,
  });

  log.info({ tenantId: tenant.id, userId }, 'Legacy tenant logged in (backfilled)');

  return {
    token,
    tenant: {
      id: tenant.id,
      email: tenant.email,
      status: tenant.status,
      onboarding_step: tenant.onboarding_step,
      user: { id: userId, display_name: tenant.email, permissions },
    },
  };
}

export async function getTenantById(tenantId: string) {
  const db = getDb();
  const tenant = await db('tenants').where({ id: tenantId }).first();
  if (!tenant) return null;
  return {
    id: tenant.id,
    email: tenant.email,
    status: tenant.status,
    onboarding_step: tenant.onboarding_step,
    onboarding_completed_at: tenant.onboarding_completed_at,
    created_at: tenant.created_at,
  };
}

export class AuthError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

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

  // Backfill: create a tenant_users row + super admin permission for legacy tenants
  let userId: string;
  let permissions: string[];
  try {
    const [createdUser] = await db('tenant_users').insert({
      tenant_id: tenant.id,
      email: tenant.email,
      password_hash: tenant.password_hash,
      display_name: tenant.email,
      status: 'active',
    }).returning('id');
    userId = createdUser.id;
    await db('user_permissions').insert({ user_id: userId, permission: '*' });
    permissions = ['*'];
  } catch {
    // Already backfilled (race or migration), look it up
    const u = await db('tenant_users').where({ tenant_id: tenant.id, email: tenant.email }).first();
    userId = u?.id;
    const permRows = userId ? await db('user_permissions').where({ user_id: userId }).select('permission') : [];
    permissions = permRows.map((r: any) => r.permission);
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

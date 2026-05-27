import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'packer-auth' });

/**
 * Packer auth lives in a separate module from tenant auth so the two
 * identity systems never collide. JWT tokens carry a distinct shape
 * (no tenantId, has packerId) and a different audience claim, and the
 * packerAuthMiddleware in src/api/middleware.ts checks for that shape
 * before treating a request as a packer request.
 *
 * We re-use JWT_SECRET so we don't add another env-var, but the
 * audience/issuer fields make a tenant token unusable on a packer
 * route and vice versa.
 */
const SALT_ROUNDS = 12;
const JWT_AUDIENCE = 'relayos-packer';
const JWT_ISSUER = 'relayos';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is required');
  return secret;
}

function getJwtExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN || '24h';
}

export interface PackerPayload {
  packerId: string;
  email: string;
}

export async function hashPackerPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPackerPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generatePackerToken(payload: PackerPayload): string {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: getJwtExpiresIn(),
    audience: JWT_AUDIENCE,
    issuer: JWT_ISSUER,
  } as jwt.SignOptions);
}

export function verifyPackerToken(token: string): PackerPayload {
  return jwt.verify(token, getJwtSecret(), {
    audience: JWT_AUDIENCE,
    issuer: JWT_ISSUER,
  }) as PackerPayload;
}

export class PackerAuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'PackerAuthError';
  }
}

/**
 * Sign up a new packer with email + password. Email is lower-cased and
 * trimmed before storage. Returns the new packer row (without password).
 *
 * Throws PackerAuthError('EMAIL_TAKEN') if the email is already in use.
 */
export async function registerPacker(args: {
  email: string;
  password: string;
  full_name?: string;
  business_name?: string;
  phone?: string;
}): Promise<{ id: string; email: string; status: string }> {
  const db = getDb();
  const email = args.email.toLowerCase().trim();

  if (!email || !email.includes('@')) {
    throw new PackerAuthError('INVALID_EMAIL', 'A valid email is required');
  }
  if (!args.password || args.password.length < 8) {
    throw new PackerAuthError('WEAK_PASSWORD', 'Password must be at least 8 characters');
  }

  const existing = await db('packers').where({ email }).first();
  if (existing) {
    throw new PackerAuthError('EMAIL_TAKEN', 'A packer account with that email already exists');
  }

  const passwordHash = await hashPackerPassword(args.password);

  const [row] = await db('packers')
    .insert({
      email,
      encrypted_password: passwordHash,
      full_name: args.full_name?.trim() || null,
      business_name: args.business_name?.trim() || null,
      phone: args.phone?.trim() || null,
      status: 'active',
    })
    .returning(['id', 'email', 'status']);

  log.info({ packerId: row.id }, 'Packer registered');
  return row;
}

/**
 * Verify packer email + password. Returns the packer row on success,
 * throws PackerAuthError('INVALID_CREDENTIALS') otherwise. The error
 * code is identical for "no such email" and "wrong password" so we
 * don't leak account existence.
 */
export async function loginPacker(email: string, password: string): Promise<{ id: string; email: string; status: string }> {
  const db = getDb();
  const normalized = email.toLowerCase().trim();

  const row = await db('packers').where({ email: normalized }).first();
  if (!row) {
    throw new PackerAuthError('INVALID_CREDENTIALS', 'Invalid email or password');
  }
  if (row.status === 'disabled') {
    throw new PackerAuthError('ACCOUNT_DISABLED', 'This packer account has been disabled');
  }

  const valid = await verifyPackerPassword(password, row.encrypted_password);
  if (!valid) {
    throw new PackerAuthError('INVALID_CREDENTIALS', 'Invalid email or password');
  }

  await db('packers').where({ id: row.id }).update({ last_login_at: new Date() });

  return { id: row.id, email: row.email, status: row.status };
}

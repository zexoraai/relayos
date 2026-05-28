import { Router, Request, Response } from 'express';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import {
  registerPacker,
  loginPacker,
  generatePackerToken,
  PackerAuthError,
} from '../packerAuth';
import { packerAuthMiddleware, PackerAuthenticatedRequest } from './middleware';

const log = createChildLogger({ module: 'packer-auth-api' });
const router = Router();

/**
 * Packer-side authentication endpoints. Mounted at /packer-auth so the
 * tenant-side /auth/* surface stays untouched.
 *
 *   POST /packer-auth/signup     - create a packer account; optionally accept an invite token
 *   POST /packer-auth/login      - return a JWT for an existing packer
 *   POST /packer-auth/accept     - accept an invite while already logged in (links existing packer to tenant)
 *   GET  /packer-auth/me         - identity + linked tenants (requires packer JWT)
 *   POST /packer-auth/logout     - client-side discard; this is a no-op for the server but keeps the API symmetric
 *
 * No tenant JWTs accepted here; no packers.* permission gating —
 * the audience claim on the packer JWT is the gate for the
 * authenticated routes.
 */

const INVITE_LIFETIME_HOURS = 14 * 24;

/**
 * Resolve a packer_invites row by raw token. Returns null if the
 * token is unknown, expired, or in a non-pending status. Locks the
 * row using FOR UPDATE so concurrent accepts can't double-link.
 */
async function loadPendingInvite(trx: any, token: string): Promise<any | null> {
  const row = await trx('packer_invites')
    .where({ token, status: 'pending' })
    .forUpdate()
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await trx('packer_invites').where({ id: row.id }).update({ status: 'expired', updated_at: new Date() });
    return null;
  }
  return row;
}

/**
 * Convert a pending invite into an active link in a single transaction.
 * Idempotent — if a link already exists for this (tenant, packer)
 * pair, we resurrect it (status->active, paused_at/unlinked_at
 * cleared) instead of inserting a duplicate.
 */
async function acceptInviteInTransaction(args: {
  trx: any;
  invite: any;
  packerId: string;
}): Promise<{ link_id: string }> {
  const { trx, invite, packerId } = args;
  const existing = await trx('packer_tenant_links')
    .where({ tenant_id: invite.tenant_id, packer_id: packerId })
    .first();
  let linkId: string;
  if (existing) {
    await trx('packer_tenant_links').where({ id: existing.id }).update({
      status: 'active',
      load_weight: invite.load_weight,
      note: invite.note,
      linked_via_invite_id: invite.id,
      linked_at: new Date(),
      paused_at: null,
      unlinked_at: null,
      unlink_reason: null,
      updated_at: new Date(),
    });
    linkId = existing.id;
  } else {
    const [row] = await trx('packer_tenant_links').insert({
      tenant_id: invite.tenant_id,
      packer_id: packerId,
      status: 'active',
      load_weight: invite.load_weight,
      note: invite.note,
      linked_via_invite_id: invite.id,
      linked_at: new Date(),
    }).returning(['id']);
    linkId = row.id;
  }
  await trx('packer_invites').where({ id: invite.id }).update({
    status: 'accepted',
    accepted_at: new Date(),
    packer_id: packerId,
    updated_at: new Date(),
  });
  return { link_id: linkId };
}

// ---------------------------------------------------------------------------
// POST /packer-auth/signup
// ---------------------------------------------------------------------------

/**
 * Body: {
 *   email, password,
 *   full_name?, business_name?, phone?,
 *   invite_token?
 * }
 *
 * Creates a new packer account. If `invite_token` is provided AND
 * matches an active invite, the new packer is linked to the inviting
 * tenant in the same transaction. The response always carries a
 * fresh JWT so the client can transition straight to the dashboard.
 */
router.post('/signup', async (req: Request, res: Response) => {
  const db = getDb();
  const { email, password, full_name, business_name, phone, invite_token } = req.body || {};

  // Optional invite resolution happens BEFORE registerPacker so we
  // can return a useful 400 if the token is bad without leaving an
  // orphan account behind.
  let pendingInvite: any | null = null;
  if (invite_token) {
    pendingInvite = await db('packer_invites')
      .where({ token: invite_token, status: 'pending' })
      .first();
    if (!pendingInvite) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_INVITE', message: 'Invite token is unknown, already used, or expired' },
      });
    }
    if (new Date(pendingInvite.expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        error: { code: 'EXPIRED_INVITE', message: 'Invite has expired — ask the tenant to send a new one' },
      });
    }
  }

  let packer;
  try {
    packer = await registerPacker({ email, password, full_name, business_name, phone });
  } catch (err: any) {
    if (err instanceof PackerAuthError) {
      const status = err.code === 'EMAIL_TAKEN' ? 409 : 400;
      return res.status(status).json({ success: false, error: { code: err.code, message: err.message } });
    }
    throw err;
  }

  // If the signup carried a valid invite, accept it now in a
  // transaction so the new packer is immediately linked.
  let linkInfo: { link_id: string; tenant_id: string } | null = null;
  if (pendingInvite) {
    await db.transaction(async (trx) => {
      const fresh = await loadPendingInvite(trx, invite_token);
      if (!fresh) return; // racing accept; signup still succeeded
      const r = await acceptInviteInTransaction({ trx, invite: fresh, packerId: packer.id });
      linkInfo = { link_id: r.link_id, tenant_id: fresh.tenant_id };
    });
  }

  const token = generatePackerToken({ packerId: packer.id, email: packer.email });
  log.info({ packerId: packer.id, linkedTenant: (linkInfo as any)?.tenant_id }, 'Packer signup');
  return res.status(201).json({
    success: true,
    data: {
      packer: { id: packer.id, email: packer.email, status: packer.status },
      token,
      linked_tenant_id: (linkInfo as any)?.tenant_id || null,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /packer-auth/login
// ---------------------------------------------------------------------------

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'email and password required' } });
  }
  try {
    const packer = await loginPacker(email, password);
    const token = generatePackerToken({ packerId: packer.id, email: packer.email });
    return res.status(200).json({
      success: true,
      data: { packer, token },
    });
  } catch (err: any) {
    if (err instanceof PackerAuthError) {
      const status = err.code === 'ACCOUNT_DISABLED' ? 403 : 401;
      return res.status(status).json({ success: false, error: { code: err.code, message: err.message } });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /packer-auth/accept
// ---------------------------------------------------------------------------

/**
 * Accept an invite while already authenticated as a packer. Used when
 * the packer already has an account and the tenant sends a new
 * invite to the same email — they click the link, get bounced to
 * /packer-login, log in, and the dashboard immediately POSTs here
 * with the saved invite_token so the link goes active.
 */
router.post('/accept', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const { invite_token } = req.body || {};
  if (!invite_token) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'invite_token required' } });
  }

  let result: { link_id: string; tenant_id: string } | null = null;
  await db.transaction(async (trx) => {
    const invite = await loadPendingInvite(trx, invite_token);
    if (!invite) return;
    const r = await acceptInviteInTransaction({ trx, invite, packerId });
    result = { link_id: r.link_id, tenant_id: invite.tenant_id };
  });

  if (!result) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INVITE', message: 'Invite token is unknown, already used, or expired' } });
  }

  log.info({ packerId, linkedTenant: (result as any).tenant_id }, 'Packer accepted invite via authenticated flow');
  return res.status(200).json({ success: true, data: result });
});

// ---------------------------------------------------------------------------
// GET /packer-auth/me
// ---------------------------------------------------------------------------

router.get('/me', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;

  const packer = await db('packers').where({ id: packerId }).first(
    'id', 'email', 'full_name', 'business_name', 'phone',
    'collection_terminal_id', 'collection_locker_name', 'collection_door_address',
    'collection_contact_name', 'collection_contact_phone', 'collection_contact_email',
    'status', 'created_at', 'last_login_at',
  );
  if (!packer) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Packer not found' } });
  }

  // Linked tenants (active + paused — not kicked/left). The packer
  // only ever sees the tenant's name/email; not its full settings.
  const links = await db('packer_tenant_links as l')
    .join('tenants as t', 't.id', 'l.tenant_id')
    .whereNotIn('l.status', ['kicked', 'left'])
    .where('l.packer_id', packerId)
    .orderBy('l.linked_at', 'desc')
    .select(
      'l.id', 'l.status', 'l.load_weight', 'l.note',
      'l.linked_at', 'l.last_assigned_at', 'l.orders_assigned_count',
      't.id as tenant_id', 't.email as tenant_email',
    );

  // Pending invites addressed to this packer's email. The packer
  // accepts these via POST /packer-auth/accept which runs the same
  // token-resolution path as the signup flow.
  const pendingInvites = await db('packer_invites as i')
    .join('tenants as t', 't.id', 'i.tenant_id')
    .where('i.email', packer.email)
    .where('i.status', 'pending')
    .where('i.expires_at', '>', new Date())
    .orderBy('i.created_at', 'desc')
    .select(
      'i.id', 'i.token', 'i.load_weight', 'i.note',
      'i.expires_at', 'i.created_at',
      't.id as tenant_id', 't.email as tenant_email',
    );

  return res.status(200).json({ success: true, data: { packer, links, pending_invites: pendingInvites } });
});

// ---------------------------------------------------------------------------
// POST /packer-auth/logout
// ---------------------------------------------------------------------------

/**
 * Stateless JWT logout — the client discards the token. This route
 * exists for symmetry with /auth/logout and lets us add session-id
 * revocation later without changing the client API.
 */
router.post('/logout', (_req: Request, res: Response) => {
  return res.status(200).json({ success: true, data: { message: 'logged out' } });
});

export default router;

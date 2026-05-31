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
    'collection_point_type',
    'collection_terminal_id', 'collection_locker_name', 'collection_door_address',
    'collection_contact_name', 'collection_contact_phone', 'collection_contact_email',
    'weekly_digest_enabled',
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
// PUT /packer-auth/profile
// ---------------------------------------------------------------------------

/**
 * Let an authenticated packer edit their own profile. Body fields:
 *   { full_name?, business_name?, phone?,
 *     collection_terminal_id?, collection_locker_name?,
 *     collection_door_address?, collection_contact_name?,
 *     collection_contact_phone?, collection_contact_email? }
 *
 * Field-level allowlist — anything not in this set is silently
 * dropped. We deliberately don't expose `email`, `status`, or any
 * `*_at` timestamps; those are admin-only.
 */
const ALLOWED_PROFILE_FIELDS = [
  'full_name', 'business_name', 'phone',
  'collection_point_type',
  'collection_terminal_id', 'collection_locker_name',
  'collection_door_address',
  'collection_contact_name', 'collection_contact_phone', 'collection_contact_email',
  'weekly_digest_enabled',
];

const VALID_COLLECTION_TYPES = ['locker', 'door', 'both'];

router.put('/profile', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const update: Record<string, any> = { updated_at: new Date() };
  for (const k of ALLOWED_PROFILE_FIELDS) {
    if (req.body && k in req.body) {
      update[k] = req.body[k] === '' ? null : req.body[k];
    }
  }

  // Validate collection_point_type — required to be one of the
  // enumerated strings if provided. Reject anything else loud and
  // early so the UI can surface the error instead of silently
  // writing garbage that the assigner would later filter out.
  if (update.collection_point_type !== undefined && update.collection_point_type !== null) {
    if (!VALID_COLLECTION_TYPES.includes(update.collection_point_type)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_TYPE', message: `collection_point_type must be one of: ${VALID_COLLECTION_TYPES.join(', ')}` },
      });
    }

    // When the packer narrows their type, clear the unused fields so
    // the assigner doesn't pick a stale terminal_id for a door-only
    // packer or vice versa.
    if (update.collection_point_type === 'locker') {
      update.collection_door_address = null;
    }
    if (update.collection_point_type === 'door') {
      update.collection_terminal_id = null;
      update.collection_locker_name = null;
    }
  }

  // Coerce weekly_digest_enabled to a boolean. The PUT body might
  // arrive as 'true' / 'false' from older clients, or as a literal
  // boolean from the new dashboard.
  if ('weekly_digest_enabled' in update) {
    update.weekly_digest_enabled = update.weekly_digest_enabled === true
      || update.weekly_digest_enabled === 'true';
  }

  // Light validation: the door address must be either null/undefined or
  // an object. Reject arrays / strings to prevent accidental shape drift.
  if (update.collection_door_address !== undefined && update.collection_door_address !== null) {
    const v = update.collection_door_address;
    if (typeof v !== 'object' || Array.isArray(v)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_ADDRESS', message: 'collection_door_address must be an object or null' },
      });
    }
  }

  const updated = await db('packers')
    .where({ id: packerId })
    .update(update)
    .returning([
      'id', 'email', 'full_name', 'business_name', 'phone',
      'collection_point_type',
      'collection_terminal_id', 'collection_locker_name', 'collection_door_address',
      'collection_contact_name', 'collection_contact_phone', 'collection_contact_email',
      'weekly_digest_enabled',
      'status',
    ]);

  if (!updated || updated.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Packer not found' } });
  }
  log.info({ packerId, fields: Object.keys(update).filter((k) => k !== 'updated_at') }, 'Packer profile updated');
  return res.status(200).json({ success: true, data: { packer: updated[0] } });
});

// ---------------------------------------------------------------------------
// GET /packer-auth/orders
// ---------------------------------------------------------------------------

/**
 * Orders currently assigned to this packer. Filterable by status:
 *   ?status=open       (default — courier-eligible, not yet packed)
 *   ?status=packed     (already marked packed/dropped off)
 *   ?status=all        (every order ever assigned to me)
 *
 * Per-row counts (today / week / all-time) are returned in
 * `data.counters` so the dashboard can render packing performance
 * without a second round-trip.
 */
router.get('/orders', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const filter = String(req.query.status || 'open').toLowerCase();

  let q = db('orders')
    .where({ assigned_packer_id: packerId })
    .orderBy('assigned_packer_at', 'desc')
    .limit(100);

  if (filter === 'open') {
    q = q.whereNotIn('packing_status', ['packed', 'dropped_off']);
  } else if (filter === 'packed') {
    q = q.whereIn('packing_status', ['packed', 'dropped_off']);
  }

  const orders = await q.select(
    'id', 'order_number', 'customer_name', 'customer_phone',
    'delivery_method', 'delivery_address', 'line_items',
    'waybill', 'pincode',
    'terminal_id', 'nearest_locker_name',
    'collection_terminal_id',
    'status', 'packing_status', 'shopify_fulfillment_status',
    'assigned_packer_at',
    'created_at', 'packed_at', 'dropped_off_at',
  );

  // Counters: how many of mine have been packed today / this week / ever.
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - 7);

  const [today, week, allTime, openCount] = await Promise.all([
    db('orders').where({ assigned_packer_id: packerId }).whereIn('packing_status', ['packed', 'dropped_off'])
      .where('packed_at', '>=', startOfDay).count('* as n').first(),
    db('orders').where({ assigned_packer_id: packerId }).whereIn('packing_status', ['packed', 'dropped_off'])
      .where('packed_at', '>=', startOfWeek).count('* as n').first(),
    db('orders').where({ assigned_packer_id: packerId }).whereIn('packing_status', ['packed', 'dropped_off'])
      .count('* as n').first(),
    db('orders').where({ assigned_packer_id: packerId })
      .whereNotIn('packing_status', ['packed', 'dropped_off']).count('* as n').first(),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      orders,
      counters: {
        open: Number((openCount as any)?.n || 0),
        packed_today: Number((today as any)?.n || 0),
        packed_this_week: Number((week as any)?.n || 0),
        packed_all_time: Number((allTime as any)?.n || 0),
      },
    },
  });
});

// ---------------------------------------------------------------------------
// POST /packer-auth/orders/:id/reject
// ---------------------------------------------------------------------------

/**
 * Decline an assigned order. Body: { reason? } (max 200 chars).
 * Re-runs the assigner against the rest of the tenant's pool,
 * skipping this packer. Returns the new assignee id (or null when
 * nobody else is eligible — the order goes back into the tenant's
 * unassigned pool, the operator can pick from the Packing tab).
 */
router.post('/orders/:id/reject', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const orderId = req.params.id as string;
  const reason = (req.body?.reason || '').toString().trim() || 'declined';

  // Look up the order's tenant — we don't trust the client to tell us.
  const order = await db('orders').where({ id: orderId, assigned_packer_id: packerId }).first('tenant_id');
  if (!order) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not assigned to you' } });
  }

  try {
    // Lazy import to avoid loading the assigner on routes that don't need it.
    const { rejectPackerAssignment } = await import('../packerAuth/assigner');
    const result = await rejectPackerAssignment({
      tenantId: order.tenant_id,
      orderId,
      rejectingPackerId: packerId,
      reason,
    });
    log.info({ packerId, orderId, reassigned_to: result.reassigned_to?.packer_id || null }, 'Packer rejected assignment');
    return res.status(200).json({
      success: true,
      data: {
        reassigned_to_packer_id: result.reassigned_to?.packer_id || null,
        unassigned: !result.reassigned_to,
      },
    });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: { code: 'REJECT_FAILED', message: err.message } });
  }
});

// ---------------------------------------------------------------------------
// POST /packer-auth/orders/:id/mark-packed
// ---------------------------------------------------------------------------

/**
 * Packer marks one of their assigned orders as packed. Body:
 *   { note? }   (max 500 chars)
 *
 * Mirrors POST /packer/orders/:id/mark-packed (tenant side) but
 * scoped to assigned_packer_id = me, so independent packers can
 * complete their own queue without a tenant login.
 */
router.post('/orders/:id/mark-packed', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const id = req.params.id as string;
  const note = (req.body?.note || '').toString().slice(0, 500);

  const updated = await db('orders')
    .where({ id, assigned_packer_id: packerId })
    .update({
      packing_status: 'packed',
      packed_at: new Date(),
      packing_note: note || null,
      updated_at: new Date(),
    })
    .returning(['id', 'order_number', 'packing_status']);

  if (!updated || updated.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not assigned to you' } });
  }
  log.info({ packerId, orderId: id }, 'Packer marked order packed');
  return res.status(200).json({ success: true, data: updated[0] });
});

// ---------------------------------------------------------------------------
// POST /packer-auth/orders/:id/mark-dropped-off
// ---------------------------------------------------------------------------

/**
 * Packer marks one of their assigned orders as handed to the courier.
 * If the order wasn't yet marked packed, also stamps packed_at to
 * preserve the invariant that dropped_off implies packed.
 */
router.post('/orders/:id/mark-dropped-off', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const id = req.params.id as string;
  const note = (req.body?.note || '').toString().slice(0, 500);

  const updated = await db('orders')
    .where({ id, assigned_packer_id: packerId })
    .update({
      packing_status: 'dropped_off',
      dropped_off_at: new Date(),
      packing_note: note || null,
      packed_at: db.raw('COALESCE(packed_at, NOW())'),
      updated_at: new Date(),
    })
    .returning(['id', 'order_number', 'packing_status']);

  if (!updated || updated.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not assigned to you' } });
  }
  log.info({ packerId, orderId: id }, 'Packer marked order dropped off');
  return res.status(200).json({ success: true, data: updated[0] });
});

// ---------------------------------------------------------------------------
// POST /packer-auth/orders/:id/revert
// ---------------------------------------------------------------------------

/**
 * Mirror of the tenant `/packer/orders/:id/revert`, scoped to the
 * packer's own assigned orders. Sends an order back to
 * awaiting_packing if the packer flipped the wrong status (e.g.
 * marked packed by mistake). Clears packed_at / dropped_off_at so
 * the row looks the same as a fresh assignment.
 */
router.post('/orders/:id/revert', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const id = req.params.id as string;

  const updated = await db('orders')
    .where({ id, assigned_packer_id: packerId })
    .update({
      packing_status: 'awaiting_packing',
      packed_at: null,
      dropped_off_at: null,
      updated_at: new Date(),
    })
    .returning(['id', 'order_number', 'packing_status']);

  if (!updated || updated.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not assigned to you' } });
  }
  log.info({ packerId, orderId: id }, 'Packer reverted order to awaiting_packing');
  return res.status(200).json({ success: true, data: updated[0] });
});

// ---------------------------------------------------------------------------
// GET /packer-auth/queue
// ---------------------------------------------------------------------------

/**
 * Packing workbench — same shape as tenant `/packer/queue` but
 * scoped to orders where assigned_packer_id = me. The frontend
 * renderer in packer-dashboard.html is a port of `renderPacking`
 * from public/app.js, so the response keys MUST match:
 *   { orders: Order[], counts: { [packing_status]: number } }
 *
 * Filterable by ?status= awaiting_packing | packed | dropped_off | all.
 * Search across order_number / customer_name / customer_phone / waybill.
 */
router.get('/queue', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const status = String(req.query.status || 'awaiting_packing').toLowerCase();
  const limit = Math.min(parseInt(String(req.query.limit) || '100', 10) || 100, 500);
  const search = String(req.query.search || '').trim();

  let q = db('orders')
    .where({ assigned_packer_id: packerId })
    .whereNotNull('waybill')
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (status !== 'all') q = q.andWhere({ packing_status: status });
  if (search) {
    q = q.andWhere(function () {
      this.where('order_number', 'ilike', `%${search}%`)
        .orWhere('customer_name', 'ilike', `%${search}%`)
        .orWhere('customer_phone', 'ilike', `%${search}%`)
        .orWhere('waybill', 'ilike', `%${search}%`);
    });
  }

  const orders = await q
    .leftJoin('tenants as t', 't.id', 'orders.tenant_id')
    .select(
      'orders.id', 'orders.order_number', 'orders.customer_name', 'orders.customer_phone',
      'orders.delivery_method', 'orders.delivery_address', 'orders.line_items',
      'orders.waybill', 'orders.pincode', 'orders.terminal_id', 'orders.nearest_locker_name',
      'orders.packing_status', 'orders.packed_at', 'orders.dropped_off_at', 'orders.packing_note',
      'orders.created_at',
      't.email as tenant_email',
    );

  // Counts per packing_status across THIS packer's assigned orders only
  const counts = await db('orders')
    .where({ assigned_packer_id: packerId })
    .whereNotNull('waybill')
    .select('packing_status')
    .count<{ packing_status: string; count: string }[]>('id as count')
    .groupBy('packing_status');

  const countMap: Record<string, number> = {};
  counts.forEach((c: any) => { countMap[c.packing_status] = parseInt(c.count, 10); });

  return res.status(200).json({ success: true, data: { orders, counts: countMap } });
});

// ---------------------------------------------------------------------------
// GET /packer-auth/manual-upload-queue
// ---------------------------------------------------------------------------

/**
 * Packer-scoped mirror of /manual/upload-queue. Returns orders
 * routed to manual upload that are assigned to this packer.
 *
 * Same response shape so the frontend can use a port of the
 * tenant-side `renderManualUpload`:
 *   { orders: Order[], counts: { pending, completed } }
 */
router.get('/manual-upload-queue', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const status = String(req.query.status || 'pending').toLowerCase();
  const limit = Math.min(parseInt(String(req.query.limit) || '100', 10) || 100, 500);

  let q = db('orders')
    .where({ assigned_packer_id: packerId, routing_status: 'manual_upload' })
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (status === 'pending') q = q.whereNull('waybill');
  else if (status === 'completed') q = q.whereNotNull('waybill');

  const orders = await q
    .leftJoin('tenants as t', 't.id', 'orders.tenant_id')
    .select(
      'orders.id', 'orders.order_number', 'orders.customer_name', 'orders.customer_phone',
      'orders.delivery_method', 'orders.delivery_address', 'orders.line_items',
      'orders.waybill', 'orders.pincode', 'orders.manual_upload_reason',
      'orders.manual_uploaded_at', 'orders.status', 'orders.created_at',
      't.email as tenant_email',
    );

  const pendingCount = await db('orders')
    .where({ assigned_packer_id: packerId, routing_status: 'manual_upload' })
    .whereNull('waybill').count<{count:string}[]>('id as count');
  const completedCount = await db('orders')
    .where({ assigned_packer_id: packerId, routing_status: 'manual_upload' })
    .whereNotNull('waybill').count<{count:string}[]>('id as count');

  return res.status(200).json({
    success: true,
    data: {
      orders,
      counts: {
        pending: parseInt(pendingCount[0]?.count || '0', 10),
        completed: parseInt(completedCount[0]?.count || '0', 10),
      },
    },
  });
});

// ---------------------------------------------------------------------------
// POST /packer-auth/manual-upload-queue/:id/complete
// ---------------------------------------------------------------------------

/**
 * Packer submits the waybill + pin they got from the courier
 * portal after a manual upload. Mirrors the tenant
 * `/manual/upload-queue/:id/complete` and emits the same
 * `order.confirmed` domain event so WhatsApp notifications fire.
 *
 * Scoped to assigned_packer_id = me so a packer can't complete
 * orders that aren't theirs even if they guess an id.
 */
router.post('/manual-upload-queue/:id/complete', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const id = req.params.id as string;
  const { waybill, pincode } = req.body || {};

  if (!waybill || !String(waybill).trim()) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'waybill is required' } });
  }

  const order = await db('orders')
    .where({ id, assigned_packer_id: packerId, routing_status: 'manual_upload' })
    .first();
  if (!order) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not in your manual queue' } });
  }

  await db('orders').where({ id }).update({
    waybill: String(waybill).trim(),
    pincode: pincode ? String(pincode).trim() : null,
    status: 'submitted',
    courier_status: 'deposit-pending',
    packing_status: 'awaiting_packing',
    manual_uploaded_at: new Date(),
    updated_at: new Date(),
  });

  // Emit order.confirmed so WhatsApp notifications fire — mirrors the
  // tenant-side flow exactly.
  try {
    const { emitEvent, DomainEventType } = await import('../events');
    await emitEvent({
      tenantId: order.tenant_id,
      type: DomainEventType.ORDER_CONFIRMED,
      aggregateType: 'order',
      aggregateId: id,
      payload: {
        order_number: order.order_number,
        waybill: String(waybill).trim(),
        pincode: pincode ? String(pincode).trim() : null,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
        delivery_method: order.delivery_method,
        manual_upload: true,
      },
    });
  } catch (e: any) {
    log.warn({ orderId: id, error: e.message }, 'Failed to emit ORDER_CONFIRMED for packer manual upload');
  }

  log.info({ packerId, orderId: id, waybill: String(waybill).trim() }, 'Packer completed manual upload');
  return res.status(200).json({
    success: true,
    data: { message: 'Waybill recorded. Order is now in the fulfillment pipeline.' },
  });
});

// ---------------------------------------------------------------------------
// GET /packer-auth/collection-queue
// ---------------------------------------------------------------------------

/**
 * Packer-scoped mirror of /manual/collection-queue. Orders where
 * the customer picks up the parcel (routing_status = 'collection')
 * and the packer is the assigned dropoff point.
 *
 * Response shape matches the tenant route:
 *   { orders: Order[], counts: { pending, collected } }
 */
router.get('/collection-queue', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const status = String(req.query.status || 'pending').toLowerCase();
  const limit = Math.min(parseInt(String(req.query.limit) || '100', 10) || 100, 500);

  let q = db('orders')
    .where({ assigned_packer_id: packerId, routing_status: 'collection' })
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (status === 'pending') q = q.whereNull('collected_at');
  else if (status === 'collected') q = q.whereNotNull('collected_at');

  const orders = await q
    .leftJoin('tenants as t', 't.id', 'orders.tenant_id')
    .select(
      'orders.id', 'orders.order_number', 'orders.customer_name', 'orders.customer_phone',
      'orders.delivery_method', 'orders.line_items',
      'orders.collected_at', 'orders.collection_note', 'orders.status', 'orders.created_at',
      't.email as tenant_email',
    );

  const pendingCount = await db('orders')
    .where({ assigned_packer_id: packerId, routing_status: 'collection' })
    .whereNull('collected_at').count<{count:string}[]>('id as count');
  const collectedCount = await db('orders')
    .where({ assigned_packer_id: packerId, routing_status: 'collection' })
    .whereNotNull('collected_at').count<{count:string}[]>('id as count');

  return res.status(200).json({
    success: true,
    data: {
      orders,
      counts: {
        pending: parseInt(pendingCount[0]?.count || '0', 10),
        collected: parseInt(collectedCount[0]?.count || '0', 10),
      },
    },
  });
});

// ---------------------------------------------------------------------------
// POST /packer-auth/collection-queue/:id/confirm
// ---------------------------------------------------------------------------

/**
 * Packer confirms the customer has collected the order. Mirrors
 * `/manual/collection-queue/:id/confirm` — sets collected_at,
 * marks the order delivered, and emits ORDER_DELIVERED so the
 * customer's WhatsApp gets a "thanks for collecting" message.
 */
router.post('/collection-queue/:id/confirm', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;
  const id = req.params.id as string;
  const note = (req.body?.note || '').toString().trim();

  const order = await db('orders')
    .where({ id, assigned_packer_id: packerId, routing_status: 'collection' })
    .first();
  if (!order) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not in your collection queue' } });
  }

  await db('orders').where({ id }).update({
    status: 'delivered',
    collected_at: new Date(),
    collection_note: note || null,
    updated_at: new Date(),
  });

  try {
    const { emitEvent, DomainEventType } = await import('../events');
    await emitEvent({
      tenantId: order.tenant_id,
      type: DomainEventType.ORDER_DELIVERED,
      aggregateType: 'order',
      aggregateId: id,
      payload: {
        order_number: order.order_number,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
        collection: true,
      },
    });
  } catch (e: any) {
    log.warn({ orderId: id, error: e.message }, 'Failed to emit ORDER_DELIVERED for packer collection confirm');
  }

  log.info({ packerId, orderId: id }, 'Packer confirmed collection');
  return res.status(200).json({ success: true, data: { message: 'Collection confirmed' } });
});

// ---------------------------------------------------------------------------
// GET /packer-auth/ratings
// ---------------------------------------------------------------------------

/**
 * Aggregate-only view of the ratings tenants have left on this
 * packer. We deliberately don't expose individual rows or comments
 * here — packers see four numeric averages plus a count. Per-tenant
 * detail and comments stay tenant-side via /packers/:id/ratings.
 *
 * Shape:
 *   {
 *     count: number,
 *     overall: number | null,             // average of the four criteria
 *     packing_quality: number | null,
 *     speed: number | null,
 *     communication: number | null,
 *     reliability: number | null,
 *     last_rated_at: ISO string | null,
 *   }
 */
router.get('/ratings', packerAuthMiddleware, async (req: PackerAuthenticatedRequest, res: Response) => {
  const db = getDb();
  const packerId = req.packer!.packerId;

  const row = await db('packer_ratings')
    .where({ packer_id: packerId })
    .select(
      db.raw('COUNT(*)::int as count'),
      db.raw('AVG(packing_quality)::float as packing_quality'),
      db.raw('AVG(speed)::float as speed'),
      db.raw('AVG(communication)::float as communication'),
      db.raw('AVG(reliability)::float as reliability'),
      db.raw('MAX(updated_at) as last_rated_at'),
    )
    .first();

  const count = Number((row as any)?.count || 0);
  const round2 = (v: any) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
  const pq = round2((row as any)?.packing_quality);
  const sp = round2((row as any)?.speed);
  const co = round2((row as any)?.communication);
  const rl = round2((row as any)?.reliability);
  const present = [pq, sp, co, rl].filter((v) => v !== null) as number[];
  const overall = present.length ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 100) / 100 : null;

  // 30-day trend by ISO week, packed as up to 5 buckets so the
  // dashboard can chart a sparkline. Each bucket carries the
  // average overall plus the count of ratings in that bucket. We
  // bucket by date range rather than calendar week to keep the
  // chart smooth across week boundaries.
  const TREND_BUCKET_DAYS = 7;
  const TREND_BUCKETS = 5; // ~5 weeks
  const buckets: Array<{ from: string; to: string; count: number; overall: number | null }> = [];
  const now = Date.now();
  for (let i = TREND_BUCKETS - 1; i >= 0; i--) {
    const to = new Date(now - i * TREND_BUCKET_DAYS * 86400000);
    const from = new Date(to.getTime() - TREND_BUCKET_DAYS * 86400000);
    const bucketRow = await db('packer_ratings')
      .where({ packer_id: packerId })
      .where('updated_at', '>=', from)
      .where('updated_at', '<', to)
      .select(
        db.raw('COUNT(*)::int as count'),
        db.raw('AVG(packing_quality)::float as pq'),
        db.raw('AVG(speed)::float as sp'),
        db.raw('AVG(communication)::float as co'),
        db.raw('AVG(reliability)::float as rl'),
      )
      .first();
    const c = Number((bucketRow as any)?.count || 0);
    let bucketOverall: number | null = null;
    if (c > 0) {
      const avgs = [
        (bucketRow as any).pq, (bucketRow as any).sp,
        (bucketRow as any).co, (bucketRow as any).rl,
      ].map((v) => v === null || v === undefined ? null : Number(v)).filter((v): v is number => v !== null);
      bucketOverall = avgs.length ? Math.round((avgs.reduce((a, b) => a + b, 0) / avgs.length) * 100) / 100 : null;
    }
    buckets.push({
      from: from.toISOString(),
      to: to.toISOString(),
      count: c,
      overall: bucketOverall,
    });
  }

  return res.status(200).json({
    success: true,
    data: {
      count,
      overall,
      packing_quality: pq,
      speed: sp,
      communication: co,
      reliability: rl,
      last_rated_at: (row as any)?.last_rated_at || null,
      trend: buckets,
    },
  });
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

import { Router, Response } from 'express';
import crypto from 'crypto';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'packers-api' });
const router = Router();

router.use(authMiddleware);

/**
 * Tenant-side endpoints for managing the tenant's relationships with
 * independent packers. The packer-side equivalent (packer's own
 * profile, accept/decline, dashboard) ships under /packer-auth and
 * /packer/* in the next commit.
 *
 * Permission model:
 *   - packers.view       : list links + invite history (operations, viewer)
 *   - packers.invite     : create + revoke invites (operations, super_admin)
 *   - packers.manage     : pause / unlink / set load weight (operations, super_admin)
 */

const INVITE_TOKEN_BYTES = 32;
const INVITE_TTL_DAYS = 14;

// ---------------------------------------------------------------------------
// GET /packers/links
// ---------------------------------------------------------------------------

/**
 * List every independent packer currently linked to this tenant plus
 * the most-recent few invites (pending and recently expired). The
 * Packers tab uses this for its main table.
 */
router.get('/links', requirePermission('packers.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const links = await db('packer_tenant_links as l')
    .leftJoin('packers as p', 'p.id', 'l.packer_id')
    .where('l.tenant_id', tenantId)
    .orderBy('l.linked_at', 'desc')
    .select(
      'l.id', 'l.status', 'l.load_weight', 'l.note',
      'l.last_assigned_at', 'l.orders_assigned_count',
      'l.linked_at', 'l.paused_at', 'l.unlinked_at', 'l.unlink_reason',
      'p.id as packer_id', 'p.email as packer_email', 'p.full_name as packer_name',
      'p.business_name as packer_business_name', 'p.phone as packer_phone',
      'p.collection_point_type',
      'p.collection_terminal_id', 'p.collection_locker_name',
      'p.collection_door_address',
      'p.status as packer_status',
    );

  // Aggregate ratings per packer: cross-tenant average so every
  // tenant sees the same global score, plus a count. Computed in a
  // single grouped query keyed by packer_id.
  const packerIds = links.map((l: any) => l.packer_id).filter(Boolean);
  const ratingRows = packerIds.length
    ? await db('packer_ratings')
        .whereIn('packer_id', packerIds)
        .groupBy('packer_id')
        .select(
          'packer_id',
          db.raw('COUNT(*)::int as count'),
          db.raw('AVG(packing_quality)::float as packing_quality'),
          db.raw('AVG(speed)::float as speed'),
          db.raw('AVG(communication)::float as communication'),
          db.raw('AVG(reliability)::float as reliability'),
        )
    : [];
  const round2 = (v: any) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
  const ratingByPacker: Record<string, any> = {};
  for (const r of ratingRows as any[]) {
    const pq = round2(r.packing_quality);
    const sp = round2(r.speed);
    const co = round2(r.communication);
    const rl = round2(r.reliability);
    const present = [pq, sp, co, rl].filter((v) => v !== null) as number[];
    const overall = present.length ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 100) / 100 : null;
    ratingByPacker[r.packer_id] = {
      count: Number(r.count) || 0,
      overall,
      packing_quality: pq,
      speed: sp,
      communication: co,
      reliability: rl,
    };
  }
  for (const l of links as any[]) {
    l.rating = l.packer_id ? (ratingByPacker[l.packer_id] || null) : null;
  }

  const invites = await db('packer_invites')
    .where({ tenant_id: tenantId })
    .orderBy('created_at', 'desc')
    .limit(20)
    .select('id', 'email', 'status', 'load_weight', 'note', 'expires_at', 'created_at', 'accepted_at');

  const settings = await db('tenant_collection_settings')
    .where({ tenant_id: tenantId })
    .first('packer_assignment_mode');

  return res.status(200).json({
    success: true,
    data: {
      links,
      invites,
      settings: {
        packer_assignment_mode: settings?.packer_assignment_mode || 'off',
      },
    },
  });
});

// ---------------------------------------------------------------------------
// POST /packers/invites
// ---------------------------------------------------------------------------

/**
 * Create an invite link. Body:
 *   { email, load_weight? (default 1), note? }
 *
 * Returns the invite row including the accept_url. In production the
 * accept_url is also emailed to the packer; for now (no email service
 * wired up) the tenant copies it from the response and shares it
 * manually.
 *
 * Idempotency: re-inviting the same email while a pending invite
 * exists revokes the old one and mints a fresh token. This keeps the
 * UX clean — the tenant doesn't have to chase down stale tokens.
 */
router.post('/invites', requirePermission('packers.invite'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const inviterUserId = req.tenant!.userId;
  const { email: emailRaw, load_weight: loadWeightRaw, note } = req.body || {};

  const email = String(emailRaw || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_EMAIL', message: 'A valid email is required' } });
  }
  const loadWeight = Math.max(1, Math.min(10, parseInt(String(loadWeightRaw ?? '1'), 10) || 1));

  // Refuse if a packer with this email is already actively linked.
  const linked = await db('packer_tenant_links as l')
    .join('packers as p', 'p.id', 'l.packer_id')
    .where({ 'l.tenant_id': tenantId, 'p.email': email, 'l.status': 'active' })
    .first();
  if (linked) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_LINKED', message: 'A packer with this email is already linked to your tenant' } });
  }

  const token = crypto.randomBytes(INVITE_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.transaction(async (trx) => {
    // Revoke any prior pending invite for the same email
    await trx('packer_invites')
      .where({ tenant_id: tenantId, email, status: 'pending' })
      .update({ status: 'revoked', updated_at: new Date() });

    await trx('packer_invites').insert({
      tenant_id: tenantId,
      email,
      token,
      status: 'pending',
      load_weight: loadWeight,
      note: note || null,
      invited_by_user_id: inviterUserId || null,
      expires_at: expiresAt,
    });
  });

  // The accept_url is what the operator copy/pastes (or, in the future,
  // what the email body contains). The packer hits /packer-signup
  // pre-filled with the token; the packer-auth router resolves the
  // token, links the packer to the inviting tenant, and marks the
  // invite accepted.
  const accept_url = `/packer-signup?token=${encodeURIComponent(token)}`;

  log.info({ tenantId, email, by: req.tenant?.email, loadWeight }, 'Packer invite created');
  return res.status(201).json({
    success: true,
    data: { email, load_weight: loadWeight, expires_at: expiresAt, accept_url, token },
  });
});

// ---------------------------------------------------------------------------
// POST /packers/invites/:id/revoke
// ---------------------------------------------------------------------------

router.post('/invites/:id/revoke', requirePermission('packers.invite'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const id = req.params.id as string;

  const updated = await db('packer_invites')
    .where({ id, tenant_id: tenantId, status: 'pending' })
    .update({ status: 'revoked', updated_at: new Date() })
    .returning(['id']);
  if (!updated || updated.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Pending invite not found' } });
  }
  return res.status(200).json({ success: true, data: { id, status: 'revoked' } });
});

// ---------------------------------------------------------------------------
// PUT /packers/links/:id (set load weight, pause/resume)
// ---------------------------------------------------------------------------

/**
 * Mutate an existing link. Body:
 *   { load_weight?, status? ('active' | 'paused'), note? }
 *
 * Use this to throttle a slow packer ("pause") or dial weights
 * after a few weeks of running. Unlinking is a separate route below
 * because it's destructive enough to warrant its own action.
 */
router.put('/links/:id', requirePermission('packers.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const id = req.params.id as string;
  const { load_weight, status, note } = req.body || {};

  const data: any = { updated_at: new Date() };
  if (load_weight !== undefined) {
    const w = Math.max(1, Math.min(10, parseInt(String(load_weight), 10) || 1));
    data.load_weight = w;
  }
  if (status !== undefined) {
    if (!['active', 'paused'].includes(status)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_STATUS', message: 'status must be active or paused' } });
    }
    data.status = status;
    data.paused_at = status === 'paused' ? new Date() : null;
  }
  if (note !== undefined) data.note = note || null;

  const updated = await db('packer_tenant_links')
    .where({ id, tenant_id: tenantId })
    .update(data)
    .returning(['id', 'status', 'load_weight', 'note']);
  if (!updated || updated.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Link not found' } });
  }
  return res.status(200).json({ success: true, data: updated[0] });
});

// ---------------------------------------------------------------------------
// POST /packers/links/:id/unlink
// ---------------------------------------------------------------------------

/**
 * Hard end of the relationship. Sets status='kicked', records
 * unlinked_at + unlink_reason. The packer keeps their account and the
 * row stays in the table for audit (we never DELETE links).
 */
router.post('/links/:id/unlink', requirePermission('packers.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const id = req.params.id as string;
  const reason = (req.body?.reason || '').toString().trim() || 'kicked_by_tenant';

  const updated = await db('packer_tenant_links')
    .where({ id, tenant_id: tenantId })
    .whereNot({ status: 'kicked' })
    .update({
      status: 'kicked',
      unlinked_at: new Date(),
      unlink_reason: reason.slice(0, 30),
      updated_at: new Date(),
    })
    .returning(['id']);
  if (!updated || updated.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Active link not found' } });
  }
  log.info({ tenantId, linkId: id, by: req.tenant?.email }, 'Packer link kicked by tenant');
  return res.status(200).json({ success: true, data: { id, status: 'kicked' } });
});

// ---------------------------------------------------------------------------
// PUT /packers/settings — assignment mode (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Toggle the tenant's packer assignment mode. Body:
 *   { packer_assignment_mode: 'off' | 'independents_only' | 'split_evenly' | 'internal_first' }
 *
 * The pipeline's PAYLOAD_CREATED stage reads this on every order to
 * decide whether to route the courier handoff to an independent
 * packer's collection point. Modes are upserted on
 * tenant_collection_settings (one row per tenant) so the same row
 * the existing settings UI writes through is the single source of
 * truth.
 */
const VALID_MODES = ['off', 'independents_only', 'split_evenly', 'internal_first'];

router.put('/settings', requirePermission('packers.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { packer_assignment_mode } = req.body || {};
  if (!VALID_MODES.includes(packer_assignment_mode)) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_MODE', message: `packer_assignment_mode must be one of: ${VALID_MODES.join(', ')}` },
    });
  }

  // Upsert the row — most tenants already have one (created when they
  // configured collection contact in Settings), but defensive in case
  // a tenant gets here before that.
  const existing = await db('tenant_collection_settings').where({ tenant_id: tenantId }).first();
  if (existing) {
    await db('tenant_collection_settings')
      .where({ tenant_id: tenantId })
      .update({ packer_assignment_mode, updated_at: new Date() });
  } else {
    await db('tenant_collection_settings').insert({
      tenant_id: tenantId,
      packer_assignment_mode,
    });
  }

  log.info({ tenantId, packer_assignment_mode, by: req.tenant?.email }, 'Packer assignment mode updated');
  return res.status(200).json({ success: true, data: { packer_assignment_mode } });
});

// ---------------------------------------------------------------------------
// POST /packers/ratings — submit / update a rating for a packer
// ---------------------------------------------------------------------------

/**
 * Body: {
 *   packer_id: uuid,
 *   order_id:  uuid,
 *   packing_quality: 1..5,
 *   speed: 1..5,
 *   communication: 1..5,
 *   reliability: 1..5,
 *   comment?: string (max 2000)
 * }
 *
 * Constraints (enforced server-side):
 *   - The order must belong to this tenant AND must already be
 *     dropped_off (or `delivered` for collection orders) — we don't
 *     accept ratings on in-flight work.
 *   - The order must have been assigned to the given packer
 *     (assigned_packer_id matches). Without that match, the tenant
 *     can't legitimately rate someone else's work.
 *   - Re-rating the same (packer, order) pair updates the existing
 *     row instead of inserting a duplicate (the unique key on the
 *     table guarantees it; we use ON CONFLICT MERGE for clarity).
 */
const RATING_FIELDS = ['packing_quality', 'speed', 'communication', 'reliability'] as const;
const COMMENT_MAX_LEN = 2000;

router.post('/ratings', requirePermission('packers.rate'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const userId = req.tenant!.userId;
  const body = req.body || {};

  const packerId = String(body.packer_id || '').trim();
  const orderId = String(body.order_id || '').trim();
  if (!packerId || !orderId) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'packer_id and order_id are required' } });
  }

  // Coerce + validate score fields
  const scores: Record<string, number> = {};
  for (const f of RATING_FIELDS) {
    const n = parseInt(String(body[f]), 10);
    if (!Number.isFinite(n) || n < 1 || n > 5) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_SCORE', message: `${f} must be an integer 1..5` } });
    }
    scores[f] = n;
  }
  const comment = body.comment === undefined || body.comment === null
    ? null
    : String(body.comment).slice(0, COMMENT_MAX_LEN);

  // Enforce tenant ownership + packer assignment + completion
  const order = await db('orders')
    .where({ id: orderId, tenant_id: tenantId })
    .first('id', 'assigned_packer_id', 'assigned_packer_history', 'packing_status', 'status', 'routing_status');
  if (!order) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
  }

  // Eligibility: the packer must have been assigned to this order at
  // some point. We accept the *current* assigned_packer_id OR any
  // entry in assigned_packer_history with no rejected_at — that covers
  // reassignment chains where an earlier packer rejected and a later
  // one delivered, and lets a tenant rate the actual deliverer rather
  // than only whoever the row currently points at.
  const isCurrent = order.assigned_packer_id === packerId;
  const history = (() => {
    if (!order.assigned_packer_history) return [];
    if (Array.isArray(order.assigned_packer_history)) return order.assigned_packer_history;
    try { return JSON.parse(order.assigned_packer_history); } catch { return []; }
  })();
  const wasInHistory = history.some((e: any) => e && e.packer_id === packerId && !e.rejected_at);
  if (!isCurrent && !wasInHistory) {
    return res.status(400).json({
      success: false,
      error: { code: 'NOT_ASSIGNED', message: 'This order was not handled by the packer you are rating' },
    });
  }
  // Allow rating once the parcel has visibly left the packer's hands.
  // Packing-flow orders: dropped_off. Collection orders end at
  // status='delivered' once the customer collects.
  const isComplete = order.packing_status === 'dropped_off' || order.status === 'delivered';
  if (!isComplete) {
    return res.status(400).json({
      success: false,
      error: { code: 'NOT_READY', message: 'You can rate this order once it is dropped off (or collected)' },
    });
  }

  // Upsert by the unique (tenant, packer, order) tuple. Using
  // onConflict().merge() keeps the original created_at and only
  // bumps the scores + updated_at.
  const [row] = await db('packer_ratings')
    .insert({
      tenant_id: tenantId,
      packer_id: packerId,
      order_id: orderId,
      rated_by_user_id: userId || null,
      ...scores,
      comment,
    })
    .onConflict(['tenant_id', 'packer_id', 'order_id'])
    .merge({ ...scores, comment, updated_at: new Date() })
    .returning(['id', 'created_at', 'updated_at']);

  log.info({ tenantId, packerId, orderId, by: req.tenant?.email }, 'Packer rating saved');
  return res.status(200).json({
    success: true,
    data: {
      id: row.id,
      packer_id: packerId,
      order_id: orderId,
      ...scores,
      comment,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /packers/:packerId/ratings — tenant's own rating history + aggregates
// ---------------------------------------------------------------------------

/**
 * Returns:
 *   {
 *     aggregate: {                  // cross-tenant average (everyone sees the same)
 *       count, overall, packing_quality, speed, communication, reliability,
 *     },
 *     mine: [                       // this tenant's own rows only
 *       { id, order_id, order_number?, packing_quality, ..., comment, created_at, updated_at }
 *     ]
 *   }
 *
 * The packer's identity gates this — we only return data for a
 * packer the calling tenant is actually linked to (active, paused,
 * left, kicked — any non-pending link counts so historical ratings
 * stay visible after a kick).
 */
router.get('/:packerId/ratings', requirePermission('packers.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const packerId = req.params.packerId as string;

  // Authorisation: caller must have at least one link to this packer
  // (active or historical) — this prevents browsing ratings for
  // arbitrary packer ids by enumerating UUIDs.
  const link = await db('packer_tenant_links')
    .where({ tenant_id: tenantId, packer_id: packerId })
    .first('id');
  if (!link) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Packer not linked to your tenant' } });
  }

  // Cross-tenant aggregate
  const agg = await db('packer_ratings')
    .where({ packer_id: packerId })
    .select(
      db.raw('COUNT(*)::int as count'),
      db.raw('AVG(packing_quality)::float as packing_quality'),
      db.raw('AVG(speed)::float as speed'),
      db.raw('AVG(communication)::float as communication'),
      db.raw('AVG(reliability)::float as reliability'),
    )
    .first();
  const round2 = (v: any) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
  const pq = round2((agg as any)?.packing_quality);
  const sp = round2((agg as any)?.speed);
  const co = round2((agg as any)?.communication);
  const rl = round2((agg as any)?.reliability);
  const present = [pq, sp, co, rl].filter((v) => v !== null) as number[];
  const overall = present.length ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 100) / 100 : null;

  // This tenant's own rows, joined to orders so the UI can label by
  // human-readable order_number.
  const mine = await db('packer_ratings as r')
    .leftJoin('orders as o', 'o.id', 'r.order_id')
    .where('r.tenant_id', tenantId)
    .andWhere('r.packer_id', packerId)
    .orderBy('r.updated_at', 'desc')
    .select(
      'r.id', 'r.order_id', 'o.order_number',
      'r.packing_quality', 'r.speed', 'r.communication', 'r.reliability',
      'r.comment', 'r.created_at', 'r.updated_at',
    );

  return res.status(200).json({
    success: true,
    data: {
      aggregate: {
        count: Number((agg as any)?.count || 0),
        overall,
        packing_quality: pq,
        speed: sp,
        communication: co,
        reliability: rl,
      },
      mine,
    },
  });
});

export default router;

import type { Knex } from 'knex';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'packer-assigner' });

/**
 * Rating-aware effective load weight.
 *
 *   effective = load_weight * (rating ?? RATING_NEUTRAL) / RATING_NEUTRAL
 *   floor     = MIN_FRACTION * load_weight
 *
 * A packer's nominal load_weight is what the tenant set in the
 * Packers tab. We multiply it by their cross-tenant overall rating
 * (0..5) divided by a neutral 4.0, so:
 *
 *   - rating 4.0 (neutral) → effective = nominal
 *   - rating 5.0           → effective = 1.25x nominal
 *   - rating 2.0           → effective = 0.50x nominal
 *   - no rating yet        → treated as 4.0 so a brand-new packer
 *                            isn't immediately starved out by an
 *                            established competitor.
 *
 * The MIN_FRACTION floor (0.25) means even a 1-star packer still
 * gets a quarter of their nominal share. We don't outright exclude
 * low-rated packers via this knob; that's what status='paused' and
 * load_weight=0 are for, both of which are explicit operator actions.
 */
const RATING_NEUTRAL = 4.0;
const MIN_FRACTION = 0.25;

export function effectiveLoadWeight(loadWeight: number, rating: number | null | undefined): number {
  const nominal = Math.max(loadWeight, 0);
  if (nominal === 0) return 0;
  const r = (rating === null || rating === undefined) ? RATING_NEUTRAL : Math.max(0, Math.min(5, rating));
  const scaled = nominal * (r / RATING_NEUTRAL);
  const floor = nominal * MIN_FRACTION;
  return Math.max(scaled, floor);
}

export interface PackerCollectionProfile {
  packer_id: string;
  full_name: string | null;
  business_name: string | null;
  phone: string | null;
  collection_terminal_id: string | null;
  collection_locker_name: string | null;
  collection_door_address: any | null;
  collection_contact_name: string | null;
  collection_contact_phone: string | null;
  collection_contact_email: string | null;
}

export interface PackerSelection {
  packer_id: string;
  link_id: string;
  profile: PackerCollectionProfile;
}

/**
 * Pick an independent packer for a new order using a lowest-cumulative-load
 * round-robin over active links. Returns the chosen packer + link or null if
 * the tenant has no eligible packer (then the caller falls back to the
 * tenant's own collection address — the order isn't blocked).
 *
 * READ-ONLY. No DB writes happen here. Use `commitPackerAssignment` after
 * the order row is created to stamp + increment counters atomically.
 *
 * Mode semantics:
 *   off                — never assigns; returns null (default for existing
 *                        tenants — keeps behaviour identical until they
 *                        explicitly opt in).
 *   independents_only  — always tries to assign; if no packer available,
 *                        returns null and the caller uses the tenant's
 *                        own collection address.
 *   split_evenly       — same as independents_only for now (reserved for
 *                        tie-breaking with internal teams later).
 *   internal_first     — reserved; currently behaves like 'off'.
 *
 * Eligibility:
 *   - link.status = 'active'
 *   - packer.status != 'disabled'
 *   - link.load_weight > 0
 *   - packer has at least ONE collection point: a locker terminal_id OR
 *     a collection_door_address with a street/city. A packer with no
 *     usable collection point can't actually receive orders, so we skip
 *     them rather than stamping an order we can't ship.
 */
/**
 * Internal: load and rank candidate packers for a tenant.
 *
 * Returns an array of candidates already sorted by ascending
 * cumulative effective load, plus a flag in `chosen` for the winner.
 * `excludePackerId` is honoured when set so the reject flow never
 * re-picks the rejecting packer.
 *
 * The query joins packers + links and LEFT JOINs an aggregated
 * `packer_ratings` row per packer so we can compute effective weight
 * in a single round-trip rather than N round-trips.
 */
async function loadRankedCandidates(args: {
  tenantId: string;
  excludePackerId?: string | null;
}): Promise<Array<{
  link_id: string;
  load_weight: number;
  effective_weight: number;
  cumulative_load: number;
  rating_overall: number | null;
  rating_count: number;
  orders_assigned_count: number;
  packer_id: string;
  full_name: string | null;
  business_name: string | null;
  phone: string | null;
  collection_terminal_id: string | null;
  collection_locker_name: string | null;
  collection_door_address: any;
  collection_contact_name: string | null;
  collection_contact_phone: string | null;
  collection_contact_email: string | null;
}>> {
  const db = getDb();

  // Subquery: per-packer aggregate rating across all tenants.
  // We compute the average of the four criteria as the overall.
  // Using a subquery keeps the join shape simple and ensures one
  // row per packer.
  const ratingsSubquery = db('packer_ratings')
    .select('packer_id')
    .select(db.raw('COUNT(*)::int as rating_count'))
    .select(db.raw(`
      (AVG(packing_quality) + AVG(speed) + AVG(communication) + AVG(reliability)) / 4.0
      AS rating_overall
    `))
    .groupBy('packer_id')
    .as('r');

  let q = db('packer_tenant_links as l')
    .join('packers as p', 'p.id', 'l.packer_id')
    .leftJoin(ratingsSubquery, 'r.packer_id', 'l.packer_id')
    .where('l.tenant_id', args.tenantId)
    .where('l.status', 'active')
    .whereNot('p.status', 'disabled')
    .where('l.load_weight', '>', 0)
    .andWhere(function () {
      this
        .whereNotNull('p.collection_terminal_id')
        .orWhereRaw(
          "p.collection_door_address IS NOT NULL " +
          "AND (p.collection_door_address->>'street_address' <> '' " +
          "  OR p.collection_door_address->>'street' <> '' " +
          "  OR p.collection_door_address->>'city' <> '')",
        );
    });

  if (args.excludePackerId) {
    q = q.whereNot('l.packer_id', args.excludePackerId);
  }

  const rows = await q
    .orderBy('l.last_assigned_at', 'asc', 'first')
    .select(
      'l.id as link_id',
      'l.load_weight',
      'l.orders_assigned_count',
      'p.id as packer_id',
      'p.full_name',
      'p.business_name',
      'p.phone',
      'p.collection_terminal_id',
      'p.collection_locker_name',
      'p.collection_door_address',
      'p.collection_contact_name',
      'p.collection_contact_phone',
      'p.collection_contact_email',
      'r.rating_overall',
      'r.rating_count',
    );

  // Compute effective_weight + cumulative_load in JS so the algorithm
  // is testable and easy to tweak. The DB-side join already did the
  // heavy aggregation.
  const enriched = rows.map((row: any) => {
    const ratingOverall = row.rating_overall === null || row.rating_overall === undefined
      ? null
      : Number(row.rating_overall);
    const eff = effectiveLoadWeight(row.load_weight, ratingOverall);
    const cumulative = eff > 0 ? row.orders_assigned_count / eff : Number.POSITIVE_INFINITY;
    return {
      ...row,
      rating_overall: ratingOverall,
      rating_count: Number(row.rating_count || 0),
      effective_weight: eff,
      cumulative_load: cumulative,
    };
  });

  // Sort by cumulative load asc; tie-break preserved by the SQL
  // ordering on last_assigned_at (stable sort).
  enriched.sort((a, b) => a.cumulative_load - b.cumulative_load);
  return enriched;
}

export async function selectEligiblePacker(
  tenantId: string,
): Promise<PackerSelection | null> {
  const db = getDb();

  const settings = await db('tenant_collection_settings')
    .where({ tenant_id: tenantId })
    .first('packer_assignment_mode');

  const mode = (settings?.packer_assignment_mode || 'off').toLowerCase();
  if (mode === 'off' || mode === 'internal_first') {
    return null;
  }

  const candidates = await loadRankedCandidates({ tenantId });
  if (!candidates.length) {
    log.info({ tenantId, mode }, 'No eligible independent packer; falling back to tenant defaults');
    return null;
  }

  const chosen = candidates[0];
  log.info({
    tenantId,
    packer_id: chosen.packer_id,
    link_id: chosen.link_id,
    cumulative_load: chosen.cumulative_load,
    nominal_weight: chosen.load_weight,
    effective_weight: chosen.effective_weight,
    rating_overall: chosen.rating_overall,
    rating_count: chosen.rating_count,
    mode,
  }, 'Selected independent packer for order');

  return {
    packer_id: chosen.packer_id,
    link_id: chosen.link_id,
    profile: {
      packer_id: chosen.packer_id,
      full_name: chosen.full_name,
      business_name: chosen.business_name,
      phone: chosen.phone,
      collection_terminal_id: chosen.collection_terminal_id,
      collection_locker_name: chosen.collection_locker_name,
      collection_door_address: chosen.collection_door_address,
      collection_contact_name: chosen.collection_contact_name,
      collection_contact_phone: chosen.collection_contact_phone,
      collection_contact_email: chosen.collection_contact_email,
    },
  };
}

/**
 * Stamp `assigned_packer_id` on the order and bump the link's
 * `orders_assigned_count` + `last_assigned_at`. Runs inside the caller's
 * transaction so the increment is committed atomically with the order
 * row's creation. If the order ultimately fails to submit and the
 * transaction rolls back, the counter is rolled back too — no wasted
 * slots on the packer's load counter.
 *
 * Also appends a fresh entry to `assigned_packer_history` so the
 * tenant has a full audit trail of who was assigned this order over
 * time (useful when investigating reject/reassign loops).
 */
export async function commitPackerAssignment(args: {
  trx: Knex.Transaction;
  orderId: string;
  packerId: string;
  linkId: string;
  packerEmail?: string | null;
}): Promise<void> {
  const { trx, orderId, packerId, linkId, packerEmail } = args;
  const now = new Date();

  // Read existing history (might be null on first assignment)
  const existing = await trx('orders').where({ id: orderId }).first('assigned_packer_history');
  const history = Array.isArray(existing?.assigned_packer_history) ? existing.assigned_packer_history : [];
  history.push({
    packer_id: packerId,
    packer_email: packerEmail || null,
    assigned_at: now.toISOString(),
    rejected_at: null,
    reject_reason: null,
  });

  await trx('orders').where({ id: orderId }).update({
    assigned_packer_id: packerId,
    assigned_packer_at: now,
    assigned_packer_history: JSON.stringify(history),
    updated_at: now,
  });
  await trx('packer_tenant_links').where({ id: linkId }).increment('orders_assigned_count', 1);
  await trx('packer_tenant_links').where({ id: linkId }).update({
    last_assigned_at: now,
    updated_at: now,
  });
  log.info({ orderId, packer_id: packerId, link_id: linkId }, 'Packer assignment committed');
}

/**
 * Reject the current packer's assignment on an order and try to
 * pick a different eligible packer. Atomic — both writes happen in
 * one transaction so the rejecting packer is never "stuck" with
 * the order even if reassignment fails.
 *
 * Behaviour:
 *   - Marks the current history entry rejected_at + reject_reason.
 *   - Decrements the rejecting link's orders_assigned_count (the
 *     packer didn't actually pack it).
 *   - Calls selectEligiblePacker again, EXCLUDING the rejecting
 *     packer, and stamps the new assignee + appends a fresh history
 *     entry. If no other packer is eligible, leaves the order
 *     unassigned (assigned_packer_id = null) so a tenant operator
 *     can intervene from the Packing tab.
 *
 * Returns the new assignment (or null if reassignment didn't find a
 * candidate).
 */
export async function rejectPackerAssignment(args: {
  tenantId: string;
  orderId: string;
  rejectingPackerId: string;
  reason: string;
}): Promise<{ reassigned_to: PackerSelection | null }> {
  const db = getDb();
  const { tenantId, orderId, rejectingPackerId, reason } = args;

  const order = await db('orders')
    .where({ id: orderId, tenant_id: tenantId })
    .first('id', 'assigned_packer_id', 'assigned_packer_history');
  if (!order) {
    throw new Error('Order not found');
  }
  if (order.assigned_packer_id !== rejectingPackerId) {
    throw new Error('Order is not assigned to you');
  }

  const rejectingLink = await db('packer_tenant_links')
    .where({ tenant_id: tenantId, packer_id: rejectingPackerId })
    .first('id', 'orders_assigned_count');

  // Pick a replacement BEFORE writing anything, so we can encode the
  // outcome in a single transaction below.
  const replacement = await selectEligiblePackerExcluding(tenantId, rejectingPackerId);

  await db.transaction(async (trx) => {
    // Update history: close the current entry, append the next if any.
    const history = Array.isArray(order.assigned_packer_history)
      ? order.assigned_packer_history.slice()
      : [];
    if (history.length && history[history.length - 1].rejected_at == null) {
      history[history.length - 1].rejected_at = new Date().toISOString();
      history[history.length - 1].reject_reason = (reason || '').slice(0, 200);
    }

    if (replacement) {
      history.push({
        packer_id: replacement.packer_id,
        packer_email: null,
        assigned_at: new Date().toISOString(),
        rejected_at: null,
        reject_reason: null,
      });
      await trx('orders').where({ id: orderId }).update({
        assigned_packer_id: replacement.packer_id,
        assigned_packer_at: new Date(),
        assigned_packer_history: JSON.stringify(history),
        updated_at: new Date(),
      });
      await trx('packer_tenant_links').where({ id: replacement.link_id }).increment('orders_assigned_count', 1);
      await trx('packer_tenant_links').where({ id: replacement.link_id }).update({
        last_assigned_at: new Date(),
        updated_at: new Date(),
      });
    } else {
      await trx('orders').where({ id: orderId }).update({
        assigned_packer_id: null,
        assigned_packer_at: null,
        assigned_packer_history: JSON.stringify(history),
        updated_at: new Date(),
      });
    }

    // Decrement the rejecting link's counter so its load weight is fair.
    if (rejectingLink && rejectingLink.orders_assigned_count > 0) {
      await trx('packer_tenant_links')
        .where({ id: rejectingLink.id })
        .update({
          orders_assigned_count: Math.max(0, rejectingLink.orders_assigned_count - 1),
          updated_at: new Date(),
        });
    }
  });

  log.info({
    tenantId,
    orderId,
    rejecting_packer_id: rejectingPackerId,
    reassigned_to: replacement?.packer_id || null,
    reason: (reason || '').slice(0, 200),
  }, 'Packer rejected assignment');

  return { reassigned_to: replacement };
}

/**
 * Same selection algorithm as selectEligiblePacker but skips the
 * given packer id. Used by the reject flow so the rejecting packer
 * doesn't get re-assigned the order they just declined.
 */
async function selectEligiblePackerExcluding(
  tenantId: string,
  excludePackerId: string,
): Promise<PackerSelection | null> {
  const db = getDb();
  const settings = await db('tenant_collection_settings')
    .where({ tenant_id: tenantId })
    .first('packer_assignment_mode');

  const mode = (settings?.packer_assignment_mode || 'off').toLowerCase();
  if (mode === 'off' || mode === 'internal_first') {
    return null;
  }

  const candidates = await loadRankedCandidates({ tenantId, excludePackerId });
  if (!candidates.length) return null;

  const chosen = candidates[0];
  return {
    packer_id: chosen.packer_id,
    link_id: chosen.link_id,
    profile: {
      packer_id: chosen.packer_id,
      full_name: chosen.full_name,
      business_name: chosen.business_name,
      phone: chosen.phone,
      collection_terminal_id: chosen.collection_terminal_id,
      collection_locker_name: chosen.collection_locker_name,
      collection_door_address: chosen.collection_door_address,
      collection_contact_name: chosen.collection_contact_name,
      collection_contact_phone: chosen.collection_contact_phone,
      collection_contact_email: chosen.collection_contact_email,
    },
  };
}

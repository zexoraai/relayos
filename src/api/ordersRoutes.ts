import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'orders-api' });
const router = Router();

router.use(authMiddleware);

/**
 * GET /orders
 *
 * Unified order view across emails, pipeline, caretaker, packer,
 * fulfillment, and Shopify. The dashboard has historically forced an
 * operator to flip between four tabs to answer "where is order #X" —
 * this endpoint pulls the canonical state of every order plus its
 * surrounding context into one row so the Orders tab can render the
 * answer in a single table.
 *
 * Query params (all optional):
 *
 *   - search          : ILIKE match across order_number, customer_name,
 *                       customer_phone (digits-only), waybill,
 *                       terminal_id, raw_shipping_address, and email
 *                       subject/sender. Min 2 chars, otherwise ignored.
 *   - status          : comma-separated list filter on orders.status
 *   - packing_status  : comma-separated list filter on orders.packing_status
 *   - routing_status  : comma-separated list filter on orders.routing_status
 *   - email_status    : 'fetched' | 'processing' | 'processed' | 'failed'
 *                       — derived per row, see deriveEmailStatus()
 *   - pipeline_status : comma-separated list (completed / pending_review /
 *                       failed / processing / pending / rejected)
 *   - has_review      : 'yes' (open caretaker review only) | 'no'
 *   - shopify         : 'fulfilled' | 'pending' | 'cancelled'
 *   - date_from       : ISO date or "today" | "7d" | "30d" — applied to
 *                       orders.created_at (or email_date when no order
 *                       row exists yet — see notes below)
 *   - date_to         : ISO date
 *   - sort            : 'newest' (default) | 'oldest' |
 *                       'status_priority' (failed/review > in_transit >
 *                        delivered)
 *   - limit, offset   : pagination, capped at 200 per page
 *
 * Returns:
 *
 *   {
 *     success: true,
 *     data: { rows: OrderRow[], total: number, counts: { ... } }
 *   }
 *
 * `counts` carries top-level distribution (by status / packing /
 * routing / email_status / shopify) so filter chips render with live
 * numbers without a second roundtrip.
 *
 * Permission: orders.view.
 */
router.get('/', requirePermission('orders.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const {
    search: searchRaw,
    status: statusRaw,
    packing_status: packingRaw,
    routing_status: routingRaw,
    email_status: emailStatusRaw,
    pipeline_status: pipelineStatusRaw,
    has_review: hasReviewRaw,
    shopify: shopifyRaw,
    date_from: dateFromRaw,
    date_to: dateToRaw,
    sort: sortRaw,
  } = req.query as Record<string, string | undefined>;

  const limit = Math.max(1, Math.min(parseInt((req.query.limit as string) || '50', 10) || 50, 200));
  const offset = Math.max(0, parseInt((req.query.offset as string) || '0', 10) || 0);

  // ---- Build base joined query --------------------------------------
  //
  // LEFT JOIN every related table so an order shows up even if (e.g.)
  // its fulfillment_job hasn't been created yet. Use LATERAL joins for
  // the "latest" caretaker_evaluation and ai_address_reconciliation
  // rows so a job with multiple rows returns only the most recent.

  const q = db('orders as o')
    .leftJoin('pipeline_jobs as pj', 'pj.id', 'o.pipeline_job_id')
    .leftJoin('ingested_emails as ie', 'ie.id', 'o.email_id')
    .leftJoin('fulfillment_jobs as fj', 'fj.order_id', 'o.id')
    .joinRaw(`
      LEFT JOIN LATERAL (
        SELECT id, verdict, resolution, resolved_by, resolved_at,
               summary, created_at AS ce_created_at
          FROM caretaker_evaluations
         WHERE pipeline_job_id = pj.id
         ORDER BY created_at DESC
         LIMIT 1
      ) ce ON TRUE
    `)
    .joinRaw(`
      LEFT JOIN LATERAL (
        SELECT decision, confidence, ai_used, missing_after
          FROM ai_address_reconciliations
         WHERE pipeline_job_id = pj.id
         ORDER BY created_at DESC
         LIMIT 1
      ) recon ON TRUE
    `)
    .where('o.tenant_id', tenantId);

  // ---- Filters ------------------------------------------------------

  const splitList = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

  const statusList = splitList(statusRaw);
  if (statusList.length === 1) q.andWhere('o.status', statusList[0]);
  else if (statusList.length > 1) q.whereIn('o.status', statusList);

  const packingList = splitList(packingRaw);
  if (packingList.length === 1) q.andWhere('o.packing_status', packingList[0]);
  else if (packingList.length > 1) q.whereIn('o.packing_status', packingList);

  const routingList = splitList(routingRaw);
  if (routingList.length === 1) q.andWhere('o.routing_status', routingList[0]);
  else if (routingList.length > 1) q.whereIn('o.routing_status', routingList);

  const pipelineStatusList = splitList(pipelineStatusRaw);
  if (pipelineStatusList.length === 1) q.andWhere('pj.status', pipelineStatusList[0]);
  else if (pipelineStatusList.length > 1) q.whereIn('pj.status', pipelineStatusList);

  // Email status — folded down to four meaningful states for the UI:
  //   - 'failed'     : ingested_emails.status = 'failed' OR last_error set
  //   - 'processed'  : processed_at IS NOT NULL
  //   - 'processing' : processing_at IS NOT NULL AND processed_at IS NULL
  //   - 'fetched'    : everything else (queued / waiting)
  if (emailStatusRaw === 'failed') {
    q.where(function () {
      this.where('ie.status', 'failed').orWhereNotNull('ie.last_error');
    });
  } else if (emailStatusRaw === 'processed') {
    q.whereNotNull('ie.processed_at');
  } else if (emailStatusRaw === 'processing') {
    q.whereNotNull('ie.processing_at').whereNull('ie.processed_at');
  } else if (emailStatusRaw === 'fetched') {
    q.whereNull('ie.processed_at').whereNull('ie.processing_at')
      .whereNot(function () { this.where('ie.status', 'failed'); });
  }

  if (hasReviewRaw === 'yes') {
    q.whereNotNull('ce.id').whereNull('ce.resolution');
  } else if (hasReviewRaw === 'no') {
    q.where(function () {
      this.whereNull('ce.id').orWhereNotNull('ce.resolution');
    });
  }

  if (shopifyRaw === 'fulfilled') q.andWhere('o.shopify_fulfilled', true);
  else if (shopifyRaw === 'pending') q.andWhere('o.shopify_fulfilled', false);
  else if (shopifyRaw === 'cancelled') q.andWhere('o.shopify_fulfillment_status', 'cancelled');

  // Date filters — accept ISO date or one of the named windows.
  const resolveDate = (v?: string): Date | null => {
    if (!v) return null;
    if (v === 'today') {
      const d = new Date(); d.setHours(0, 0, 0, 0); return d;
    }
    const m = v.match(/^(\d+)d$/);
    if (m) return new Date(Date.now() - parseInt(m[1], 10) * 24 * 60 * 60 * 1000);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };
  const dateFrom = resolveDate(dateFromRaw);
  const dateTo = resolveDate(dateToRaw);
  if (dateFrom) q.andWhere('o.created_at', '>=', dateFrom);
  if (dateTo) q.andWhere('o.created_at', '<=', dateTo);

  // Search — only fires at >= 2 chars to avoid a full-table scan on a
  // single keystroke. Phone is matched against a digits-stripped
  // expression so "+27 79 851 2489" finds rows stored as "0798512489".
  const search = (searchRaw || '').trim();
  if (search.length >= 2) {
    const pat = `%${search.replace(/[%_]/g, '\\$&')}%`;
    const digits = search.replace(/\D/g, '');
    q.andWhere(function () {
      this.where('o.order_number', 'ilike', pat)
        .orWhere('o.customer_name', 'ilike', pat)
        .orWhere('o.waybill', 'ilike', pat)
        .orWhere('o.terminal_id', 'ilike', pat)
        .orWhere('o.raw_shipping_address', 'ilike', pat)
        .orWhere('ie.subject', 'ilike', pat)
        .orWhere('ie.sender', 'ilike', pat);
      if (digits.length >= 4) {
        this.orWhereRaw(
          `regexp_replace(coalesce(o.customer_phone,''), '\\D', '', 'g') ILIKE ?`,
          [`%${digits}%`],
        );
      }
    });
  }

  // ---- Total + Counts -----------------------------------------------
  //
  // total: total rows after filters (drives pagination).
  // counts: per-bucket counts BEFORE the per-bucket filter is applied,
  //         so chips show the full distribution. We compute counts via
  //         a single broader query (filters minus the column we are
  //         counting) — an acceptable extra DB call given chip UX.

  const totalRow = await q.clone().count<{ count: string }[]>('o.id as count').first();
  const total = parseInt(totalRow?.count || '0', 10);

  // Cheap aggregate: just count by status / packing_status / shopify
  // on the filtered set. We deliberately do NOT remove individual
  // filters here; the chips reflect the *current* slice. If you want
  // global counts, drop the filters in a separate query — the UI
  // doesn't need that today.
  const buckets = async (column: string) =>
    q.clone().select(column).count<{ count: string }[]>('o.id as count').groupBy(column);
  const [byStatus, byPacking, byRouting, byShopify] = await Promise.all([
    buckets('o.status'),
    buckets('o.packing_status'),
    buckets('o.routing_status'),
    buckets('o.shopify_fulfilled'),
  ]);
  const distFromRows = (rows: any[], key: string): Record<string, number> => {
    const out: Record<string, number> = {};
    rows.forEach((r) => { out[String(r[key])] = parseInt(r.count, 10); });
    return out;
  };
  const counts = {
    by_status: distFromRows(byStatus as any[], 'status'),
    by_packing_status: distFromRows(byPacking as any[], 'packing_status'),
    by_routing_status: distFromRows(byRouting as any[], 'routing_status'),
    by_shopify: distFromRows(byShopify as any[], 'shopify_fulfilled'),
    total,
  };

  // ---- Sort ---------------------------------------------------------
  switch (sortRaw) {
    case 'oldest':
      q.orderBy('o.created_at', 'asc');
      break;
    case 'status_priority':
      // failed/review > in transit > delivered. Implemented via a CASE
      // for stable ordering across renders, then by created_at desc.
      q.orderByRaw(`
        CASE
          WHEN pj.status = 'failed' THEN 0
          WHEN pj.status = 'pending_review' THEN 1
          WHEN o.routing_status = 'manual_upload' THEN 1
          WHEN o.status IN ('in_transit','at_locker','out_for_delivery','collected','submitted') THEN 2
          WHEN o.status = 'delivered' THEN 3
          ELSE 4
        END ASC,
        o.created_at DESC
      `);
      break;
    default:
      q.orderBy('o.created_at', 'desc');
  }

  // ---- Select & paginate --------------------------------------------
  const rows = await q
    .clone()
    .limit(limit)
    .offset(offset)
    .select(
      // Order
      'o.id', 'o.order_number', 'o.customer_name', 'o.customer_phone',
      'o.delivery_method', 'o.status as order_status',
      'o.routing_status', 'o.manual_upload_reason',
      'o.packing_status', 'o.packed_at', 'o.dropped_off_at',
      'o.waybill', 'o.pincode', 'o.terminal_id', 'o.nearest_locker_name',
      'o.raw_shipping_address', 'o.distance_km',
      'o.shopify_fulfilled', 'o.shopify_fulfilled_at',
      'o.shopify_order_id', 'o.shopify_fulfillment_status',
      'o.created_at as order_created_at', 'o.updated_at as order_updated_at',
      'o.email_id', 'o.pipeline_job_id', 'o.customer_id',
      // Email
      'ie.subject as email_subject',
      'ie.sender as email_sender',
      'ie.email_date as email_date',
      'ie.fetched_at as email_fetched_at',
      'ie.processing_at as email_processing_at',
      'ie.processed_at as email_processed_at',
      'ie.failed_at as email_failed_at',
      'ie.status as email_raw_status',
      'ie.last_error as email_last_error',
      // Pipeline
      'pj.status as pipeline_status',
      'pj.current_stage as pipeline_current_stage',
      'pj.last_error as pipeline_last_error',
      'pj.caretaker_verdict as pipeline_caretaker_verdict',
      'pj.created_at as pipeline_created_at',
      // Fulfillment
      'fj.id as fulfillment_job_id',
      'fj.milestone as fulfillment_milestone',
      'fj.status as fulfillment_status',
      'fj.courier_status as fulfillment_courier_status',
      'fj.last_polled_at as fulfillment_last_polled_at',
      'fj.poll_count as fulfillment_poll_count',
      // Caretaker (latest)
      'ce.id as latest_evaluation_id',
      'ce.verdict as latest_evaluation_verdict',
      'ce.resolution as latest_evaluation_resolution',
      'ce.resolved_by as latest_evaluation_resolved_by',
      'ce.resolved_at as latest_evaluation_resolved_at',
      'ce.summary as latest_evaluation_summary',
      'ce.ce_created_at as latest_evaluation_created_at',
      // Reconciliation (latest)
      'recon.decision as recon_decision',
      'recon.confidence as recon_confidence',
      'recon.ai_used as recon_ai_used',
      'recon.missing_after as recon_missing_after',
    );

  // Derive an `email_status` per row so the UI doesn't have to
  // duplicate the four-state logic in the route filter above.
  const enriched = rows.map((r: any) => {
    let email_status: 'failed' | 'processed' | 'processing' | 'fetched' | null = null;
    if (r.email_id || r.email_subject || r.email_raw_status) {
      if (r.email_raw_status === 'failed' || r.email_last_error) email_status = 'failed';
      else if (r.email_processed_at) email_status = 'processed';
      else if (r.email_processing_at) email_status = 'processing';
      else email_status = 'fetched';
    }
    return { ...r, email_status };
  });

  return res.status(200).json({
    success: true,
    data: { rows: enriched, total, counts },
  });
});

/**
 * GET /orders/:id
 *
 * Full detail for one order: everything in the list view plus the
 * pipeline timeline (every stage_result), every caretaker_evaluation
 * row, fulfillment events, and recent whatsapp_messages tied to this
 * order. Used by the side-drawer detail view.
 */
router.get('/:id', requirePermission('orders.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const id = req.params.id;

  const order = await db('orders').where({ id, tenant_id: tenantId }).first();
  if (!order) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
  }

  // Email
  const email = order.email_id
    ? await db('ingested_emails').where({ id: order.email_id }).first()
    : null;

  // Pipeline + stages
  const pipelineJob = order.pipeline_job_id
    ? await db('pipeline_jobs').where({ id: order.pipeline_job_id, tenant_id: tenantId }).first()
    : null;
  const pipelineStages = pipelineJob
    ? await db('pipeline_stage_results')
        .where({ pipeline_job_id: pipelineJob.id })
        .orderBy('created_at', 'asc')
        .select('id', 'stage', 'status', 'output_data', 'error_message', 'created_at')
    : [];

  // Caretaker evaluations (full history for this pipeline job)
  const caretakerEvaluations = pipelineJob
    ? await db('caretaker_evaluations')
        .where({ pipeline_job_id: pipelineJob.id, tenant_id: tenantId })
        .orderBy('created_at', 'desc')
    : [];

  // Reconciliation history
  const reconciliations = pipelineJob
    ? await db('ai_address_reconciliations')
        .where({ pipeline_job_id: pipelineJob.id, tenant_id: tenantId })
        .orderBy('created_at', 'desc')
    : [];

  // Fulfillment job + events
  const fulfillmentJob = await db('fulfillment_jobs').where({ order_id: id, tenant_id: tenantId }).first();
  const fulfillmentEvents = fulfillmentJob
    ? await db('fulfillment_events')
        .where({ fulfillment_job_id: fulfillmentJob.id })
        .orderBy('event_date', 'desc')
    : [];

  // WhatsApp messages tied to this order
  const whatsappMessages = await db('whatsapp_messages')
    .where({ tenant_id: tenantId, order_id: id, direction: 'outbound' })
    .orderBy('created_at', 'asc')
    .select('id', 'purpose', 'phone_to', 'status', 'wa_message_id', 'body', 'last_error', 'created_at', 'updated_at');

  return res.status(200).json({
    success: true,
    data: {
      order,
      email,
      pipeline_job: pipelineJob,
      pipeline_stages: pipelineStages,
      caretaker_evaluations: caretakerEvaluations,
      reconciliations,
      fulfillment_job: fulfillmentJob || null,
      fulfillment_events: fulfillmentEvents,
      whatsapp_messages: whatsappMessages,
    },
  });
});

log.info('ordersRoutes loaded');

export default router;

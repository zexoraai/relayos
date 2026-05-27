import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { ensureFulfillmentJob, processFulfillmentJob } from '../fulfillment';
import { cancelPudoShipment } from '../fulfillment/pudoCancel';
import { cancelShopifyOrder } from '../fulfillment/shopifyCancel';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'fulfillment-api' });
const router = Router();

router.use(authMiddleware);

// GET /fulfillment/jobs - List fulfillment jobs for the tenant
router.get('/jobs', requirePermission('fulfillment.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

  const jobs = await db('fulfillment_jobs as fj')
    .leftJoin('orders as o', 'o.id', 'fj.order_id')
    .where('fj.tenant_id', tenantId)
    .orderBy('fj.created_at', 'desc')
    .limit(limit)
    .select(
      'fj.id', 'fj.waybill', 'fj.current_stage', 'fj.status', 'fj.courier_status',
      'fj.milestone', 'fj.poll_count', 'fj.last_polled_at', 'fj.next_poll_at',
      'fj.created_at', 'fj.updated_at',
      'o.order_number', 'o.customer_name', 'o.delivery_method', 'o.pincode',
      'o.shopify_fulfilled', 'o.shopify_fulfilled_at', 'o.shopify_fulfillment_status'
    );

  return res.status(200).json({ success: true, data: { jobs } });
});

// GET /fulfillment/jobs/:id - Get fulfillment job detail with stage results and events
router.get('/jobs/:id', requirePermission('fulfillment.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const jobId = req.params.id as string;

  const job = await db('fulfillment_jobs as fj')
    .leftJoin('orders as o', 'o.id', 'fj.order_id')
    .where('fj.id', jobId)
    .where('fj.tenant_id', tenantId)
    .first(
      'fj.*',
      'o.order_number', 'o.customer_name', 'o.customer_phone',
      'o.delivery_method', 'o.pincode', 'o.terminal_id', 'o.nearest_locker_name',
      'o.shopify_fulfilled', 'o.shopify_fulfilled_at', 'o.shopify_order_id', 'o.shopify_fulfillment_id',
      'o.shopify_fulfillment_status'
    );

  if (!job) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Fulfillment job not found' } });
  }

  const stages = await db('fulfillment_stage_results')
    .where({ fulfillment_job_id: jobId })
    .orderBy('created_at', 'asc');

  const events = await db('fulfillment_events')
    .where({ fulfillment_job_id: jobId })
    .orderBy('event_date', 'desc');

  return res.status(200).json({ success: true, data: { job, stages, events } });
});

// GET /fulfillment/jobs/:id/notifications
//
// Returns the whatsapp_messages log for the order behind this fulfillment job
// so the operator can see, on the Fulfillment detail panel, whether each
// milestone notification (order_in_transit, order_at_locker, order_delivered,
// etc.) actually went out, the rendered body, the Meta wa_message_id, the
// status (queued | sent | delivered | read | failed) and any last_error.
//
// Scoped to the tenant of the requester. Joins through the order_id stored
// on the fulfillment_job. Only outbound messages are returned (we don't
// surface inbound chatbot replies on this view).
router.get('/jobs/:id/notifications', requirePermission('fulfillment.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const jobId = req.params.id as string;

  const job = await db('fulfillment_jobs').where({ id: jobId, tenant_id: tenantId }).first('id', 'order_id');
  if (!job) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Fulfillment job not found' } });
  }
  if (!job.order_id) {
    return res.status(200).json({ success: true, data: { notifications: [] } });
  }

  const notifications = await db('whatsapp_messages')
    .where({ tenant_id: tenantId, order_id: job.order_id, direction: 'outbound' })
    .orderBy('created_at', 'asc')
    .select('id', 'purpose', 'phone_to', 'status', 'wa_message_id', 'body', 'last_error', 'created_at', 'updated_at');

  return res.status(200).json({ success: true, data: { notifications } });
});

// GET /fulfillment/stats
router.get('/stats', requirePermission('fulfillment.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const stats = await db('fulfillment_jobs')
    .where({ tenant_id: tenantId })
    .select('status')
    .count('id as count')
    .groupBy('status');

  const byMilestone = await db('fulfillment_jobs')
    .where({ tenant_id: tenantId })
    .whereNotNull('milestone')
    .select('milestone')
    .count('id as count')
    .groupBy('milestone');

  const statusMap: Record<string, number> = {};
  stats.forEach((s: any) => { statusMap[s.status] = parseInt(s.count); });

  const milestoneMap: Record<string, number> = {};
  byMilestone.forEach((m: any) => { milestoneMap[m.milestone] = parseInt(m.count); });

  return res.status(200).json({
    success: true,
    data: {
      total: Object.values(statusMap).reduce((a, b) => a + b, 0),
      by_status: statusMap,
      by_milestone: milestoneMap,
    },
  });
});

// POST /fulfillment/poll/:id - Manually trigger a poll
router.post('/poll/:id', requirePermission('fulfillment.poll'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const jobId = req.params.id as string;

  const job = await db('fulfillment_jobs').where({ id: jobId, tenant_id: tenantId }).first();
  if (!job) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Fulfillment job not found' } });
  }

  // Run async, don't await
  processFulfillmentJob(jobId).catch(err => log.error({ err }, 'Manual poll failed'));

  return res.status(200).json({ success: true, data: { message: 'Poll triggered' } });
});

/**
 * POST /fulfillment/jobs/:id/cancel
 *
 * Body: {
 *   scope?: 'pudo' | 'shopify' | 'both'   // default 'both'
 *   reason?: string                        // free-text shown to PUDO + saved to event
 *   shopify_reason?: 'customer'|'inventory'|'fraud'|'declined'|'other'
 *   refund?: boolean                       // Shopify only — issue refund as part of cancel
 *   restock?: boolean                      // Shopify only — restore inventory
 *   notify_customer?: boolean              // Shopify only — email the customer
 * }
 *
 * Behavior by scope:
 *  - 'pudo'   : cancel the PUDO shipment only. Local order moves to 'cancelled'
 *               (delivery is gone, so the local state should reflect that), but
 *               nothing is touched on Shopify.
 *  - 'shopify': cancel on Shopify only. The PUDO shipment continues — useful
 *               when Shopify changed but you still want delivery to happen.
 *               Local order stays as-is.
 *  - 'both'   : cancel on both (default). Both side-effects applied.
 *
 * The two API calls are independent: a partial failure (e.g. Shopify cancel
 * fails but PUDO succeeds) is reported with per-side status so you know
 * exactly what was rolled back where.
 */
router.post('/jobs/:id/cancel', requirePermission('fulfillment.cancel'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const jobId = req.params.id as string;
  const scope: 'pudo' | 'shopify' | 'both' = (req.body?.scope || 'both').toLowerCase();
  if (!['pudo', 'shopify', 'both'].includes(scope)) {
    return res.status(400).json({ success: false, error: { code: 'BAD_SCOPE', message: 'scope must be pudo | shopify | both' } });
  }
  const reason = (req.body?.reason || '').toString().trim() || 'Cancelled via dashboard';
  const shopifyReason = (req.body?.shopify_reason || 'customer') as 'customer' | 'inventory' | 'fraud' | 'declined' | 'other';
  const refund = !!req.body?.refund;
  const restock = req.body?.restock !== false; // default true
  const notifyCustomer = req.body?.notify_customer !== false; // default true

  const job = await db('fulfillment_jobs').where({ id: jobId, tenant_id: tenantId }).first();
  if (!job) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Fulfillment job not found' } });
  }
  const order = await db('orders').where({ id: job.order_id, tenant_id: tenantId }).first();
  if (!order) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found for this job' } });
  }

  const result: {
    pudo?: { ok: boolean; status?: number; body?: any; error?: string; skipped_reason?: string };
    shopify?: { ok: boolean; status?: number; body?: any; error?: string; skipped_reason?: string; already_cancelled?: boolean };
  } = {};

  // --- PUDO leg ---------------------------------------------------------------
  if (scope === 'pudo' || scope === 'both') {
    if (job.status === 'cancelled') {
      result.pudo = { ok: true, skipped_reason: 'already cancelled locally' };
    } else {
      // Find the shipment_id. The most reliable place is the latest TRACKING_FETCHED
      // stage result; fall back to courier_response from submit time.
      let shipmentId: number | null = null;
      const tracking = await db('fulfillment_stage_results')
        .where({ fulfillment_job_id: jobId, stage: 'TRACKING_FETCHED' })
        .whereNotNull('output_data')
        .orderBy('created_at', 'desc')
        .first();
      if (tracking?.output_data) {
        const out = typeof tracking.output_data === 'string' ? JSON.parse(tracking.output_data) : tracking.output_data;
        if (out?.shipment_id) shipmentId = Number(out.shipment_id);
      }
      if (!shipmentId && order.courier_response) {
        const cr = typeof order.courier_response === 'string' ? JSON.parse(order.courier_response) : order.courier_response;
        if (cr?.shipment_id) shipmentId = Number(cr.shipment_id);
        if (!shipmentId && cr?.id) shipmentId = Number(cr.id);
      }
      if (!shipmentId) {
        result.pudo = {
          ok: false,
          error: 'Could not locate PUDO shipment_id (shipment not submitted or tracking not polled yet)',
        };
      } else {
        try {
          const r = await cancelPudoShipment({
            tenantId,
            shipmentId,
            serviceLevelCode: order.service_level_code,
            reason,
          });
          result.pudo = { ok: r.ok, status: r.status, body: r.body };
          if (!r.ok) result.pudo.error = `PUDO returned ${r.status}`;
        } catch (err: any) {
          log.error({ err: err.message, jobId, shipmentId }, 'PUDO cancel threw');
          result.pudo = { ok: false, error: err.message };
        }
      }
    }
  } else {
    result.pudo = { ok: true, skipped_reason: 'scope=' + scope };
  }

  // --- Shopify leg ------------------------------------------------------------
  if (scope === 'shopify' || scope === 'both') {
    try {
      const r = await cancelShopifyOrder({
        tenantId,
        shopifyOrderId: order.shopify_order_id || null,
        orderNumber: order.order_number,
        reason: shopifyReason,
        refund,
        restock,
        email: notifyCustomer,
        staffNote: reason,
      });
      result.shopify = {
        ok: r.ok,
        status: r.status,
        body: r.body,
        already_cancelled: r.alreadyCancelled,
      };
      if (!r.ok) result.shopify.error = `Shopify returned ${r.status}`;
    } catch (err: any) {
      log.error({ err: err.message, jobId, orderNumber: order.order_number }, 'Shopify cancel threw');
      result.shopify = { ok: false, error: err.message };
    }
  } else {
    result.shopify = { ok: true, skipped_reason: 'scope=' + scope };
  }

  // --- Local persistence ------------------------------------------------------
  // Update local state to reflect what actually happened.
  // - PUDO cancel succeeded → fulfillment job + order go to 'cancelled' (no delivery happening)
  // - Shopify cancel only → leave fulfillment alone but record the event
  const pudoCancelled = (scope === 'pudo' || scope === 'both') && result.pudo?.ok && !result.pudo?.skipped_reason;

  await db.transaction(async (trx) => {
    if (pudoCancelled) {
      await trx('orders').where({ id: order.id }).update({
        status: 'cancelled',
        packing_status: 'cancelled',
        updated_at: new Date(),
      });
      await trx('fulfillment_jobs').where({ id: jobId }).update({
        status: 'cancelled',
        next_poll_at: null,
        updated_at: new Date(),
      });
    } else if (result.shopify?.ok && (scope === 'shopify' || scope === 'both')) {
      // Shopify-only cancel: don't touch fulfillment_jobs (delivery still in flight),
      // but mark the order so dashboard listings reflect it.
      await trx('orders').where({ id: order.id }).update({
        shopify_fulfillment_status: 'cancelled',
        updated_at: new Date(),
      });
    }

    // Always log a fulfillment_event so the timeline shows the action even on partial failure.
    const message = `cancel ${scope}: pudo=${result.pudo?.ok ? 'ok' : 'fail'} shopify=${result.shopify?.ok ? 'ok' : 'fail'} — ${reason}`;
    await trx('fulfillment_events').insert({
      fulfillment_job_id: jobId,
      order_id: order.id,
      status: pudoCancelled ? 'cancelled' : 'cancel_attempt',
      message,
      source: 'dashboard',
      event_date: new Date(),
    });
  });

  const overallOk = result.pudo?.ok !== false && result.shopify?.ok !== false;

  log.info(
    {
      tenantId,
      jobId,
      orderNumber: order.order_number,
      scope,
      pudoOk: result.pudo?.ok,
      shopifyOk: result.shopify?.ok,
      by: req.tenant?.email,
      reason,
    },
    'Cancel request processed',
  );

  return res.status(overallOk ? 200 : 207).json({
    success: overallOk,
    data: {
      scope,
      reason,
      pudo: result.pudo,
      shopify: result.shopify,
      message: overallOk
        ? 'Cancel completed'
        : 'Cancel partially failed — see pudo / shopify fields for details',
    },
  });
});

export default router;

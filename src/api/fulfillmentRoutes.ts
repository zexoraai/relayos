import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware } from './middleware';
import { getDb } from '../db/connection';
import { ensureFulfillmentJob, processFulfillmentJob } from '../fulfillment';
import { cancelPudoShipment } from '../fulfillment/pudoCancel';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'fulfillment-api' });
const router = Router();

router.use(authMiddleware);

// GET /fulfillment/jobs - List fulfillment jobs for the tenant
router.get('/jobs', async (req: AuthenticatedRequest, res: Response) => {
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
router.get('/jobs/:id', async (req: AuthenticatedRequest, res: Response) => {
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

// GET /fulfillment/stats
router.get('/stats', async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/poll/:id', async (req: AuthenticatedRequest, res: Response) => {
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
 * Cancels the PUDO shipment for a fulfillment job.
 * Body: { reason?: string }   (defaults to "Cancelled via dashboard")
 *
 * Side effects on success:
 *  - Marks the local order.status = 'cancelled' and order.packing_status = 'cancelled'
 *  - Marks the fulfillment_job.status = 'cancelled' and stops further polling
 *  - Records a fulfillment_event for the cancellation
 */
router.post('/jobs/:id/cancel', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const jobId = req.params.id as string;
  const reason = (req.body?.reason || '').toString().trim() || 'Cancelled via dashboard';

  const job = await db('fulfillment_jobs').where({ id: jobId, tenant_id: tenantId }).first();
  if (!job) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Fulfillment job not found' } });
  }
  if (job.status === 'cancelled') {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_CANCELLED', message: 'This shipment is already cancelled' } });
  }

  const order = await db('orders').where({ id: job.order_id, tenant_id: tenantId }).first();
  if (!order) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found for this job' } });
  }

  // Find the shipment_id. The most reliable place is the latest TRACKING_FETCHED stage result;
  // fall back to courier_response from submit time.
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
    return res.status(400).json({
      success: false,
      error: {
        code: 'NO_SHIPMENT_ID',
        message: 'Could not locate PUDO shipment_id for this order. The shipment may not have been submitted yet, or tracking has not been polled.',
      },
    });
  }

  let result;
  try {
    result = await cancelPudoShipment({
      tenantId,
      shipmentId,
      serviceLevelCode: order.service_level_code,
      reason,
    });
  } catch (err: any) {
    log.error({ err: err.message, jobId, shipmentId }, 'PUDO cancel call threw');
    return res.status(502).json({ success: false, error: { code: 'PUDO_CALL_FAILED', message: err.message } });
  }

  if (!result.ok) {
    return res.status(502).json({
      success: false,
      error: { code: 'PUDO_REJECTED', message: `PUDO returned ${result.status}`, details: result.body },
    });
  }

  // Persist cancellation locally — wrap so partial failures still report something useful.
  await db.transaction(async (trx) => {
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
    await trx('fulfillment_events').insert({
      fulfillment_job_id: jobId,
      order_id: order.id,
      status: 'cancelled',
      message: reason,
      source: 'dashboard',
      event_date: new Date(),
    });
  });

  log.info({ tenantId, jobId, shipmentId, orderNumber: order.order_number, by: req.tenant?.email, reason }, 'Shipment cancelled');

  return res.status(200).json({
    success: true,
    data: {
      message: 'Shipment cancelled',
      shipment_id: shipmentId,
      pudo_response: result.body,
    },
  });
});

export default router;

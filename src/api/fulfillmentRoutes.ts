import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware } from './middleware';
import { getDb } from '../db/connection';
import { ensureFulfillmentJob, processFulfillmentJob } from '../fulfillment';
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

export default router;

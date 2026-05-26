import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { enqueuePipelineJob } from '../pipeline/worker';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'pipeline-api' });
const router = Router();

router.use(authMiddleware);

// GET /pipeline/jobs - List pipeline jobs for the tenant
router.get('/jobs', requirePermission('pipeline.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  const jobs = await db('pipeline_jobs')
    .where({ tenant_id: tenantId })
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .select('id', 'email_id', 'current_stage', 'status', 'correlation_id', 'last_error', 'retry_count', 'created_at', 'updated_at', 'caretaker_verdict');

  const total = await db('pipeline_jobs').where({ tenant_id: tenantId }).count('id as count').first();

  return res.status(200).json({
    success: true,
    data: { jobs, total: parseInt(total?.count as string || '0'), limit, offset },
  });
});

// GET /pipeline/jobs/:id - Get pipeline job details with stage results
router.get('/jobs/:id', requirePermission('pipeline.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const jobId = req.params.id;

  const job = await db('pipeline_jobs').where({ id: jobId, tenant_id: tenantId }).first();
  if (!job) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Pipeline job not found' } });
  }

  const stages = await db('pipeline_stage_results')
    .where({ pipeline_job_id: jobId })
    .orderBy('created_at', 'asc')
    .select('id', 'stage', 'status', 'output_data', 'error_message', 'created_at');

  // Include the resulting order if one was created from this pipeline
  const order = await db('orders').where({ pipeline_job_id: jobId }).first();

  // Customer history block — useful for trust calls when reviewing a job.
  // Resolves the customer in two steps: first by orders.customer_id (the
  // canonical FK once courierSubmitted runs upsertCustomer), then falls back
  // to a phone lookup against customers.phone_normalized for early-stage
  // jobs that haven't been linked yet.
  let customerHistory: any = null;
  if (order) {
    let customer: any = null;
    if (order.customer_id) {
      customer = await db('customers')
        .where({ id: order.customer_id, tenant_id: tenantId })
        .first();
    }
    if (!customer && order.customer_phone) {
      // Phone-normalize the way customers.upsertCustomer does — strip non-digits.
      const phoneNormalized = String(order.customer_phone).replace(/\D/g, '');
      if (phoneNormalized) {
        customer = await db('customers')
          .where({ tenant_id: tenantId, phone_normalized: phoneNormalized })
          .first();
      }
    }

    if (customer) {
      const recentOrders = await db('orders')
        .where({ customer_id: customer.id, tenant_id: tenantId })
        .whereNot({ id: order.id })
        .orderBy('created_at', 'desc')
        .limit(5)
        .select(
          'id', 'order_number', 'status', 'courier_status',
          'shopify_fulfillment_status', 'waybill', 'delivery_method', 'created_at',
        );

      // Aggregate counts so the UI can show a quick success-rate strip.
      const aggregateRows = await db('orders')
        .where({ customer_id: customer.id, tenant_id: tenantId })
        .select('status')
        .count<{ status: string; count: string }[]>('id as count')
        .groupBy('status');
      const totals: Record<string, number> = {};
      aggregateRows.forEach((r: any) => { totals[r.status] = parseInt(r.count, 10) || 0; });
      const total = Object.values(totals).reduce((a, b) => a + b, 0);

      customerHistory = {
        customer: {
          id: customer.id,
          name: customer.name,
          phone: customer.phone_normalized,
          email: customer.email,
          order_count: customer.order_count,
          first_order_at: customer.first_order_at,
          last_order_at: customer.last_order_at,
        },
        totals: {
          all: total,
          by_status: totals,
        },
        recent_orders: recentOrders,
      };
    }
  }

  return res.status(200).json({
    success: true,
    data: { job, stages, order: order || null, customer_history: customerHistory },
  });
});

// GET /pipeline/stats - Pipeline statistics for the tenant
router.get('/stats', requirePermission('pipeline.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  const stats = await db('pipeline_jobs')
    .where({ tenant_id: tenantId })
    .select('status')
    .count('id as count')
    .groupBy('status');

  const byStage = await db('pipeline_jobs')
    .where({ tenant_id: tenantId })
    .select('current_stage')
    .count('id as count')
    .groupBy('current_stage');

  const statusMap: Record<string, number> = {};
  stats.forEach((s: any) => { statusMap[s.status] = parseInt(s.count); });

  const stageMap: Record<string, number> = {};
  byStage.forEach((s: any) => { stageMap[s.current_stage] = parseInt(s.count); });

  return res.status(200).json({
    success: true,
    data: {
      total: Object.values(statusMap).reduce((a, b) => a + b, 0),
      by_status: statusMap,
      by_stage: stageMap,
    },
  });
});

// POST /pipeline/trigger/:emailId - Manually trigger pipeline for an email
router.post('/trigger/:emailId', requirePermission('pipeline.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const emailId = req.params.emailId as string;

  // Verify email belongs to tenant's mailbox
  const email = await db('ingested_emails').where({ id: emailId }).first();
  if (!email) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Email not found' } });
  }

  // Check if pipeline job already exists
  const existing = await db('pipeline_jobs').where({ email_id: emailId, tenant_id: tenantId }).first();
  if (existing) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_EXISTS', message: 'Pipeline job already exists for this email', job_id: existing.id } });
  }

  const correlationId = email.correlation_id || emailId;

  await enqueuePipelineJob({
    emailId,
    tenantId,
    mailboxId: email.mailbox_id,
    correlationId,
  });

  log.info({ tenantId, emailId }, 'Pipeline manually triggered');

  return res.status(201).json({ success: true, data: { message: 'Pipeline job enqueued', email_id: emailId } });
});

/**
 * POST /pipeline/jobs/:id/reprocess
 *
 * Force-reprocess a pipeline job that already finished. Useful when something
 * downstream changed (e.g. Shopify API token re-saved with a working key) and
 * you want to re-run an existing order through the pipeline so it picks up
 * the new state.
 *
 * Behaviour:
 *  - Deletes the existing pipeline_job + stage_results
 *  - Deletes the resulting order if one was created (so re-run can recreate it cleanly)
 *  - Re-enqueues the BullMQ job referencing the same email
 */
router.post('/jobs/:id/reprocess', requirePermission('pipeline.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const jobId = req.params.id;

  const job = await db('pipeline_jobs').where({ id: jobId, tenant_id: tenantId }).first();
  if (!job) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Pipeline job not found' } });
  }

  const emailId = job.email_id;
  const mailboxId = job.mailbox_id;
  const correlationId = job.correlation_id || emailId;

  await db.transaction(async (trx) => {
    // Drop any order created from this pipeline run so a fresh run can recreate it
    await trx('orders').where({ pipeline_job_id: jobId, tenant_id: tenantId }).delete();
    await trx('pipeline_stage_results').where({ pipeline_job_id: jobId }).delete();
    await trx('pipeline_jobs').where({ id: jobId, tenant_id: tenantId }).delete();
  });

  await enqueuePipelineJob(
    {
      emailId,
      tenantId,
      mailboxId,
      correlationId,
    },
    // Unique job id so BullMQ doesn't dedupe against the prior `pipeline-<emailId>` id
    `pipeline-${emailId}-reprocess-${Date.now()}`,
  );

  log.info({ tenantId, oldJobId: jobId, emailId }, 'Pipeline job reprocess requested — old artifacts deleted, fresh job enqueued');

  return res.status(200).json({
    success: true,
    data: {
      message: 'Pipeline reprocess enqueued',
      old_job_id: jobId,
      email_id: emailId,
    },
  });
});

export default router;

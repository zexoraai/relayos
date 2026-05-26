import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { validateBody } from './validate';
import { caretakerRulesBodySchema } from '../schemas/settings';
import { getDb } from '../db/connection';
import { resolveReview } from '../caretaker';
import { processPipelineJob } from '../pipeline';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'caretaker-api' });
const router = Router();

router.use(authMiddleware);

/**
 * GET /caretaker/rules
 */
router.get('/rules', requirePermission('caretaker.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;

  let row = await db('caretaker_rules').where({ tenant_id: tenantId }).first();
  if (!row) {
    return res.status(200).json({
      success: true,
      data: { configured: false, defaults_will_be_used: true },
    });
  }
  return res.status(200).json({ success: true, data: row });
});

/**
 * POST /caretaker/rules - upsert per-tenant rule config.
 */
router.post('/rules', requirePermission('caretaker.rules.manage'), validateBody(caretakerRulesBodySchema), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const data: any = { tenant_id: tenantId, ...req.body };

  const existing = await db('caretaker_rules').where({ tenant_id: tenantId }).first();
  if (existing) {
    await db('caretaker_rules').where({ id: existing.id }).update({ ...data, updated_at: new Date() });
  } else {
    await db('caretaker_rules').insert(data);
  }

  log.info({ tenantId }, 'Caretaker rules updated');
  return res.status(200).json({ success: true, data: { message: 'Caretaker rules saved' } });
});

/**
 * GET /caretaker/evaluations - list pending reviews + recent decisions.
 */
router.get('/evaluations', requirePermission('caretaker.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { verdict, limit = '50' } = req.query;

  let q = db('caretaker_evaluations as ce')
    .leftJoin('pipeline_jobs as pj', 'pj.id', 'ce.pipeline_job_id')
    .leftJoin('orders as o', 'o.pipeline_job_id', 'pj.id')
    .where('ce.tenant_id', tenantId)
    .select(
      'ce.id', 'ce.verdict', 'ce.mode', 'ce.flags', 'ce.checks',
      'ce.summary', 'ce.resolution', 'ce.resolved_by', 'ce.resolved_at', 'ce.created_at',
      'ce.pipeline_job_id',
      'pj.status as pipeline_status',
      'pj.current_stage',
      'pj.email_id',
      'pj.caretaker_verdict as pipeline_caretaker_verdict',
      'pj.last_error as pipeline_last_error',
      'o.order_number as order_number',
      'o.customer_name as customer_name',
      'o.waybill as order_waybill',
      'o.status as order_status',
    )
    .orderBy('ce.created_at', 'desc')
    .limit(parseInt(limit as string, 10));

  if (verdict) q = q.where('ce.verdict', verdict as string);

  const rows = await q;
  return res.status(200).json({ success: true, data: rows });
});

/**
 * GET /caretaker/evaluations/:id
 *
 * Returns the evaluation, the current snapshot of pipeline-extracted data
 * (so the dashboard can pre-fill the edit form), and any prior reviewer
 * overrides. Used by the override-and-approve UI.
 */
router.get('/evaluations/:id', requirePermission('caretaker.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };

  const ev = await db('caretaker_evaluations').where({ id, tenant_id: tenantId }).first();
  if (!ev) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Evaluation not found' } });
  }

  // Pull the customer_data + locker stage outputs for this pipeline job so
  // the UI can show what the AI extracted (and what the reviewer is overriding).
  const stages = await db('pipeline_stage_results')
    .where({ pipeline_job_id: ev.pipeline_job_id })
    .orderBy('created_at', 'asc')
    .select('stage', 'status', 'output_data', 'created_at');

  const findStage = (name: string) => stages.find((s: any) => s.stage === name);
  const parse = (v: any) => {
    if (!v) return null;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return null; }
  };

  const customerData = parse(findStage('CUSTOMER_DATA')?.output_data);
  const lockersResolved = parse(findStage('LOCKERS_RESOLVED')?.output_data);
  const dataExtracted = parse(findStage('DATA_EXTRACTED')?.output_data);

  return res.status(200).json({
    success: true,
    data: {
      evaluation: ev,
      snapshot: {
        customer_data: customerData,
        lockers_resolved: lockersResolved,
        data_extracted: dataExtracted,
      },
    },
  });
});

/**
 * POST /caretaker/evaluations/:id/resolve
 * Body:
 *   { resolution: 'approved' | 'rejected',
 *     overrides?: { customer_name?, customer_phone?, delivery_method?, delivery_address?, line_items?, locker? },
 *     notes?: string }
 *
 * On approve, the pipeline is re-enqueued; the next pass merges `overrides`
 * over the AI-extracted data via executeCustomerData.
 */
router.post('/evaluations/:id/resolve', requirePermission('caretaker.review.approve', 'caretaker.review.reject'), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const userEmail = req.tenant!.email || 'unknown';
  const { id } = req.params as { id: string };
  const { resolution, overrides, notes } = req.body || {};

  if (!['approved', 'rejected'].includes(resolution)) {
    return res.status(400).json({
      success: false,
      error: { code: 'BAD_RESOLUTION', message: 'resolution must be approved or rejected' },
    });
  }
  if (overrides !== undefined && (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))) {
    return res.status(400).json({
      success: false,
      error: { code: 'BAD_OVERRIDES', message: 'overrides must be a JSON object' },
    });
  }

  const db = getDb();
  const ev = await db('caretaker_evaluations').where({ id, tenant_id: tenantId }).first();
  if (!ev) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Evaluation not found' } });
  }

  const result = await resolveReview({
    evaluationId: id,
    resolution,
    resolvedBy: userEmail,
    reviewerOverrides: overrides ?? null,
    reviewerNotes: typeof notes === 'string' ? notes : null,
  });

  // If approved, resume pipeline. If rejected, just mark the job rejected.
  if (resolution === 'approved') {
    const job = await db('pipeline_jobs').where({ id: ev.pipeline_job_id }).first();
    if (job) {
      // Re-run from the beginning; the courier-submitted stage is idempotent on order_number,
      // and the caretaker short-circuits because the prior evaluation was approved.
      await db('pipeline_jobs').where({ id: job.id }).update({
        status: 'processing',
        updated_at: new Date(),
      });
      processPipelineJob({
        emailId: job.email_id,
        tenantId: job.tenant_id,
        mailboxId: job.mailbox_id,
        correlationId: job.correlation_id,
      }).catch((err) => log.error({ jobId: job.id, err: err.message }, 'Resume pipeline failed'));
    }
  } else {
    await db('pipeline_jobs').where({ id: ev.pipeline_job_id }).update({
      status: 'rejected',
      last_error: 'Rejected by reviewer',
      updated_at: new Date(),
    });
  }

  return res.status(200).json({ success: true, data: result });
});

/**
 * POST /caretaker/evaluations/:id/reopen
 *
 * Convert a previously-resolved evaluation (typically rejected) back into
 * a pending review so the operator can edit + approve it. Useful when the
 * LLM auto-rejected something the human disagrees with.
 *
 * Sets the evaluation's verdict back to 'review' and clears resolution.
 * Flips the pipeline_job back to pending_review.
 */
router.post('/evaluations/:id/reopen', requirePermission('caretaker.review.approve'), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const userEmail = req.tenant!.email || 'unknown';
  const { id } = req.params as { id: string };

  const db = getDb();
  const ev = await db('caretaker_evaluations').where({ id, tenant_id: tenantId }).first();
  if (!ev) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Evaluation not found' } });
  }

  await db('caretaker_evaluations').where({ id }).update({
    verdict: 'review',
    resolution: null,
    resolved_by: null,
    resolved_at: null,
    summary: ev.summary ? `${ev.summary} (reopened by ${userEmail})` : `Reopened by ${userEmail}`,
  });

  await db('pipeline_jobs').where({ id: ev.pipeline_job_id }).update({
    status: 'pending_review',
    caretaker_verdict: 'review',
    last_error: null,
    updated_at: new Date(),
  });

  log.info({ evaluationId: id, pipelineJobId: ev.pipeline_job_id, by: userEmail }, 'Evaluation reopened for review');
  return res.status(200).json({ success: true, data: { id, verdict: 'review' } });
});

export default router;

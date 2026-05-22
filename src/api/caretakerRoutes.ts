import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware } from './middleware';
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
router.get('/rules', async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/rules', validateBody(caretakerRulesBodySchema), async (req: AuthenticatedRequest, res: Response) => {
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
router.get('/evaluations', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { verdict, limit = '50' } = req.query;

  let q = db('caretaker_evaluations as ce')
    .leftJoin('pipeline_jobs as pj', 'pj.id', 'ce.pipeline_job_id')
    .where('ce.tenant_id', tenantId)
    .select(
      'ce.id', 'ce.verdict', 'ce.mode', 'ce.flags', 'ce.checks',
      'ce.summary', 'ce.resolution', 'ce.resolved_by', 'ce.resolved_at', 'ce.created_at',
      'ce.pipeline_job_id', 'pj.status as pipeline_status', 'pj.current_stage', 'pj.email_id',
    )
    .orderBy('ce.created_at', 'desc')
    .limit(parseInt(limit as string, 10));

  if (verdict) q = q.where('ce.verdict', verdict as string);

  const rows = await q;
  return res.status(200).json({ success: true, data: rows });
});

/**
 * POST /caretaker/evaluations/:id/resolve { resolution: 'approved' | 'rejected' }
 * Marks the review resolved. If approved, resumes the pipeline from where it paused.
 */
router.post('/evaluations/:id/resolve', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const userEmail = req.tenant!.email || 'unknown';
  const { id } = req.params as { id: string };
  const { resolution } = req.body;

  if (!['approved', 'rejected'].includes(resolution)) {
    return res.status(400).json({
      success: false,
      error: { code: 'BAD_RESOLUTION', message: 'resolution must be approved or rejected' },
    });
  }

  const db = getDb();
  const ev = await db('caretaker_evaluations').where({ id, tenant_id: tenantId }).first();
  if (!ev) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Evaluation not found' } });
  }

  const result = await resolveReview({ evaluationId: id, resolution, resolvedBy: userEmail });

  // If approved, resume pipeline. If rejected, just mark the job rejected.
  if (resolution === 'approved') {
    const job = await db('pipeline_jobs').where({ id: ev.pipeline_job_id }).first();
    if (job) {
      // Re-run from the beginning; the courier-submitted stage is idempotent on order_number,
      // and the caretaker will see verdict already set so it allows pass-through. (We mark
      // the job back to processing first.)
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

export default router;

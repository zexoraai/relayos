import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware } from './middleware';
import { getDb } from '../db/connection';
import { enqueuePipelineJob } from '../pipeline/worker';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'pipeline-api' });
const router = Router();

router.use(authMiddleware);

// GET /pipeline/jobs - List pipeline jobs for the tenant
router.get('/jobs', async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  const jobs = await db('pipeline_jobs')
    .where({ tenant_id: tenantId })
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .select('id', 'email_id', 'current_stage', 'status', 'correlation_id', 'last_error', 'retry_count', 'created_at', 'updated_at');

  const total = await db('pipeline_jobs').where({ tenant_id: tenantId }).count('id as count').first();

  return res.status(200).json({
    success: true,
    data: { jobs, total: parseInt(total?.count as string || '0'), limit, offset },
  });
});

// GET /pipeline/jobs/:id - Get pipeline job details with stage results
router.get('/jobs/:id', async (req: AuthenticatedRequest, res: Response) => {
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

  return res.status(200).json({
    success: true,
    data: { job, stages, order: order || null },
  });
});

// GET /pipeline/stats - Pipeline statistics for the tenant
router.get('/stats', async (req: AuthenticatedRequest, res: Response) => {
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
router.post('/trigger/:emailId', async (req: AuthenticatedRequest, res: Response) => {
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

export default router;

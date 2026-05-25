import { Router, Response } from 'express';
import { Queue, Job } from 'bullmq';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getRedisConnection } from '../queue';
import { getDb } from '../db/connection';
import { config } from '../config';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'dlq-api' });
const router = Router();

router.use(authMiddleware);

/**
 * Queues we want to surface in the dashboard. Names must match the queue
 * names registered by their respective workers.
 */
const TRACKED_QUEUES: Array<{ name: string; label: string; description: string }> = [
  { name: config.queue.name, label: 'Email Processing', description: 'Inbound emails from IMAP -> parser' },
  { name: 'order-pipeline', label: 'Order Pipeline', description: 'Email -> order ingestion stages' },
  { name: 'domain-event-dispatch', label: 'Event Dispatch', description: 'Domain event -> subscribers' },
];

const queueCache = new Map<string, Queue>();
function getQueue(name: string): Queue {
  let q = queueCache.get(name);
  if (!q) {
    q = new Queue(name, { connection: getRedisConnection() });
    queueCache.set(name, q);
  }
  return q;
}

interface QueueSummary {
  name: string;
  label: string;
  description: string;
  counts: { active: number; waiting: number; delayed: number; completed: number; failed: number };
  failed_outbox_events?: number;
}

/**
 * GET /dlq/summary - one-row-per-queue snapshot for the dashboard header.
 */
router.get('/summary', requirePermission('dlq.view'), async (req: AuthenticatedRequest, res: Response) => {
  const summaries: QueueSummary[] = [];
  for (const meta of TRACKED_QUEUES) {
    try {
      const q = getQueue(meta.name);
      const counts = await q.getJobCounts('active', 'waiting', 'delayed', 'completed', 'failed');
      summaries.push({
        ...meta,
        counts: {
          active: counts.active || 0,
          waiting: counts.waiting || 0,
          delayed: counts.delayed || 0,
          completed: counts.completed || 0,
          failed: counts.failed || 0,
        },
      });
    } catch (err: any) {
      log.warn({ queue: meta.name, error: err.message }, 'Failed to read queue counts');
      summaries.push({ ...meta, counts: { active: 0, waiting: 0, delayed: 0, completed: 0, failed: 0 } });
    }
  }

  // Outbox-pattern failures live in the DB, not BullMQ
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const outboxFailed = await db('domain_events')
    .where({ tenant_id: tenantId, status: 'failed' })
    .count<{ count: string }[]>('id as count');

  return res.status(200).json({
    success: true,
    data: {
      queues: summaries,
      outbox_failed_events: parseInt(outboxFailed[0]?.count || '0'),
    },
  });
});

/**
 * GET /dlq/:queue/failed - failed jobs for a single queue.
 */
router.get('/:queue/failed', requirePermission('dlq.view'), async (req: AuthenticatedRequest, res: Response) => {
  const queueName = req.params.queue as string;
  if (!TRACKED_QUEUES.some((q) => q.name === queueName)) {
    return res.status(404).json({ success: false, error: { code: 'UNKNOWN_QUEUE', message: 'Unknown queue' } });
  }
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const q = getQueue(queueName);
  const jobs = await q.getJobs(['failed'], 0, limit - 1, false);
  const data = jobs.map(serializeJob);

  return res.status(200).json({ success: true, data });
});

/**
 * POST /dlq/:queue/retry - re-enqueue a failed job by id.
 */
router.post('/:queue/retry', requirePermission('dlq.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const queueName = req.params.queue as string;
  const { job_id } = req.body || {};
  if (!job_id) return res.status(400).json({ success: false, error: { code: 'MISSING_JOB_ID', message: 'job_id required' } });
  if (!TRACKED_QUEUES.some((q) => q.name === queueName)) {
    return res.status(404).json({ success: false, error: { code: 'UNKNOWN_QUEUE', message: 'Unknown queue' } });
  }

  const q = getQueue(queueName);
  const job = await q.getJob(String(job_id));
  if (!job) return res.status(404).json({ success: false, error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });

  await job.retry();
  log.info({ queue: queueName, jobId: job_id, by: req.tenant?.email }, 'DLQ job retried');
  return res.status(200).json({ success: true, data: { message: 'Job re-enqueued' } });
});

/**
 * POST /dlq/:queue/discard - permanently remove a failed job.
 */
router.post('/:queue/discard', requirePermission('dlq.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const queueName = req.params.queue as string;
  const { job_id } = req.body || {};
  if (!job_id) return res.status(400).json({ success: false, error: { code: 'MISSING_JOB_ID', message: 'job_id required' } });
  if (!TRACKED_QUEUES.some((q) => q.name === queueName)) {
    return res.status(404).json({ success: false, error: { code: 'UNKNOWN_QUEUE', message: 'Unknown queue' } });
  }

  const q = getQueue(queueName);
  const job = await q.getJob(String(job_id));
  if (!job) return res.status(404).json({ success: false, error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } });

  await job.remove();
  log.info({ queue: queueName, jobId: job_id, by: req.tenant?.email }, 'DLQ job discarded');
  return res.status(200).json({ success: true, data: { message: 'Job discarded' } });
});

/**
 * GET /dlq/outbox - failed outbox events for the tenant.
 */
router.get('/outbox', requirePermission('dlq.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const events = await db('domain_events')
    .where({ tenant_id: tenantId, status: 'failed' })
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select('id', 'event_type', 'aggregate_type', 'aggregate_id', 'dispatch_attempts', 'last_error', 'created_at');

  return res.status(200).json({ success: true, data: events });
});

/**
 * POST /dlq/outbox/retry - reset a failed outbox event so the relay re-dispatches it.
 */
router.post('/outbox/retry', requirePermission('dlq.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { event_id } = req.body || {};
  if (!event_id) return res.status(400).json({ success: false, error: { code: 'MISSING_ID', message: 'event_id required' } });

  const updated = await db('domain_events')
    .where({ id: event_id, tenant_id: tenantId, status: 'failed' })
    .update({ status: 'pending', dispatch_attempts: 0, last_error: null });
  if (updated === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Failed event not found' } });
  }
  log.info({ eventId: event_id, by: req.tenant?.email }, 'Outbox event reset to pending');
  return res.status(200).json({ success: true, data: { message: 'Event re-queued' } });
});

/**
 * POST /dlq/outbox/discard - mark a failed outbox event as dispatched (don't re-send).
 */
router.post('/outbox/discard', requirePermission('dlq.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { event_id } = req.body || {};
  if (!event_id) return res.status(400).json({ success: false, error: { code: 'MISSING_ID', message: 'event_id required' } });

  const updated = await db('domain_events')
    .where({ id: event_id, tenant_id: tenantId, status: 'failed' })
    .update({ status: 'dispatched', dispatched_at: new Date(), last_error: 'Manually discarded' });
  if (updated === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Failed event not found' } });
  }
  return res.status(200).json({ success: true, data: { message: 'Event discarded' } });
});

function serializeJob(job: Job) {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    failedReason: job.failedReason,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
    finishedOn: job.finishedOn,
    stacktrace: (job.stacktrace || []).slice(-3),
  };
}

export default router;

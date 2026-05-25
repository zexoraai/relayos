import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { clearIdempotencyKey } from '../idempotency';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'idempotency-api' });
const router = Router();

router.use(authMiddleware);

/**
 * GET /idempotency - list cached side-effect calls for the tenant.
 * Filterable by action_type and status.
 */
router.get('/', requirePermission('idempotency.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { action_type, status, limit = '100' } = req.query;

  let q = db('idempotency_keys').where({ tenant_id: tenantId }).orderBy('updated_at', 'desc').limit(parseInt(limit as string, 10));
  if (action_type) q = q.andWhere({ action_type });
  if (status) q = q.andWhere({ status });

  const rows = await q;
  return res.status(200).json({ success: true, data: rows });
});

/**
 * DELETE /idempotency/:key - forget a cached entry.
 * Used when upstream state has been reset and we WANT to allow re-submission.
 */
router.delete('/:key', requirePermission('idempotency.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const { key } = req.params as { key: string };
  const decoded = decodeURIComponent(key);

  // Safety: verify the key belongs to this tenant before clearing.
  const db = getDb();
  const row = await db('idempotency_keys').where({ key: decoded, tenant_id: tenantId }).first();
  if (!row) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Key not found' } });
  }

  await clearIdempotencyKey(decoded);
  log.info({ tenantId, key: decoded }, 'Idempotency key cleared by user');
  return res.status(200).json({ success: true, data: { message: 'Key cleared' } });
});

export default router;

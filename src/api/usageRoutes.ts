import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware } from './middleware';
import { getUsageStats } from '../ai/usageTracker';
import { getDb } from '../db/connection';

const router = Router();
router.use(authMiddleware);

/**
 * GET /usage/summary - aggregate stats for the tenant
 */
router.get('/summary', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const db = getDb();

  // Totals
  const totals = await db('ai_usage_log')
    .where({ tenant_id: tenantId })
    .select(
      db.raw('count(*) as total_calls'),
      db.raw('coalesce(sum(total_tokens), 0) as total_tokens'),
      db.raw('coalesce(sum(cost_usd), 0) as total_cost'),
      db.raw('coalesce(avg(latency_ms), 0) as avg_latency_ms'),
    )
    .first();

  // By agent
  const byAgent = await getUsageStats({ tenantId, groupBy: 'agent' });

  // By day (last 30 days)
  const byDay = await getUsageStats({ tenantId, groupBy: 'day' });

  // Today's stats
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStats = await db('ai_usage_log')
    .where({ tenant_id: tenantId })
    .where('created_at', '>=', today)
    .select(
      db.raw('count(*) as calls'),
      db.raw('coalesce(sum(total_tokens), 0) as tokens'),
      db.raw('coalesce(sum(cost_usd), 0) as cost'),
    )
    .first();

  return res.status(200).json({
    success: true,
    data: {
      totals: {
        calls: parseInt(totals?.total_calls || '0'),
        tokens: parseInt(totals?.total_tokens || '0'),
        cost_usd: parseFloat(totals?.total_cost || '0'),
        avg_latency_ms: Math.round(parseFloat(totals?.avg_latency_ms || '0')),
      },
      today: {
        calls: parseInt(todayStats?.calls || '0'),
        tokens: parseInt(todayStats?.tokens || '0'),
        cost_usd: parseFloat(todayStats?.cost || '0'),
      },
      by_agent: byAgent,
      by_day: byDay,
    },
  });
});

/**
 * GET /usage/recent - last N calls with full detail
 */
router.get('/recent', async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const agent = req.query.agent as string || undefined;

  const db = getDb();
  let q = db('ai_usage_log')
    .where({ tenant_id: tenantId })
    .orderBy('created_at', 'desc')
    .limit(limit);
  if (agent) q = q.andWhere({ agent });

  const rows = await q;
  return res.status(200).json({ success: true, data: rows });
});

export default router;

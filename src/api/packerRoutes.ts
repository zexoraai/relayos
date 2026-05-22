import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'packer-api' });
const router = Router();

router.use(authMiddleware);

/**
 * GET /packer/queue - orders that need packer action.
 * Filterable by status: awaiting_packing | packed | dropped_off | all
 */
router.get('/queue', requirePermission('orders.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const status = (req.query.status as string) || 'awaiting_packing';
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const search = (req.query.search as string || '').trim();

  let q = db('orders')
    .where({ tenant_id: tenantId })
    .whereNotNull('waybill')
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (status !== 'all') q = q.andWhere({ packing_status: status });
  if (search) {
    q = q.andWhere(function() {
      this.where('order_number', 'ilike', `%${search}%`)
        .orWhere('customer_name', 'ilike', `%${search}%`)
        .orWhere('customer_phone', 'ilike', `%${search}%`)
        .orWhere('waybill', 'ilike', `%${search}%`);
    });
  }

  const orders = await q.select(
    'id', 'order_number', 'customer_name', 'customer_phone',
    'delivery_method', 'delivery_address', 'line_items',
    'waybill', 'pincode', 'terminal_id', 'nearest_locker_name',
    'packing_status', 'packed_at', 'dropped_off_at', 'packing_note',
    'created_at',
  );

  // Counts per status (for the chip filter)
  const counts = await db('orders')
    .where({ tenant_id: tenantId })
    .whereNotNull('waybill')
    .select('packing_status')
    .count<{ packing_status: string; count: string }[]>('id as count')
    .groupBy('packing_status');

  const countMap: Record<string, number> = {};
  counts.forEach((c: any) => { countMap[c.packing_status] = parseInt(c.count); });

  return res.status(200).json({ success: true, data: { orders, counts: countMap } });
});

/**
 * POST /packer/orders/:id/mark-packed - mark order as packed and ready
 */
router.post('/orders/:id/mark-packed', requirePermission('orders.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const { note } = req.body || {};

  const updated = await db('orders').where({ id, tenant_id: tenantId }).update({
    packing_status: 'packed',
    packed_at: new Date(),
    packed_by: req.tenant!.userId || null,
    packing_note: note || null,
    updated_at: new Date(),
  });

  if (updated === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
  log.info({ orderId: id, by: req.tenant?.email }, 'Order marked packed');
  return res.status(200).json({ success: true, data: { message: 'Marked packed' } });
});

/**
 * POST /packer/orders/:id/mark-dropped-off - mark order as handed to courier
 */
router.post('/orders/:id/mark-dropped-off', requirePermission('orders.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const { note } = req.body || {};

  const updated = await db('orders').where({ id, tenant_id: tenantId }).update({
    packing_status: 'dropped_off',
    dropped_off_at: new Date(),
    dropped_off_by: req.tenant!.userId || null,
    packing_note: note || null,
    // If the order wasn't yet marked as packed, mark it now too
    packed_at: db.raw('COALESCE(packed_at, NOW())'),
    updated_at: new Date(),
  });

  if (updated === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
  log.info({ orderId: id, by: req.tenant?.email }, 'Order marked dropped-off');
  return res.status(200).json({ success: true, data: { message: 'Marked dropped-off' } });
});

/**
 * POST /packer/orders/:id/revert - move order back to awaiting_packing (in case of mistake)
 */
router.post('/orders/:id/revert', requirePermission('orders.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };

  const updated = await db('orders').where({ id, tenant_id: tenantId }).update({
    packing_status: 'awaiting_packing',
    packed_at: null,
    packed_by: null,
    dropped_off_at: null,
    dropped_off_by: null,
    updated_at: new Date(),
  });
  if (updated === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
  return res.status(200).json({ success: true, data: { message: 'Reverted to awaiting_packing' } });
});

export default router;

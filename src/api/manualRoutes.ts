import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { emitEvent, DomainEventType } from '../events';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'manual-api' });
const router = Router();

router.use(authMiddleware);

// ============================================================
// MANUAL UPLOAD QUEUE
// ============================================================

/**
 * GET /manual/upload-queue - orders that need manual courier upload
 */
router.get('/upload-queue', requirePermission('orders.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const status = (req.query.status as string) || 'pending'; // pending | completed
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

  let q = db('orders')
    .where({ tenant_id: tenantId, routing_status: 'manual_upload' })
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (status === 'pending') q = q.whereNull('waybill');
  else if (status === 'completed') q = q.whereNotNull('waybill');

  const orders = await q.select(
    'id', 'order_number', 'customer_name', 'customer_phone',
    'delivery_method', 'delivery_address', 'line_items',
    'waybill', 'pincode', 'manual_upload_reason',
    'manual_uploaded_at', 'status', 'created_at',
  );

  // Counts
  const pendingCount = await db('orders').where({ tenant_id: tenantId, routing_status: 'manual_upload' }).whereNull('waybill').count<{count:string}[]>('id as count');
  const completedCount = await db('orders').where({ tenant_id: tenantId, routing_status: 'manual_upload' }).whereNotNull('waybill').count<{count:string}[]>('id as count');

  return res.status(200).json({
    success: true,
    data: {
      orders,
      counts: { pending: parseInt(pendingCount[0]?.count||'0'), completed: parseInt(completedCount[0]?.count||'0') },
    },
  });
});

/**
 * POST /manual/upload-queue/:id/complete - user provides waybill + PIN after manual upload
 */
router.post('/upload-queue/:id/complete', requirePermission('orders.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const { waybill, pincode } = req.body;

  if (!waybill) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'waybill is required' } });

  const order = await db('orders').where({ id, tenant_id: tenantId, routing_status: 'manual_upload' }).first();
  if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found in manual queue' } });

  await db('orders').where({ id }).update({
    waybill: waybill.trim(),
    pincode: pincode?.trim() || null,
    status: 'submitted',
    courier_status: 'deposit-pending',
    packing_status: 'awaiting_packing',
    manual_uploaded_at: new Date(),
    manual_uploaded_by: req.tenant!.userId || null,
    updated_at: new Date(),
  });

  // Emit order.confirmed so WhatsApp notifications fire
  try {
    await emitEvent({
      tenantId,
      type: DomainEventType.ORDER_CONFIRMED,
      aggregateType: 'order',
      aggregateId: id,
      payload: {
        order_number: order.order_number,
        waybill: waybill.trim(),
        pincode: pincode?.trim() || null,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
        delivery_method: order.delivery_method,
        manual_upload: true,
      },
    });
  } catch (e: any) { log.warn({ orderId: id, error: e.message }, 'Failed to emit event for manual upload'); }

  log.info({ orderId: id, waybill, by: req.tenant?.email }, 'Manual upload completed');
  return res.status(200).json({ success: true, data: { message: 'Waybill recorded. Order is now in the fulfillment pipeline.' } });
});

// ============================================================
// COLLECTION QUEUE
// ============================================================

/**
 * GET /manual/collection-queue - orders awaiting customer collection
 */
router.get('/collection-queue', requirePermission('orders.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const status = (req.query.status as string) || 'pending'; // pending | collected
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

  let q = db('orders')
    .where({ tenant_id: tenantId, routing_status: 'collection' })
    .orderBy('created_at', 'desc')
    .limit(limit);

  if (status === 'pending') q = q.whereNull('collected_at');
  else if (status === 'collected') q = q.whereNotNull('collected_at');

  const orders = await q.select(
    'id', 'order_number', 'customer_name', 'customer_phone',
    'delivery_method', 'line_items',
    'collected_at', 'collection_note', 'status', 'created_at',
  );

  const pendingCount = await db('orders').where({ tenant_id: tenantId, routing_status: 'collection' }).whereNull('collected_at').count<{count:string}[]>('id as count');
  const collectedCount = await db('orders').where({ tenant_id: tenantId, routing_status: 'collection' }).whereNotNull('collected_at').count<{count:string}[]>('id as count');

  return res.status(200).json({
    success: true,
    data: {
      orders,
      counts: { pending: parseInt(pendingCount[0]?.count||'0'), collected: parseInt(collectedCount[0]?.count||'0') },
    },
  });
});

/**
 * POST /manual/collection-queue/:id/confirm - confirm customer collected the order
 */
router.post('/collection-queue/:id/confirm', requirePermission('orders.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const { id } = req.params as { id: string };
  const { note } = req.body || {};

  const order = await db('orders').where({ id, tenant_id: tenantId, routing_status: 'collection' }).first();
  if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found in collection queue' } });

  await db('orders').where({ id }).update({
    status: 'delivered',
    collected_at: new Date(),
    collected_by: req.tenant!.userId || null,
    collection_note: note?.trim() || null,
    updated_at: new Date(),
  });

  // Emit order.delivered
  try {
    await emitEvent({
      tenantId,
      type: DomainEventType.ORDER_DELIVERED,
      aggregateType: 'order',
      aggregateId: id,
      payload: { order_number: order.order_number, customer_name: order.customer_name, customer_phone: order.customer_phone, collection: true },
    });
  } catch (e: any) { log.warn({ orderId: id, error: e.message }, 'Failed to emit event for collection'); }

  log.info({ orderId: id, by: req.tenant?.email }, 'Collection confirmed');
  return res.status(200).json({ success: true, data: { message: 'Collection confirmed' } });
});

export default router;

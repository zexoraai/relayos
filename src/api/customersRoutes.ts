import { Router, Response } from 'express';
import { AuthenticatedRequest, authMiddleware, requirePermission } from './middleware';
import { getDb } from '../db/connection';
import { getCustomerOrders, normalizePhone } from '../customers';

const router = Router();
router.use(authMiddleware);

// GET /customers - List all customers for the tenant
router.get('/', requirePermission('customers.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const search = req.query.search as string || '';

  let query = db('customers').where({ tenant_id: tenantId });

  if (search) {
    query = query.where(function() {
      this.where('name', 'ilike', `%${search}%`)
        .orWhere('phone', 'ilike', `%${search}%`)
        .orWhere('phone_normalized', 'ilike', `%${search}%`);
    });
  }

  const customers = await query
    .orderBy('last_order_at', 'desc')
    .limit(limit)
    .select('id', 'name', 'phone', 'phone_normalized', 'email', 'order_count', 'first_order_at', 'last_order_at', 'created_at');

  const total = await db('customers').where({ tenant_id: tenantId }).count('id as count').first();

  return res.status(200).json({
    success: true,
    data: { customers, total: parseInt(total?.count as string || '0') },
  });
});

// GET /customers/:id - Get customer detail with order history
router.get('/:id', requirePermission('customers.view'), async (req: AuthenticatedRequest, res: Response) => {
  const db = getDb();
  const tenantId = req.tenant!.tenantId;
  const customerId = req.params.id as string;

  const customer = await db('customers').where({ id: customerId, tenant_id: tenantId }).first();
  if (!customer) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Customer not found' } });
  }

  const orders = await db('orders')
    .where({ customer_id: customerId })
    .orderBy('created_at', 'desc')
    .select('id', 'order_number', 'customer_name', 'delivery_method', 'waybill', 'pincode', 'status', 'courier_status', 'shopify_fulfillment_status', 'created_at');

  return res.status(200).json({ success: true, data: { customer, orders } });
});

// GET /customers/lookup/:phone - Lookup customer by phone number
router.get('/lookup/:phone', requirePermission('customers.view'), async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenantId;
  const phone = req.params.phone as string;
  const result = await getCustomerOrders(tenantId, phone);

  if (!result.customer) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Customer not found' } });
  }

  return res.status(200).json({ success: true, data: result });
});

export default router;

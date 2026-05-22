import { getDb } from '../db/connection';
import { normalizePhone } from '../customers';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'chatbot:customer-context' });

export interface CustomerProfile {
  known: boolean;
  name: string | null;
  phone: string;
  orderCount: number;
  lastOrderDate: string | null;
  recentOrders: Array<{
    order_number: string;
    status: string;
    waybill: string | null;
    pincode: string | null;
    delivery_method: string | null;
    created_at: string;
  }>;
}

/**
 * Build a customer profile from the phone number.
 * This gets injected into the chatbot's context so it knows who it's talking to
 * without needing to call lookup_orders_by_phone first.
 */
export async function buildCustomerProfile(tenantId: string, phone: string): Promise<CustomerProfile> {
  const db = getDb();
  const phoneNormalized = normalizePhone(phone);

  const customer = await db('customers')
    .where({ tenant_id: tenantId, phone_normalized: phoneNormalized })
    .first();

  if (!customer) {
    return { known: false, name: null, phone: phoneNormalized, orderCount: 0, lastOrderDate: null, recentOrders: [] };
  }

  const recentOrders = await db('orders')
    .where({ customer_id: customer.id })
    .orderBy('created_at', 'desc')
    .limit(5)
    .select('order_number', 'status', 'waybill', 'pincode', 'delivery_method', 'created_at');

  return {
    known: true,
    name: customer.name,
    phone: phoneNormalized,
    orderCount: customer.order_count || 0,
    lastOrderDate: customer.last_order_at ? new Date(customer.last_order_at).toISOString().split('T')[0] : null,
    recentOrders: recentOrders.map((o: any) => ({
      order_number: o.order_number,
      status: o.status,
      waybill: o.waybill,
      pincode: o.pincode,
      delivery_method: o.delivery_method,
      created_at: new Date(o.created_at).toISOString().split('T')[0],
    })),
  };
}

/**
 * Format the customer profile as a context string for injection into the system prompt.
 */
export function formatProfileContext(profile: CustomerProfile): string {
  if (!profile.known) {
    return 'Customer context: New customer (no previous orders found for this phone number).';
  }

  let ctx = `Customer context: ${profile.name || 'Unknown name'}, ${profile.orderCount} total orders, last order ${profile.lastOrderDate || 'unknown'}.`;

  if (profile.recentOrders.length > 0) {
    ctx += '\nRecent orders:';
    for (const o of profile.recentOrders) {
      ctx += `\n- #${o.order_number} (${o.status}) waybill:${o.waybill || 'none'} pin:${o.pincode || 'none'} [${o.delivery_method || '?'}] ${o.created_at}`;
    }
  }

  return ctx;
}

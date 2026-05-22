import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'customers' });

/**
 * Normalize a South African phone number to a consistent format.
 * 0834603639 -> +27834603639
 * 27834603639 -> +27834603639
 * +27834603639 -> +27834603639
 */
export function normalizePhone(phone: string): string {
  if (!phone) return '';
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  // Remove leading + for processing
  if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
  // Convert 0-prefix to 27
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = '27' + cleaned.substring(1);
  }
  // Ensure starts with 27
  if (!cleaned.startsWith('27') && cleaned.length === 9) {
    cleaned = '27' + cleaned;
  }
  return '+' + cleaned;
}

/**
 * Upsert a customer by phone number.
 * If the customer exists, updates name and increments order count.
 * If new, creates the customer record.
 * Returns the customer ID.
 */
export async function upsertCustomer(
  tenantId: string,
  phone: string,
  name: string | null,
  email?: string | null
): Promise<string> {
  const db = getDb();
  const phoneNormalized = normalizePhone(phone);

  if (!phoneNormalized || phoneNormalized.length < 5) {
    log.warn({ tenantId, phone }, 'Invalid phone number, cannot create customer');
    return '';
  }

  const existing = await db('customers')
    .where({ tenant_id: tenantId, phone_normalized: phoneNormalized })
    .first();

  if (existing) {
    // Update name if provided (use latest), increment order count
    const updates: any = {
      order_count: existing.order_count + 1,
      last_order_at: new Date(),
      updated_at: new Date(),
    };
    if (name && name.trim()) updates.name = name.trim();
    if (email && email.trim()) updates.email = email.trim();

    await db('customers').where({ id: existing.id }).update(updates);

    log.debug({ customerId: existing.id, phone: phoneNormalized, orderCount: existing.order_count + 1 }, 'Customer updated');
    return existing.id;
  }

  // Create new customer
  const [customer] = await db('customers')
    .insert({
      tenant_id: tenantId,
      phone: phone.trim(),
      phone_normalized: phoneNormalized,
      name: name?.trim() || null,
      email: email?.trim() || null,
      order_count: 1,
      first_order_at: new Date(),
      last_order_at: new Date(),
    })
    .returning('id');

  log.info({ customerId: customer.id, phone: phoneNormalized, name }, 'New customer created');
  return customer.id;
}

/**
 * Link an order to a customer.
 */
export async function linkOrderToCustomer(orderId: string, customerId: string): Promise<void> {
  if (!customerId) return;
  const db = getDb();
  await db('orders').where({ id: orderId }).update({ customer_id: customerId, updated_at: new Date() });
}

/**
 * Get all orders for a customer by phone.
 */
export async function getCustomerOrders(tenantId: string, phone: string) {
  const db = getDb();
  const phoneNormalized = normalizePhone(phone);

  const customer = await db('customers')
    .where({ tenant_id: tenantId, phone_normalized: phoneNormalized })
    .first();

  if (!customer) return { customer: null, orders: [] };

  const orders = await db('orders')
    .where({ customer_id: customer.id })
    .orderBy('created_at', 'desc')
    .select('id', 'order_number', 'customer_name', 'delivery_method', 'waybill', 'pincode', 'status', 'courier_status', 'shopify_fulfillment_status', 'created_at');

  return { customer, orders };
}

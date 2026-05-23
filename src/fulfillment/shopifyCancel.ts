import https from 'https';
import { getDb } from '../db/connection';
import { decrypt } from '../crypto';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'fulfillment:shopify-cancel' });

export interface ShopifyCancelResult {
  ok: boolean;
  status: number;
  body: any;
  /** True if Shopify reports the order as already cancelled. */
  alreadyCancelled?: boolean;
}

/**
 * Cancel an order on Shopify Admin API.
 *
 * Uses POST /admin/api/2024-01/orders/{id}/cancel.json
 *   - reason: customer | inventory | fraud | declined | other
 *   - refund: if true, attempts a refund as part of the cancel
 *   - email: notify the customer
 *   - restock: restore inventory
 *
 * Reads tenant_shopify_api_settings for the store + access token. Throws if not configured.
 */
export async function cancelShopifyOrder(args: {
  tenantId: string;
  /** Either the numeric Shopify order id (preferred) or the human-friendly order_number. */
  shopifyOrderId?: number | string | null;
  orderNumber?: string | null;
  reason?: 'customer' | 'inventory' | 'fraud' | 'declined' | 'other';
  refund?: boolean;
  email?: boolean;
  restock?: boolean;
  staffNote?: string;
}): Promise<ShopifyCancelResult> {
  const db = getDb();

  const apiSettings = await db('tenant_shopify_api_settings').where({ tenant_id: args.tenantId }).first();
  if (!apiSettings) {
    throw new Error('Shopify API credentials not configured for this tenant');
  }

  let accessToken: string;
  try {
    accessToken = decrypt(apiSettings.encrypted_access_token);
  } catch (err: any) {
    throw new Error(
      `Shopify access token could not be decrypted (likely encrypted with a different ENCRYPTION_KEY). Re-save Shopify credentials in Settings. Underlying: ${err.message}`,
    );
  }

  const store: string = apiSettings.shopify_store;
  const hostname = store.includes('.') ? store : `${store}.myshopify.com`;

  // Resolve to a numeric Shopify order id if we only have the order_number.
  let orderId: number | null = null;
  if (args.shopifyOrderId) {
    orderId = Number(args.shopifyOrderId);
    if (Number.isNaN(orderId)) orderId = null;
  }
  if (!orderId && args.orderNumber) {
    orderId = await resolveOrderId(hostname, accessToken, args.orderNumber);
  }
  if (!orderId) {
    throw new Error('Could not resolve a Shopify order id from the inputs');
  }

  const body: Record<string, any> = {
    reason: args.reason || 'customer',
    email: args.email !== false, // default true
  };
  if (args.refund) body.refund = { restock: args.restock !== false, note: args.staffNote || undefined };
  else if (args.restock) body.restock = true;
  if (args.staffNote) body.staff_note = args.staffNote;

  const path = `/admin/api/2024-01/orders/${orderId}/cancel.json`;
  const result = await postJson(hostname, accessToken, path, body);

  // Shopify returns 422 with a specific error if the order can't be cancelled because it's already cancelled.
  const alreadyCancelled =
    result.status === 422 &&
    typeof result.body === 'object' &&
    result.body !== null &&
    JSON.stringify(result.body).toLowerCase().includes('already');

  if (result.status >= 200 && result.status < 300) {
    log.info({ orderId, hostname }, 'Shopify order cancelled');
  } else if (alreadyCancelled) {
    log.info({ orderId, hostname }, 'Shopify order was already cancelled');
  } else {
    log.warn({ orderId, hostname, status: result.status, body: result.body }, 'Shopify cancel returned non-2xx');
  }

  return {
    ok: (result.status >= 200 && result.status < 300) || !!alreadyCancelled,
    status: result.status,
    body: result.body,
    alreadyCancelled,
  };
}

function resolveOrderId(hostname: string, accessToken: string, orderNumber: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const path = `/admin/api/2024-01/orders.json?name=%23${encodeURIComponent(orderNumber)}&status=any&fields=id,name`;
    const req = https.request(
      {
        hostname,
        path,
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          Accept: 'application/json',
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
            return reject(new Error(`Shopify lookup returned ${res.statusCode}: ${data}`));
          }
          try {
            const parsed = JSON.parse(data);
            const orders = parsed?.orders || [];
            resolve(orders.length > 0 ? Number(orders[0].id) : null);
          } catch (err: any) {
            reject(new Error(`Failed to parse Shopify lookup: ${err.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Shopify lookup timed out'));
    });
    req.end();
  });
}

function postJson(hostname: string, accessToken: string, path: string, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 20000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Shopify request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

import https from 'https';
import { getDb } from '../../db/connection';
import { decrypt } from '../../crypto';
import { createChildLogger } from '../../observability/logger';

const log = createChildLogger({ module: 'fulfillment:shopify-status-check' });

/**
 * Checks the Shopify fulfillment_status for an order and persists it.
 * Runs on every poll cycle. Skips if no Shopify API credentials.
 * Returns the fulfillment_status: null (unfulfilled), "partial", or "fulfilled".
 */
export async function checkShopifyFulfillmentStatus(
  tenantId: string,
  orderId: string,
  orderNumber: string
): Promise<string | null> {
  const db = getDb();

  const apiSettings = await db('tenant_shopify_api_settings').where({ tenant_id: tenantId }).first();
  if (!apiSettings) return null; // No creds, skip

  const shopifyStore = apiSettings.shopify_store;
  const accessToken = decrypt(apiSettings.encrypted_access_token);

  try {
    const hostname = shopifyStore.includes('.') ? shopifyStore : `${shopifyStore}.myshopify.com`;
    const path = `/admin/api/2024-01/orders.json?name=%23${encodeURIComponent(orderNumber)}&status=any&fields=id,name,fulfillment_status`;

    const result = await new Promise<any>((resolve, reject) => {
      const req = https.request({
        hostname, path, method: 'GET',
        headers: { 'X-Shopify-Access-Token': accessToken, 'Accept': 'application/json' },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Shopify ${res.statusCode}`));
          try { resolve(JSON.parse(data)); } catch (e: any) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    const shopifyOrder = result.orders?.[0];
    const fulfillmentStatus = shopifyOrder?.fulfillment_status || null; // null = unfulfilled

    // Persist to order
    await db('orders').where({ id: orderId }).update({
      shopify_fulfillment_status: fulfillmentStatus,
      updated_at: new Date(),
    });

    return fulfillmentStatus;
  } catch (error: any) {
    log.debug({ tenantId, orderNumber, error: error.message }, 'Shopify status check failed (non-fatal)');
    return null;
  }
}

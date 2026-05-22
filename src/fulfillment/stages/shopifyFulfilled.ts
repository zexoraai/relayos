import https from 'https';
import { getDb } from '../../db/connection';
import { decrypt } from '../../crypto';
import { createChildLogger } from '../../observability/logger';
import { FulfillmentStage, FulfillmentMilestone } from '../types';
import { withIdempotency, makeKey, IdempotencyInProgressError } from '../../idempotency';

const log = createChildLogger({ module: 'fulfillment:shopify-fulfilled' });

export interface ShopifyFulfillmentResult {
  fulfilled: boolean;
  shopify_order_id: string | null;
  fulfillment_order_id: string | null;
  shopify_fulfillment_id: string | null;
  skipped_reason?: string;
  user_errors?: string[];
}

/**
 * Stage: SHOPIFY_FULFILLED
 * Triggered once when milestone reaches IN_TRANSIT.
 * Looks up Shopify order, finds fulfillment_order_id, and creates fulfillment via GraphQL.
 * Skips gracefully if no Shopify API credentials, already fulfilled, or order not found.
 */
export async function executeShopifyFulfilled(
  jobId: string,
  tenantId: string,
  orderId: string,
  milestone: FulfillmentMilestone
): Promise<ShopifyFulfillmentResult> {
  const db = getDb();

  // Only fire on IN_TRANSIT
  if (milestone !== FulfillmentMilestone.IN_TRANSIT) {
    return { fulfilled: false, shopify_order_id: null, fulfillment_order_id: null, shopify_fulfillment_id: null, skipped_reason: 'Milestone is not in_transit' };
  }

  const order = await db('orders').where({ id: orderId }).first();
  if (!order) {
    return { fulfilled: false, shopify_order_id: null, fulfillment_order_id: null, shopify_fulfillment_id: null, skipped_reason: 'Order not found' };
  }

  // Already fulfilled?
  if (order.shopify_fulfilled) {
    log.debug({ jobId, orderId }, 'Shopify already fulfilled, skipping');
    return { fulfilled: true, shopify_order_id: order.shopify_order_id, fulfillment_order_id: order.shopify_fulfillment_order_id, shopify_fulfillment_id: order.shopify_fulfillment_id };
  }

  // Tenant must have Shopify API credentials
  const apiSettings = await db('tenant_shopify_api_settings').where({ tenant_id: tenantId }).first();
  if (!apiSettings) {
    const result: ShopifyFulfillmentResult = {
      fulfilled: false,
      shopify_order_id: null,
      fulfillment_order_id: null,
      shopify_fulfillment_id: null,
      skipped_reason: 'No Shopify API credentials configured',
    };
    await recordStageResult(db, jobId, 'skipped', result);
    log.info({ jobId, tenantId }, 'Shopify fulfillment skipped (no API credentials)');
    return result;
  }

  const shopifyStore = apiSettings.shopify_store;
  const accessToken = decrypt(apiSettings.encrypted_access_token);

  try {
    // Step 1: Find the Shopify order by order number
    const shopifyOrder = await fetchShopifyOrder(shopifyStore, accessToken, order.order_number);
    if (!shopifyOrder) {
      throw new Error(`Order #${order.order_number} not found in Shopify`);
    }

    // Step 2: Get fulfillment orders for this order
    const fulfillmentOrders = await fetchFulfillmentOrders(shopifyStore, accessToken, shopifyOrder.id);
    if (!fulfillmentOrders || fulfillmentOrders.length === 0) {
      throw new Error('No fulfillment orders found');
    }

    // Use the first OPEN fulfillment order (skip already-closed ones)
    const openFulfillmentOrder = fulfillmentOrders.find((fo: any) => fo.status === 'open') || fulfillmentOrders[0];
    const fulfillmentOrderId = openFulfillmentOrder.id;

    // Step 3: Create the fulfillment via GraphQL — wrapped in idempotency.
    // Key on (tenant, shopify_order_id, fulfillment_order_id) so a retry of the same logical
    // fulfillment never creates a duplicate Shopify fulfillment.
    const idemKey = makeKey('shopify_fulfillment', tenantId, `${shopifyOrder.id}:${fulfillmentOrderId}`);
    const idem = await withIdempotency<any>({
      key: idemKey,
      tenantId,
      actionType: 'shopify_fulfillment',
      businessKey: `${shopifyOrder.id}:${fulfillmentOrderId}`,
      ttlMs: 30 * 24 * 60 * 60 * 1000,  // 30 days — Shopify fulfillment is durable
      fn: async () => {
        const gql = await createFulfillment(shopifyStore, accessToken, {
          fulfillmentOrderId: `gid://shopify/FulfillmentOrder/${fulfillmentOrderId}`,
          trackingNumber: order.waybill?.trim() || '',
          trackingCompany: 'The Courier Guy',
          trackingUrl: 'https://portal.thecourierguy.co.za/track',
        });
        return { response: gql };
      },
    });

    if (idem.cached) {
      log.info({ jobId, orderId, shopifyOrderId: shopifyOrder.id }, 'Shopify fulfillment returned from idempotency cache');
    }

    const gqlResult = idem.response;

    if (gqlResult.userErrors && gqlResult.userErrors.length > 0) {
      const errorMessages = gqlResult.userErrors.map((e: any) => e.message);
      throw new Error('Shopify user errors: ' + errorMessages.join(', '));
    }

    const shopifyFulfillmentId = gqlResult.fulfillment?.id || null;

    // Persist to order
    await db('orders').where({ id: orderId }).update({
      shopify_order_id: String(shopifyOrder.id),
      shopify_fulfillment_order_id: String(fulfillmentOrderId),
      shopify_fulfillment_id: shopifyFulfillmentId,
      shopify_fulfilled: true,
      shopify_fulfilled_at: new Date(),
      updated_at: new Date(),
    });

    const result: ShopifyFulfillmentResult = {
      fulfilled: true,
      shopify_order_id: String(shopifyOrder.id),
      fulfillment_order_id: String(fulfillmentOrderId),
      shopify_fulfillment_id: shopifyFulfillmentId,
    };

    await recordStageResult(db, jobId, 'completed', result);

    log.info({ jobId, orderId, shopifyOrderId: shopifyOrder.id, fulfillmentOrderId, shopifyFulfillmentId }, 'Shopify fulfillment created');
    return result;

  } catch (error: any) {
    if (error instanceof IdempotencyInProgressError) {
      log.info({ jobId, orderId }, 'Shopify fulfillment deferred — another worker in flight');
      return { fulfilled: false, shopify_order_id: null, fulfillment_order_id: null, shopify_fulfillment_id: null, skipped_reason: 'IDEMPOTENT_IN_PROGRESS' };
    }
    log.warn({ jobId, error: error.message }, 'Shopify fulfillment failed (non-fatal)');
    const result: ShopifyFulfillmentResult = {
      fulfilled: false,
      shopify_order_id: null,
      fulfillment_order_id: null,
      shopify_fulfillment_id: null,
      skipped_reason: error.message,
    };
    await recordStageResult(db, jobId, 'failed', result, error.message);
    return result;
  }
}

async function recordStageResult(db: any, jobId: string, status: string, output: any, errorMessage?: string) {
  await db('fulfillment_stage_results').insert({
    fulfillment_job_id: jobId,
    stage: FulfillmentStage.SHOPIFY_FULFILLED,
    status,
    output_data: JSON.stringify(output),
    error_message: errorMessage || null,
  });

  await db('fulfillment_jobs').where({ id: jobId }).update({
    current_stage: FulfillmentStage.SHOPIFY_FULFILLED,
    updated_at: new Date(),
  });
}

function fetchShopifyOrder(store: string, token: string, orderNumber: string): Promise<any | null> {
  return new Promise((resolve, reject) => {
    const hostname = store.includes('.') ? store : `${store}.myshopify.com`;
    const path = `/admin/api/2024-01/orders.json?name=%23${encodeURIComponent(orderNumber)}&status=any&fields=id,name,order_number`;

    const req = https.request({
      hostname, path, method: 'GET',
      headers: { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Shopify orders API ${res.statusCode}`));
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.orders?.[0] || null);
        } catch (e: any) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Shopify request timed out')); });
    req.end();
  });
}

function fetchFulfillmentOrders(store: string, token: string, orderId: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const hostname = store.includes('.') ? store : `${store}.myshopify.com`;
    const path = `/admin/api/2024-01/orders/${orderId}/fulfillment_orders.json`;

    const req = https.request({
      hostname, path, method: 'GET',
      headers: { 'X-Shopify-Access-Token': token, 'Accept': 'application/json' },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Shopify fulfillment_orders API ${res.statusCode}`));
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.fulfillment_orders || []);
        } catch (e: any) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Shopify request timed out')); });
    req.end();
  });
}

interface CreateFulfillmentInput {
  fulfillmentOrderId: string;
  trackingNumber: string;
  trackingCompany: string;
  trackingUrl: string;
}

function createFulfillment(store: string, token: string, input: CreateFulfillmentInput): Promise<any> {
  return new Promise((resolve, reject) => {
    const hostname = store.includes('.') ? store : `${store}.myshopify.com`;
    const path = `/admin/api/2024-01/graphql.json`;

    const body = JSON.stringify({
      query: `mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment { id }
          userErrors { message field }
        }
      }`,
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: input.fulfillmentOrderId }],
          trackingInfo: {
            number: input.trackingNumber,
            company: input.trackingCompany,
            url: input.trackingUrl,
          },
          notifyCustomer: true,
        },
      },
    });

    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Shopify GraphQL ${res.statusCode}: ${data.substring(0, 200)}`));
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) return reject(new Error('GraphQL errors: ' + JSON.stringify(parsed.errors)));
          resolve(parsed.data?.fulfillmentCreateV2 || {});
        } catch (e: any) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Shopify GraphQL timed out')); });
    req.write(body);
    req.end();
  });
}

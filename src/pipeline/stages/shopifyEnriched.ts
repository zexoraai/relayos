import https from 'https';
import { getDb } from '../../db/connection';
import { decrypt } from '../../crypto';
import { createChildLogger } from '../../observability/logger';
import { ExtractedOrderData, PipelineStage, PipelineStatus } from '../types';

const log = createChildLogger({ module: 'pipeline:shopify-enriched' });

export interface ShopifyEnrichmentResult {
  enriched: boolean;
  order_number: string;
  line_items: Array<{ name: string; quantity: number; price: string; sku: string }>;
  skipped_reason?: string;
}

/**
 * Stage: SHOPIFY_ENRICHED (optional)
 * Uses the order number to fetch line items from Shopify.
 * Other fields (customer, address) are sourced from AI extraction + geocoding.
 * Skips gracefully if no Shopify API credentials are configured.
 */
export async function executeShopifyEnriched(
  jobId: string,
  tenantId: string,
  extracted: ExtractedOrderData
): Promise<ShopifyEnrichmentResult> {
  const db = getDb();

  const apiSettings = await db('tenant_shopify_api_settings')
    .where({ tenant_id: tenantId })
    .first();

  if (!apiSettings) {
    const result: ShopifyEnrichmentResult = {
      enriched: false,
      order_number: extracted.order_number,
      line_items: [],
      skipped_reason: 'No Shopify API credentials configured',
    };

    await db('pipeline_stage_results').insert({
      pipeline_job_id: jobId,
      stage: PipelineStage.SHOPIFY_ENRICHED,
      status: PipelineStatus.SKIPPED,
      input_data: JSON.stringify({ order_number: extracted.order_number }),
      output_data: JSON.stringify(result),
    });

    await db('pipeline_jobs').where({ id: jobId }).update({
      current_stage: PipelineStage.SHOPIFY_ENRICHED,
      updated_at: new Date(),
    });

    log.info({ jobId, tenantId }, 'Shopify enrichment skipped (no API credentials)');
    return result;
  }

  const shopifyStore = apiSettings.shopify_store;
  let accessToken: string;
  try {
    accessToken = decrypt(apiSettings.encrypted_access_token);
  } catch (err: any) {
    log.warn(
      { jobId, tenantId, error: err.message },
      'Shopify enrichment skipped — failed to decrypt access token (likely encrypted with a different ENCRYPTION_KEY). Re-save Shopify API credentials in the dashboard.',
    );
    const result: ShopifyEnrichmentResult = {
      enriched: false,
      order_number: extracted.order_number,
      line_items: [],
      skipped_reason: `Could not decrypt Shopify API token: ${err.message}`,
    };

    await db('pipeline_stage_results').insert({
      pipeline_job_id: jobId,
      stage: PipelineStage.SHOPIFY_ENRICHED,
      status: PipelineStatus.SKIPPED,
      input_data: JSON.stringify({ order_number: extracted.order_number }),
      output_data: JSON.stringify(result),
    });

    await db('pipeline_jobs').where({ id: jobId }).update({
      current_stage: PipelineStage.SHOPIFY_ENRICHED,
      updated_at: new Date(),
    });

    return result;
  }

  try {
    const order = await fetchShopifyOrder(shopifyStore, accessToken, extracted.order_number);

    const result: ShopifyEnrichmentResult = {
      enriched: true,
      order_number: extracted.order_number,
      line_items: (order.line_items || []).map((li: any) => ({
        name: li.name || li.title || '',
        quantity: li.quantity || 1,
        price: li.price || '',
        sku: li.sku || '',
      })),
    };

    await db('pipeline_stage_results').insert({
      pipeline_job_id: jobId,
      stage: PipelineStage.SHOPIFY_ENRICHED,
      status: PipelineStatus.COMPLETED,
      input_data: JSON.stringify({ order_number: extracted.order_number, store: shopifyStore }),
      output_data: JSON.stringify(result),
    });

    await db('pipeline_jobs').where({ id: jobId }).update({
      current_stage: PipelineStage.SHOPIFY_ENRICHED,
      updated_at: new Date(),
    });

    log.info({ jobId, orderNumber: extracted.order_number, lineItems: result.line_items.length }, 'Shopify enrichment completed');
    return result;

  } catch (error: any) {
    log.warn({ jobId, error: error.message }, 'Shopify enrichment failed (non-fatal)');

    const result: ShopifyEnrichmentResult = {
      enriched: false,
      order_number: extracted.order_number,
      line_items: [],
      skipped_reason: `Shopify API error: ${error.message}`,
    };

    await db('pipeline_stage_results').insert({
      pipeline_job_id: jobId,
      stage: PipelineStage.SHOPIFY_ENRICHED,
      status: PipelineStatus.SKIPPED,
      input_data: JSON.stringify({ order_number: extracted.order_number }),
      output_data: JSON.stringify(result),
      error_message: error.message,
    });

    await db('pipeline_jobs').where({ id: jobId }).update({
      current_stage: PipelineStage.SHOPIFY_ENRICHED,
      updated_at: new Date(),
    });

    return result;
  }
}

function fetchShopifyOrder(store: string, accessToken: string, orderNumber: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const hostname = store.includes('.') ? store : `${store}.myshopify.com`;
    const path = `/admin/api/2024-01/orders.json?name=%23${orderNumber}&status=any`;

    const options = {
      hostname,
      path,
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Shopify API returned ${res.statusCode}`));
        }
        try {
          const parsed = JSON.parse(data);
          const orders = parsed.orders || [];
          if (orders.length === 0) {
            return reject(new Error(`Order #${orderNumber} not found in Shopify`));
          }
          resolve(orders[0]);
        } catch (e: any) {
          reject(new Error(`Failed to parse Shopify response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Shopify request timed out')); });
    req.end();
  });
}

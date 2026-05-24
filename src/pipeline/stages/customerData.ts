import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { ExtractedOrderData, PipelineStage, PipelineStatus } from '../types';
import { ResolvedLocation, DeliveryAddress } from './locationResolved';
import { ShopifyEnrichmentResult } from './shopifyEnriched';

const log = createChildLogger({ module: 'pipeline:customer-data' });

export interface CustomerData {
  delivery_address: DeliveryAddress;
  OrderNumber: string;
  deliverMethod: string;
  customerName: string;
  customerPhone: string;
  collectionMethod: string | null;
  upload_type: string;
  line_items: Array<{ name: string; quantity: number }>;
}

/**
 * Stage: CUSTOMER_DATA
 * Assembles the final customer data object from all previous stages.
 * This is the unified shape used by downstream stages (lockers, courier, payload).
 */
export async function executeCustomerData(
  jobId: string,
  extracted: ExtractedOrderData,
  location: ResolvedLocation,
  enrichment: ShopifyEnrichmentResult
): Promise<CustomerData> {
  const db = getDb();

  // Normalize phone
  let phone = extracted.phone_number || '';
  phone = phone.replace(/[\s\-\(\)]/g, '');

  // Build line items from Shopify enrichment
  const lineItems = enrichment.enriched
    ? enrichment.line_items.map(li => ({ name: li.name, quantity: li.quantity }))
    : [];

  let result: CustomerData = {
    delivery_address: location.delivery_address,
    OrderNumber: extracted.order_number,
    deliverMethod: extracted.delivery_method,
    customerName: extracted.customer_name,
    customerPhone: phone,
    collectionMethod: extracted.collection_method,
    upload_type: extracted.upload_type,
    line_items: lineItems,
  };

  // Apply reviewer overrides if a human approved this job with edits.
  // We read the most recent caretaker_evaluation for this pipeline_job_id and,
  // if it has reviewer_overrides set, shallow-merge the editable fields.
  // Address is deep-merged (street/suburb/city/etc), line_items replaces wholesale if provided.
  const lastEval = await db('caretaker_evaluations')
    .where({ pipeline_job_id: jobId })
    .orderBy('created_at', 'desc')
    .first();
  const overridesRaw = lastEval?.reviewer_overrides;
  if (overridesRaw) {
    let overrides: any = overridesRaw;
    if (typeof overrides === 'string') {
      try { overrides = JSON.parse(overrides); } catch { overrides = null; }
    }
    if (overrides && typeof overrides === 'object') {
      if (typeof overrides.customer_name === 'string' && overrides.customer_name.trim()) {
        result.customerName = overrides.customer_name.trim();
      }
      if (typeof overrides.customer_phone === 'string' && overrides.customer_phone.trim()) {
        result.customerPhone = overrides.customer_phone.replace(/[\s\-\(\)]/g, '').trim();
      }
      if (typeof overrides.delivery_method === 'string' && overrides.delivery_method.trim()) {
        result.deliverMethod = overrides.delivery_method.trim();
      }
      if (overrides.delivery_address && typeof overrides.delivery_address === 'object') {
        result.delivery_address = { ...result.delivery_address, ...overrides.delivery_address };
      }
      if (Array.isArray(overrides.line_items) && overrides.line_items.length > 0) {
        result.line_items = overrides.line_items
          .filter((li: any) => li && typeof li.name === 'string' && li.name.trim())
          .map((li: any) => ({
            name: li.name.trim(),
            quantity: Number.isFinite(Number(li.quantity)) ? Number(li.quantity) : 1,
          }));
      }
      log.info({ jobId, overriddenFields: Object.keys(overrides) }, 'Reviewer overrides applied to customer data');
    }
  }

  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: PipelineStage.CUSTOMER_DATA,
    status: PipelineStatus.COMPLETED,
    input_data: JSON.stringify({ order_number: extracted.order_number }),
    output_data: JSON.stringify(result),
  });

  await db('pipeline_jobs').where({ id: jobId }).update({
    current_stage: PipelineStage.CUSTOMER_DATA,
    updated_at: new Date(),
  });

  log.info({
    jobId,
    orderNumber: result.OrderNumber,
    deliverMethod: result.deliverMethod,
    collectionMethod: result.collectionMethod,
    upload_type: result.upload_type,
    lineItems: result.line_items.length,
  }, 'Customer data assembled');

  return result;
}

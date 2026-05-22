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

  const result: CustomerData = {
    delivery_address: location.delivery_address,
    OrderNumber: extracted.order_number,
    deliverMethod: extracted.delivery_method,
    customerName: extracted.customer_name,
    customerPhone: phone,
    collectionMethod: extracted.collection_method,
    upload_type: extracted.upload_type,
    line_items: lineItems,
  };

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

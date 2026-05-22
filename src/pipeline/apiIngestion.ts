import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { PipelineStage, PipelineStatus } from './types';
import { executeLocationResolved } from './stages/locationResolved';
import { executeCustomerData } from './stages/customerData';
import { executeLockersResolved } from './stages/lockersResolved';
import { executePayloadCreated } from './stages/payloadCreated';
import { executeCaretakerReview } from './stages/caretakerReview';
import { executeCourierSubmitted } from './stages/courierSubmitted';
import { normalizePhone } from '../customers';

const log = createChildLogger({ module: 'pipeline:api-ingestion' });

/**
 * Normalized order data from a Shopify webhook (or manual API submission).
 * This is the shape we expect after extracting from the webhook payload.
 */
export interface ApiOrderInput {
  tenantId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  shippingAddress: string;
  deliveryMethod: string;       // locker-to-locker, locker-to-door, etc.
  collectionMethod?: string | null;
  uploadType?: string;          // automatic | manual
  lineItems: Array<{ name: string; quantity: number; price?: string }>;
  source: 'shopify_webhook' | 'manual_api' | string;
  shopifyOrderId?: string | null;
  correlationId?: string;
}

/**
 * Process an order that came in via API (not email).
 * Skips EMAIL_RECEIVED, EMAIL_NORMALIZED, DATA_EXTRACTED, DATA_VALIDATED, SHOPIFY_ENRICHED
 * because the data is already structured. Starts from LOCATION_RESOLVED.
 *
 * Stages: LOCATION_RESOLVED → CUSTOMER_DATA → LOCKERS_RESOLVED → PAYLOAD_CREATED
 *       → CARETAKER_REVIEW → COURIER_SUBMITTED
 */
export async function processApiOrder(input: ApiOrderInput): Promise<{ jobId: string; status: string; waybill?: string | null }> {
  const db = getDb();
  const jobId = uuidv4();
  const correlationId = input.correlationId || uuidv4();

  // Create pipeline job record
  await db('pipeline_jobs').insert({
    id: jobId,
    tenant_id: input.tenantId,
    email_id: null,
    mailbox_id: 'api',
    current_stage: PipelineStage.LOCATION_RESOLVED,
    status: PipelineStatus.PROCESSING,
    correlation_id: correlationId,
  });

  // Record the source data as the first stage result
  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: 'API_RECEIVED',
    status: PipelineStatus.COMPLETED,
    input_data: JSON.stringify({ source: input.source, shopify_order_id: input.shopifyOrderId }),
    output_data: JSON.stringify({
      order_number: input.orderNumber,
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      shipping_address: input.shippingAddress,
      delivery_method: input.deliveryMethod,
      line_items: input.lineItems,
    }),
  });

  const childLog = log.child({ jobId, orderNumber: input.orderNumber, source: input.source });
  childLog.info('API pipeline starting');

  try {
    // Build the extracted data shape that downstream stages expect
    const extractedData = {
      order_number: input.orderNumber,
      shipping_address: input.shippingAddress,
      delivery_method: input.deliveryMethod,
      phone_number: input.customerPhone,
      customer_name: input.customerName,
      collection_method: input.collectionMethod || null,
      upload_type: input.uploadType || 'automatic',
      raw_extraction: {},
    };

    // Stage: LOCATION_RESOLVED
    childLog.info('Stage: LOCATION_RESOLVED');
    const location = await executeLocationResolved(jobId, extractedData);

    // Build enrichment result (line items come directly from the API)
    const enrichmentResult = {
      enriched: true,
      line_items: input.lineItems.map(li => ({ name: li.name, quantity: li.quantity, price: li.price || '0', sku: '' })),
      order_number: input.orderNumber,
    };

    // Stage: CUSTOMER_DATA
    childLog.info('Stage: CUSTOMER_DATA');
    const customerData = await executeCustomerData(jobId, extractedData, location, enrichmentResult);

    // Route: manual orders stop here
    if (customerData.upload_type === 'manual') {
      await db('pipeline_jobs').where({ id: jobId }).update({
        status: PipelineStatus.COMPLETED,
        current_stage: PipelineStage.CUSTOMER_DATA,
        updated_at: new Date(),
      });
      childLog.info('Pipeline completed (manual route)');
      return { jobId, status: 'manual' };
    }

    // Stage: LOCKERS_RESOLVED
    childLog.info('Stage: LOCKERS_RESOLVED');
    const lockerResult = await executeLockersResolved(jobId, input.tenantId, location);

    // Stage: PAYLOAD_CREATED
    childLog.info('Stage: PAYLOAD_CREATED');
    const payload = await executePayloadCreated(jobId, input.tenantId, customerData, lockerResult);

    // Stage: CARETAKER_REVIEW
    childLog.info('Stage: CARETAKER_REVIEW');
    const review = await executeCaretakerReview(jobId, input.tenantId, customerData, lockerResult, payload);

    if (review.verdict === 'reject') {
      await db('pipeline_jobs').where({ id: jobId }).update({
        status: PipelineStatus.REJECTED,
        current_stage: PipelineStage.CARETAKER_REVIEW,
        last_error: review.summary,
        updated_at: new Date(),
      });
      childLog.warn({ flags: review.flags }, 'Pipeline rejected by caretaker');
      return { jobId, status: 'rejected' };
    }

    if (review.verdict === 'review') {
      await db('pipeline_jobs').where({ id: jobId }).update({
        status: PipelineStatus.PENDING_REVIEW,
        current_stage: PipelineStage.CARETAKER_REVIEW,
        updated_at: new Date(),
      });
      childLog.info({ flags: review.flags }, 'Pipeline paused for review');
      return { jobId, status: 'pending_review' };
    }

    // Stage: COURIER_SUBMITTED
    childLog.info('Stage: COURIER_SUBMITTED');
    const submission = await executeCourierSubmitted(jobId, input.tenantId, '', payload, customerData, lockerResult);

    childLog.info({
      waybill: submission.tracking_reference,
      submitted: submission.submitted,
    }, 'API pipeline completed');

    return { jobId, status: 'submitted', waybill: submission.tracking_reference };

  } catch (error: any) {
    childLog.error({ error: error.message }, 'API pipeline failed');
    await db('pipeline_jobs').where({ id: jobId }).update({
      status: PipelineStatus.FAILED,
      last_error: error.message,
      updated_at: new Date(),
    });
    return { jobId, status: 'failed' };
  }
}

import { Job } from 'bullmq';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { PipelineStage, PipelineStatus } from './types';
import { executeEmailReceived } from './stages/emailReceived';
import { executeEmailNormalized } from './stages/emailNormalized';
import { executeDataExtracted } from './stages/dataExtracted';
import { executeDataValidated } from './stages/dataValidated';
import { executeShopifyEnriched } from './stages/shopifyEnriched';
import { executeLocationResolved } from './stages/locationResolved';
import { executeCustomerData } from './stages/customerData';
import { executeLockersResolved } from './stages/lockersResolved';
import { executePayloadCreated } from './stages/payloadCreated';
import { executeCaretakerReview } from './stages/caretakerReview';
import { executeCourierSubmitted } from './stages/courierSubmitted';

const log = createChildLogger({ module: 'pipeline' });

export interface PipelineJobData {
  emailId: string;
  tenantId: string;
  mailboxId: string;
  correlationId: string;
}

/**
 * Main pipeline processor.
 * Stages: EMAIL_RECEIVED -> EMAIL_NORMALIZED -> DATA_EXTRACTED -> DATA_VALIDATED
 *      -> SHOPIFY_ENRICHED -> LOCATION_RESOLVED -> LOCKERS_RESOLVED
 *      -> COURIER_READY -> PAYLOAD_CREATED
 */
export async function processPipelineJob(data: PipelineJobData): Promise<void> {
  const { emailId, tenantId, mailboxId, correlationId } = data;
  const childLog = log.child({ emailId, tenantId, correlationId });

  // Guard: if this job already reached a terminal/paused state, don't re-run
  const db = getDb();
  const existingJob = await db('pipeline_jobs').where({ email_id: emailId, tenant_id: tenantId }).first();
  if (existingJob) {
    const terminalStates = ['completed', 'pending_review', 'rejected'];
    if (terminalStates.includes(existingJob.status)) {
      childLog.info({ jobId: existingJob.id, status: existingJob.status }, 'Pipeline job already in terminal state, skipping retry');
      return; // Don't re-process — BullMQ will mark this attempt as completed
    }
  }

  try {
    // Stage 1: EMAIL_RECEIVED
    childLog.info('Pipeline starting: EMAIL_RECEIVED');
    const jobId = await executeEmailReceived(emailId, tenantId, mailboxId, correlationId);

    // Stage 2: EMAIL_NORMALIZED
    childLog.info('Pipeline stage: EMAIL_NORMALIZED');
    const normalizedEmail = await executeEmailNormalized(jobId);

    // Stage 3: DATA_EXTRACTED (AI)
    childLog.info('Pipeline stage: DATA_EXTRACTED');
    const extractedData = await executeDataExtracted(jobId, normalizedEmail);

    // Stage 4: DATA_VALIDATED
    childLog.info('Pipeline stage: DATA_VALIDATED');
    const validationResult = await executeDataValidated(jobId, extractedData);

    if (!validationResult.valid) {
      childLog.warn({ errors: validationResult.errors }, 'Pipeline stopped: validation failed');
      return;
    }

    // Stage 5: SHOPIFY_ENRICHED (optional - line items only)
    childLog.info('Pipeline stage: SHOPIFY_ENRICHED');
    const enrichmentResult = await executeShopifyEnriched(jobId, tenantId, extractedData);

    // Stage 6: LOCATION_RESOLVED (Google geocoding)
    childLog.info('Pipeline stage: LOCATION_RESOLVED');
    const location = await executeLocationResolved(jobId, extractedData);

    // Stage 7: CUSTOMER_DATA (assemble final customer object)
    childLog.info('Pipeline stage: CUSTOMER_DATA');
    const customerData = await executeCustomerData(jobId, extractedData, location, enrichmentResult);

    // Route: if upload_type is 'manual' or collection_method is 'collection', create a partial order and stop
    if (customerData.upload_type === 'manual' || customerData.collectionMethod === 'collection') {
      const db = await import('../db/connection').then(m => m.getDb());
      const { v4: uuidv4 } = await import('uuid');
      const routingStatus = customerData.collectionMethod === 'collection' ? 'collection' : 'manual_upload';
      const reason = customerData.collectionMethod === 'collection'
        ? 'Collection order — customer picks up'
        : 'Routed to manual upload (ineligible for automatic submission)';

      // Create the order record so it appears in the manual/collection queue
      const existingOrder = await db('orders').where({ tenant_id: tenantId, order_number: customerData.OrderNumber }).first();
      if (!existingOrder) {
        await db('orders').insert({
          id: uuidv4(),
          tenant_id: tenantId,
          email_id: emailId,
          pipeline_job_id: jobId,
          order_number: customerData.OrderNumber,
          customer_name: customerData.customerName,
          customer_phone: customerData.customerPhone,
          delivery_method: customerData.deliverMethod,
          delivery_address: JSON.stringify(customerData.delivery_address),
          line_items: JSON.stringify(customerData.line_items),
          raw_shipping_address: customerData.delivery_address.entered_address,
          upload_type: customerData.upload_type,
          collection_method: customerData.collectionMethod,
          routing_status: routingStatus,
          manual_upload_reason: reason,
          status: routingStatus === 'collection' ? 'awaiting_collection' : 'awaiting_manual_upload',
        });
      }

      await db('pipeline_jobs').where({ id: jobId }).update({
        status: PipelineStatus.COMPLETED,
        current_stage: PipelineStage.CUSTOMER_DATA,
        updated_at: new Date(),
      });
      childLog.info({ orderNumber: customerData.OrderNumber, routingStatus }, 'Pipeline completed (routed to ' + routingStatus + ')');
      return;
    }

    // Stage 8: LOCKERS_RESOLVED (find nearest PUDO locker)
    childLog.info('Pipeline stage: LOCKERS_RESOLVED');
    const lockerResult = await executeLockersResolved(jobId, tenantId, location);

    // Stage 9: PAYLOAD_CREATED (fork: locker-to-door vs locker-to-locker)
    childLog.info({ deliverMethod: customerData.deliverMethod }, 'Pipeline stage: PAYLOAD_CREATED');
    const payload = await executePayloadCreated(jobId, tenantId, customerData, lockerResult);

    // Stage 10: CARETAKER_REVIEW (rules-based pre-flight check)
    childLog.info('Pipeline stage: CARETAKER_REVIEW');
    const review = await executeCaretakerReview(jobId, tenantId, customerData, lockerResult, payload);

    if (review.verdict === 'reject') {
      const db = await import('../db/connection').then(m => m.getDb());
      await db('pipeline_jobs').where({ id: jobId }).update({
        status: PipelineStatus.REJECTED,
        current_stage: PipelineStage.CARETAKER_REVIEW,
        last_error: review.summary,
        updated_at: new Date(),
      });
      childLog.warn({ flags: review.flags, summary: review.summary }, 'Pipeline halted: caretaker rejected');
      return;
    }

    if (review.verdict === 'review') {
      const db = await import('../db/connection').then(m => m.getDb());
      await db('pipeline_jobs').where({ id: jobId }).update({
        status: PipelineStatus.PENDING_REVIEW,
        current_stage: PipelineStage.CARETAKER_REVIEW,
        updated_at: new Date(),
      });
      childLog.info({ flags: review.flags, summary: review.summary }, 'Pipeline paused: caretaker review pending');
      return;
    }

    // Stage 11: COURIER_SUBMITTED (POST payload to shipment API)
    childLog.info('Pipeline stage: COURIER_SUBMITTED');
    const submission = await executeCourierSubmitted(jobId, tenantId, emailId, payload, customerData, lockerResult);

    childLog.info({
      orderNumber: customerData.OrderNumber,
      deliverMethod: customerData.deliverMethod,
      submitted: submission.submitted,
      tracking_reference: submission.tracking_reference,
    }, 'Pipeline completed - shipment submitted');

  } catch (error: any) {
    childLog.error({ error: error.message }, 'Pipeline processing failed');

    try {
      const db = getDb();
      const existingJob = await db('pipeline_jobs')
        .where({ email_id: emailId, tenant_id: tenantId })
        .first();

      if (existingJob) {
        await db('pipeline_jobs').where({ id: existingJob.id }).update({
          status: PipelineStatus.FAILED,
          last_error: error.message,
          updated_at: new Date(),
        });
      }
    } catch (dbError: any) {
      childLog.error({ error: dbError.message }, 'Failed to record pipeline error');
    }

    throw error;
  }
}

export { PipelineStage, PipelineStatus } from './types';

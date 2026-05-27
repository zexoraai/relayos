import { Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { PipelineStage, PipelineStatus } from './types';
import { executeEmailReceived } from './stages/emailReceived';
import { executeEmailNormalized } from './stages/emailNormalized';
import { executeDataExtracted } from './stages/dataExtracted';
import { executeDataValidated } from './stages/dataValidated';
import { executeShopifyEnriched } from './stages/shopifyEnriched';
import { executeLocationResolved } from './stages/locationResolved';
import { executeLocationReconciled } from './stages/locationReconciled';
import { executeCustomerData } from './stages/customerData';
import { executeLockersResolved } from './stages/lockersResolved';
import { executePayloadCreated } from './stages/payloadCreated';
import { executeCaretakerReview } from './stages/caretakerReview';
import { executeCourierSubmitted } from './stages/courierSubmitted';
import { CustomerData } from './stages/customerData';

const log = createChildLogger({ module: 'pipeline' });

export interface PipelineJobData {
  emailId: string;
  tenantId: string;
  mailboxId: string;
  correlationId: string;
}

/**
 * Divert an order into the manual-upload (or collection) queue and stop the
 * pipeline. Used when the order can't be auto-submitted to PUDO — e.g.
 * upload_type explicitly 'manual', collection method is 'collection', or no
 * eligible TCG locker is in range for a *-to-locker delivery method.
 *
 * Idempotent on `orders` (won't duplicate when reprocessing).
 */
async function divertToManualQueue(args: {
  jobId: string;
  tenantId: string;
  emailId: string;
  customerData: CustomerData;
  routingStatus: 'manual_upload' | 'collection';
  reason: string;
}): Promise<void> {
  const { jobId, tenantId, emailId, customerData, routingStatus, reason } = args;
  const db = getDb();

  const existingOrder = await db('orders')
    .where({ tenant_id: tenantId, order_number: customerData.OrderNumber })
    .first();

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
  } else if (existingOrder.routing_status !== routingStatus) {
    // Reprocess of a previously-automatic order that is now ineligible —
    // flip it into the manual queue and tell the operator why.
    await db('orders').where({ id: existingOrder.id }).update({
      routing_status: routingStatus,
      manual_upload_reason: reason,
      status: routingStatus === 'collection' ? 'awaiting_collection' : 'awaiting_manual_upload',
      updated_at: new Date(),
    });
  }

  await db('pipeline_jobs').where({ id: jobId }).update({
    status: PipelineStatus.COMPLETED,
    current_stage: PipelineStage.CUSTOMER_DATA,
    last_error: reason,
    updated_at: new Date(),
  });
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

    // Stage 6.5: LOCATION_RECONCILED (AI fills geocoder gaps)
    //
    // If the geocoder dropped vital fields (suburb / city / postal_code),
    // try a normalized re-geocode and then an LLM reconciliation against
    // the original entered address. The reconciler's output supersedes
    // the partial geocode for downstream stages whenever it merges
    // cleanly, so customerData / lockersResolved / payloadCreated all
    // see the recovered fields. When reconciliation can't confidently
    // recover the address, the original geocode value is kept and the
    // caretaker's address-completeness check still flags the order.
    childLog.info('Pipeline stage: LOCATION_RECONCILED');
    const reconciled = await executeLocationReconciled(jobId, tenantId, location);
    const reconciledLocation = { delivery_address: reconciled.delivery_address };

    // Stage 7: CUSTOMER_DATA (assemble final customer object)
    childLog.info('Pipeline stage: CUSTOMER_DATA');
    const customerData = await executeCustomerData(jobId, extractedData, reconciledLocation, enrichmentResult);

    // Route: if upload_type is 'manual' or collection_method is 'collection', create a partial order and stop
    if (customerData.upload_type === 'manual' || customerData.collectionMethod === 'collection') {
      const routingStatus = customerData.collectionMethod === 'collection' ? 'collection' : 'manual_upload';
      const reason = customerData.collectionMethod === 'collection'
        ? 'Collection order — customer picks up'
        : 'Routed to manual upload (ineligible for automatic submission)';

      await divertToManualQueue({ jobId, tenantId, emailId, customerData, routingStatus, reason });
      childLog.info({ orderNumber: customerData.OrderNumber, routingStatus }, 'Pipeline completed (routed to ' + routingStatus + ')');
      return;
    }

    // Stage 8: LOCKERS_RESOLVED (find nearest PUDO locker)
    childLog.info('Pipeline stage: LOCKERS_RESOLVED');
    const lockerResult = await executeLockersResolved(jobId, tenantId, location);

    // Route: *-to-locker orders that have no eligible TCG locker within range
    // can't be auto-submitted to PUDO. Send them to the manual upload queue
    // so an operator can ship them another way (e.g. via the kiosk, in-person
    // drop, or contact the customer to switch to a door delivery).
    const needsDestinationLocker = (customerData.deliverMethod || '').endsWith('-to-locker');
    if (needsDestinationLocker && (!lockerResult || lockerResult.terminal_id === 'NO_LOCKER_FOUND' || !lockerResult.eligibility)) {
      const reason = `No eligible PUDO locker within range for ${customerData.deliverMethod}. ` +
        `Customer address: ${customerData.delivery_address.entered_address || customerData.delivery_address.suburb || 'unknown'}. ` +
        `Closest distance: ${lockerResult?.distance_km || 'n/a'} km.`;
      await divertToManualQueue({ jobId, tenantId, emailId, customerData, routingStatus: 'manual_upload', reason });
      childLog.warn({ orderNumber: customerData.OrderNumber, reason }, 'Pipeline diverted to manual upload (no eligible locker)');
      return;
    }

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

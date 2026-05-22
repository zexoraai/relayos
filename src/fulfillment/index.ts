import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { FulfillmentStage, FulfillmentJobStatus } from './types';
import { executeTrackingFetched } from './stages/trackingFetched';
import { executeStatusUpdated } from './stages/statusUpdated';
import { executeMilestoneDetected } from './stages/milestoneDetected';
import { executeShopifyFulfilled } from './stages/shopifyFulfilled';
import { executeLifecycleComplete } from './stages/lifecycleComplete';
import { checkShopifyFulfillmentStatus } from './stages/shopifyStatusCheck';

const log = createChildLogger({ module: 'fulfillment' });

/**
 * Ensures a fulfillment job exists for the given order.
 * Returns the job ID.
 */
export async function ensureFulfillmentJob(
  tenantId: string,
  orderId: string,
  waybill: string
): Promise<string> {
  const db = getDb();

  const existing = await db('fulfillment_jobs').where({ order_id: orderId }).first();
  if (existing) return existing.id;

  const jobId = uuidv4();
  await db('fulfillment_jobs').insert({
    id: jobId,
    tenant_id: tenantId,
    order_id: orderId,
    waybill,
    status: FulfillmentJobStatus.ACTIVE,
    current_stage: FulfillmentStage.TRACKING_FETCHED,
    next_poll_at: new Date(), // poll immediately
  });

  log.info({ jobId, orderId, waybill }, 'Fulfillment job created');
  return jobId;
}

/**
 * Runs one cycle of the fulfillment pipeline for a single job.
 */
export async function processFulfillmentJob(jobId: string): Promise<void> {
  const db = getDb();

  const job = await db('fulfillment_jobs').where({ id: jobId }).first();
  if (!job) {
    log.warn({ jobId }, 'Fulfillment job not found');
    return;
  }

  if (job.status !== FulfillmentJobStatus.ACTIVE) {
    log.debug({ jobId, status: job.status }, 'Job is not active, skipping');
    return;
  }

  const childLog = log.child({ jobId, waybill: job.waybill, orderId: job.order_id });

  try {
    childLog.info('Fulfillment cycle starting');

    // Stage 1: TRACKING_FETCHED
    const tracking = await executeTrackingFetched(jobId, job.waybill);

    // Check Shopify fulfillment status (runs every cycle, non-blocking)
    const order = await db('orders').where({ id: job.order_id }).first();
    if (order) {
      await checkShopifyFulfillmentStatus(job.tenant_id, job.order_id, order.order_number);
    }

    // Stage 2: STATUS_UPDATED
    const statusUpdate = await executeStatusUpdated(jobId, job.order_id, tracking);

    // Stage 3: MILESTONE_DETECTED
    const milestoneResult = await executeMilestoneDetected(jobId, job.order_id, statusUpdate.current_status);

    // Stage 4: SHOPIFY_FULFILLED (fires once when milestone reaches IN_TRANSIT)
    const shopifyResult = await executeShopifyFulfilled(jobId, job.tenant_id, job.order_id, milestoneResult.milestone);

    // Stage 5: LIFECYCLE_COMPLETE
    const lifecycle = await executeLifecycleComplete(jobId, milestoneResult.milestone);

    childLog.info({
      milestone: milestoneResult.milestone,
      changed: milestoneResult.changed,
      next_action: lifecycle.next_action,
      newEvents: statusUpdate.new_events,
      shopify_fulfilled: shopifyResult.fulfilled,
    }, 'Fulfillment cycle completed');
  } catch (error: any) {
    childLog.error({ error: error.message }, 'Fulfillment cycle failed');
    await db('fulfillment_jobs').where({ id: jobId }).update({
      last_error: error.message,
      next_poll_at: new Date(Date.now() + 60000), // retry in 1 minute on error
      updated_at: new Date(),
    });
  }
}

export { FulfillmentStage, FulfillmentJobStatus, FulfillmentMilestone } from './types';

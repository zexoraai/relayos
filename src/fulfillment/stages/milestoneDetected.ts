import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { FulfillmentStage, FulfillmentMilestone, mapStatusToMilestone, isTerminalMilestone } from '../types';
import { emitEvent, DomainEventType } from '../../events';

const log = createChildLogger({ module: 'fulfillment:milestone-detected' });

export interface MilestoneResult {
  milestone: FulfillmentMilestone;
  is_terminal: boolean;
  changed: boolean;
  previous_milestone: string | null;
}

/**
 * Stage: MILESTONE_DETECTED
 *
 * Outbox-pattern flow:
 *   1. Compute the milestone from the courier status.
 *   2. Open a transaction.
 *   3. Update fulfillment_jobs + orders.
 *   4. If milestone CHANGED, emit the corresponding domain event in the same trx.
 *   5. Insert fulfillment_stage_results.
 *   6. COMMIT.
 *
 * The event is committed atomically with the milestone update — there's no
 * window where the order shows "delivered" but the customer never gets a WhatsApp.
 */
export async function executeMilestoneDetected(
  jobId: string,
  orderId: string,
  currentStatus: string,
): Promise<MilestoneResult> {
  const db = getDb();

  const job = await db('fulfillment_jobs').where({ id: jobId }).first();
  const previousMilestone = job?.milestone || null;

  const milestone = mapStatusToMilestone(currentStatus);
  const isTerminal = isTerminalMilestone(milestone);
  const changed = previousMilestone !== milestone;

  const result: MilestoneResult = { milestone, is_terminal: isTerminal, changed, previous_milestone: previousMilestone };

  await db.transaction(async (trx) => {
    await trx('fulfillment_jobs').where({ id: jobId }).update({
      current_stage: FulfillmentStage.MILESTONE_DETECTED,
      milestone,
      updated_at: new Date(),
    });

    await trx('orders').where({ id: orderId }).update({
      courier_status: currentStatus,
      status: milestone,
      updated_at: new Date(),
    });

    await trx('fulfillment_stage_results').insert({
      fulfillment_job_id: jobId,
      stage: FulfillmentStage.MILESTONE_DETECTED,
      status: 'completed',
      output_data: JSON.stringify(result),
    });

    if (changed) {
      const eventType = milestoneToEventType(milestone);
      if (eventType) {
        // Read order INSIDE the transaction so the event payload reflects the latest state
        const order = await trx('orders').where({ id: orderId }).first();
        await emitEvent({
          tenantId: order?.tenant_id,
          type: eventType,
          aggregateType: 'order',
          aggregateId: orderId,
          correlationId: jobId,
          payload: {
            milestone,
            previous_milestone: previousMilestone,
            courier_status: currentStatus,
            order_number: order?.order_number,
            waybill: order?.waybill,
            pincode: order?.pincode,
          },
          trx,
        });
      }
    }
  });

  if (changed) {
    log.info({ jobId, orderId, milestone, previous: previousMilestone }, 'Milestone changed (committed)');
  } else {
    log.debug({ jobId, milestone }, 'Milestone unchanged');
  }

  return result;
}

function milestoneToEventType(milestone: FulfillmentMilestone): DomainEventType | null {
  switch (milestone) {
    case FulfillmentMilestone.COLLECTED: return DomainEventType.ORDER_COLLECTED;
    case FulfillmentMilestone.IN_TRANSIT: return DomainEventType.ORDER_IN_TRANSIT;
    case FulfillmentMilestone.AT_LOCKER: return DomainEventType.ORDER_AT_LOCKER;
    case FulfillmentMilestone.OUT_FOR_DELIVERY: return DomainEventType.ORDER_OUT_FOR_DELIVERY;
    case FulfillmentMilestone.DELIVERED: return DomainEventType.ORDER_DELIVERED;
    case FulfillmentMilestone.CANCELLED: return DomainEventType.ORDER_CANCELLED;
    case FulfillmentMilestone.FAILED: return DomainEventType.ORDER_FAILED;
    default: return null;
  }
}

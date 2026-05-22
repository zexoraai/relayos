import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { FulfillmentStage, TrackingResponse, TrackingEvent } from '../types';

const log = createChildLogger({ module: 'fulfillment:status-updated' });

export interface StatusUpdateResult {
  new_events: number;
  total_events: number;
  current_status: string;
}

/**
 * Stage: STATUS_UPDATED
 * Persists new tracking events to the fulfillment_events table.
 * Uses event ID as a dedup key so re-polls don't duplicate.
 */
export async function executeStatusUpdated(
  jobId: string,
  orderId: string,
  tracking: TrackingResponse
): Promise<StatusUpdateResult> {
  const db = getDb();

  const events = tracking.tracking_events || [];
  let newCount = 0;

  for (const event of events) {
    const eventId = String(event.id);
    try {
      await db('fulfillment_events').insert({
        fulfillment_job_id: jobId,
        order_id: orderId,
        event_id: eventId,
        status: event.status,
        message: event.message || null,
        source: event.source || null,
        location: event.location || null,
        event_date: event.date ? new Date(event.date) : null,
      });
      newCount++;
    } catch (error: any) {
      // Unique constraint = duplicate event, skip silently
      if (error.code !== '23505') {
        log.warn({ jobId, eventId, error: error.message }, 'Failed to insert event');
      }
    }
  }

  const currentStatus = String(tracking.status || (events[0]?.status) || 'unknown');

  const result: StatusUpdateResult = {
    new_events: newCount,
    total_events: events.length,
    current_status: currentStatus,
  };

  await db('fulfillment_stage_results').insert({
    fulfillment_job_id: jobId,
    stage: FulfillmentStage.STATUS_UPDATED,
    status: 'completed',
    output_data: JSON.stringify(result),
  });

  await db('fulfillment_jobs').where({ id: jobId }).update({
    current_stage: FulfillmentStage.STATUS_UPDATED,
    courier_status: currentStatus,
    updated_at: new Date(),
  });

  log.info({ jobId, newEvents: newCount, totalEvents: events.length, status: currentStatus }, 'Status updated');

  return result;
}

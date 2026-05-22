export enum FulfillmentStage {
  TRACKING_FETCHED = 'TRACKING_FETCHED',
  STATUS_UPDATED = 'STATUS_UPDATED',
  MILESTONE_DETECTED = 'MILESTONE_DETECTED',
  SHOPIFY_FULFILLED = 'SHOPIFY_FULFILLED',
  LIFECYCLE_COMPLETE = 'LIFECYCLE_COMPLETE',
}

export enum FulfillmentJobStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

export enum FulfillmentMilestone {
  SUBMITTED = 'submitted',
  COLLECTED = 'collected',
  IN_TRANSIT = 'in_transit',
  AT_LOCKER = 'at_locker',
  OUT_FOR_DELIVERY = 'out_for_delivery',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

export interface TrackingEvent {
  id: number | string;
  date: string;
  message: string | null;
  status: string;
  source: string;
  location: string;
}

export interface TrackingResponse {
  shipment_id?: number;
  custom_tracking_reference?: string;
  status: string | false;
  shipment_time_created?: string;
  shipment_time_modified?: string;
  shipment_collected_date?: string | null;
  shipment_delivered_date?: string | null;
  collection_from?: string;
  delivery_to?: any;
  collection_hub?: string;
  delivery_hub?: string;
  service_level_code?: string;
  tracking_events?: TrackingEvent[];
}

/**
 * Maps PUDO courier statuses to internal milestones.
 */
export function mapStatusToMilestone(status: string): FulfillmentMilestone {
  const lower = (status || '').toLowerCase();
  if (lower.includes('delivered')) return FulfillmentMilestone.DELIVERED;
  if (lower.includes('cancel')) return FulfillmentMilestone.CANCELLED;
  if (lower.includes('failed')) return FulfillmentMilestone.FAILED;
  if (lower.includes('out-for-delivery') || lower.includes('out_for_delivery')) return FulfillmentMilestone.OUT_FOR_DELIVERY;
  if (lower.includes('at-locker') || lower.includes('locker')) return FulfillmentMilestone.AT_LOCKER;
  if (lower.includes('transit') || lower.includes('in-transit')) return FulfillmentMilestone.IN_TRANSIT;
  if (lower.includes('collected') || lower.includes('collection')) return FulfillmentMilestone.COLLECTED;
  return FulfillmentMilestone.SUBMITTED;
}

/**
 * Returns true if the milestone is a terminal state (no more polling needed).
 */
export function isTerminalMilestone(milestone: FulfillmentMilestone): boolean {
  return milestone === FulfillmentMilestone.DELIVERED ||
         milestone === FulfillmentMilestone.CANCELLED ||
         milestone === FulfillmentMilestone.FAILED;
}

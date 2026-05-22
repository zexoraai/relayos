export enum PipelineStage {
  EMAIL_RECEIVED = 'EMAIL_RECEIVED',
  EMAIL_NORMALIZED = 'EMAIL_NORMALIZED',
  DATA_EXTRACTED = 'DATA_EXTRACTED',
  DATA_VALIDATED = 'DATA_VALIDATED',
  SHOPIFY_ENRICHED = 'SHOPIFY_ENRICHED',
  LOCATION_RESOLVED = 'LOCATION_RESOLVED',
  CUSTOMER_DATA = 'CUSTOMER_DATA',
  LOCKERS_RESOLVED = 'LOCKERS_RESOLVED',
  PAYLOAD_CREATED = 'PAYLOAD_CREATED',
  CARETAKER_REVIEW = 'CARETAKER_REVIEW',
  COURIER_SUBMITTED = 'COURIER_SUBMITTED',
  COURIER_READY = 'COURIER_READY',
}

export enum PipelineStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  PENDING_REVIEW = 'pending_review',
  REJECTED = 'rejected',
}

export interface PipelineJob {
  id: string;
  tenant_id: string;
  email_id: string;
  mailbox_id: string;
  current_stage: PipelineStage;
  status: PipelineStatus;
  correlation_id: string;
  created_at: Date;
}

export interface NormalizedEmail {
  subject: string;
  from: string;
  to: string;
  date: string;
  text_plain: string;
  text_html: string;
  message_id: string | null;
  metadata: Record<string, any>;
}

export interface ExtractedOrderData {
  order_number: string;
  shipping_address: string;
  delivery_method: string; // locker-to-locker, locker-to-door, door-to-locker, door-to-door
  phone_number: string;
  customer_name: string;
  collection_method: string | null; // null for deliveries, 'collection' for pickups
  upload_type: string; // 'automatic' or 'manual'
  raw_extraction: Record<string, any>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

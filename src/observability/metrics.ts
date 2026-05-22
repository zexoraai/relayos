import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const emailsFetched = new Counter({
  name: 'email_ingestion_fetched_total',
  help: 'Total number of emails fetched from IMAP',
  labelNames: ['mailbox'],
  registers: [registry],
});

export const emailsQueued = new Counter({
  name: 'email_ingestion_queued_total',
  help: 'Total number of emails enqueued for processing',
  labelNames: ['mailbox'],
  registers: [registry],
});

export const emailsProcessed = new Counter({
  name: 'email_ingestion_processed_total',
  help: 'Total number of emails successfully processed',
  labelNames: ['mailbox'],
  registers: [registry],
});

export const emailsFailed = new Counter({
  name: 'email_ingestion_failed_total',
  help: 'Total number of emails that failed processing',
  labelNames: ['mailbox', 'error_type'],
  registers: [registry],
});

export const emailsDuplicate = new Counter({
  name: 'email_ingestion_duplicates_total',
  help: 'Total number of duplicate emails detected',
  labelNames: ['mailbox'],
  registers: [registry],
});

export const emailsDeadLettered = new Counter({
  name: 'email_ingestion_dead_lettered_total',
  help: 'Total number of emails moved to dead letter queue',
  labelNames: ['mailbox'],
  registers: [registry],
});

export const imapConnectionFailures = new Counter({
  name: 'email_ingestion_imap_connection_failures_total',
  help: 'Total number of IMAP connection failures',
  labelNames: ['mailbox'],
  registers: [registry],
});

export const retryAttempts = new Counter({
  name: 'email_ingestion_retry_attempts_total',
  help: 'Total number of retry attempts',
  labelNames: ['mailbox'],
  registers: [registry],
});

export const attachmentFailures = new Counter({
  name: 'email_ingestion_attachment_failures_total',
  help: 'Total number of attachment processing failures',
  labelNames: ['mailbox', 'reason'],
  registers: [registry],
});

export const processingLatency = new Histogram({
  name: 'email_ingestion_processing_duration_seconds',
  help: 'Email processing duration in seconds',
  labelNames: ['mailbox'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'email_ingestion_queue_depth',
  help: 'Current queue depth',
  registers: [registry],
});

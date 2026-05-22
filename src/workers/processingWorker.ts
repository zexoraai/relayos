import { Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { EmailJobData, createProcessingWorker } from '../queue';
import { parseEmail, ParsedEmail } from '../parser';
import { checkDuplicate } from '../dedup';
import { storeAttachment } from '../storage';
import { scanForVirus } from '../security';
import { getDb } from '../db/connection';
import { config } from '../config';
import { createChildLogger } from '../observability/logger';
import {
  emailsProcessed,
  emailsFailed,
  emailsDeadLettered,
  retryAttempts,
  attachmentFailures,
  processingLatency,
} from '../observability/metrics';
import { IngestionError, ErrorType, AttachmentError } from '../errors';
import { ImapClient } from '../imap';
import { enqueuePipelineJob } from '../pipeline/worker';

const log = createChildLogger({ module: 'processing-worker' });

async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { emailId, mailboxId, uid, correlationId, rawSource } = job.data;
  const childLog = log.child({ correlationId, emailId, uid, jobId: job.id });
  const startTime = Date.now();
  const db = getDb();

  childLog.info('Processing email job');

  try {
    // Update status to processing
    await db('ingested_emails')
      .where({ id: emailId })
      .update({ status: 'processing', processing_at: new Date(), updated_at: new Date() });

    // Parse the full email
    if (!rawSource) {
      throw new IngestionError('No raw source available', ErrorType.MALFORMED_EMAIL, false);
    }

    const rawBuffer = Buffer.from(rawSource, 'base64');
    const parsed = await parseEmail(rawBuffer);

    // Double-check deduplication (in case of race conditions between workers)
    const existingDuplicate = await checkDuplicate(
      '', // We already inserted by dedup key
      parsed.contentHash,
      mailboxId
    );

    // Check if this specific email was already processed
    const currentRecord = await db('ingested_emails').where({ id: emailId }).first();
    if (currentRecord?.status === 'processed' || currentRecord?.status === 'duplicate') {
      childLog.info('Email already processed, skipping');
      return;
    }

    // Store full email data
    await db('ingested_emails')
      .where({ id: emailId })
      .update({
        sender: parsed.sender,
        sender_normalized: parsed.senderNormalized,
        recipients: JSON.stringify(parsed.recipients),
        cc: JSON.stringify(parsed.cc),
        bcc: JSON.stringify(parsed.bcc),
        subject: parsed.subject,
        subject_normalized: parsed.subjectNormalized,
        email_date: parsed.date,
        body_text: parsed.bodyText,
        body_html: parsed.bodyHtml,
        headers_json: JSON.stringify(parsed.headers),
        content_hash: parsed.contentHash,
        message_id: parsed.messageId,
        updated_at: new Date(),
      });

    // Process attachments
    await processAttachments(emailId, mailboxId, parsed, correlationId);

    // Mark as processed
    await db('ingested_emails')
      .where({ id: emailId })
      .update({
        status: 'processed',
        processed_at: new Date(),
        updated_at: new Date(),
      });

    emailsProcessed.inc({ mailbox: mailboxId });

    // Auto-trigger pipeline for tenant-matched emails
    await triggerPipelineForEmail(emailId, mailboxId, correlationId, childLog);

    // Mark as read if configured
    if (config.markAsReadOn === 'processed') {
      try {
        const imapClient = new ImapClient(mailboxId);
        await imapClient.connect();
        await imapClient.markAsRead(uid);
        await imapClient.disconnect();
      } catch (imapErr: any) {
        childLog.warn({ error: imapErr.message }, 'Failed to mark email as read');
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    processingLatency.observe({ mailbox: mailboxId }, duration);
    childLog.info({ durationMs: Date.now() - startTime }, 'Email processed successfully');
  } catch (error: any) {
    const duration = (Date.now() - startTime) / 1000;
    processingLatency.observe({ mailbox: mailboxId }, duration);

    childLog.error({ error: error.message, attempt: job.attemptsMade }, 'Email processing failed');

    // Record error
    await db('processing_errors').insert({
      email_id: emailId,
      error_type: error instanceof IngestionError ? error.type : ErrorType.UNKNOWN,
      error_message: error.message,
      stack_trace: error.stack,
      context_json: error instanceof IngestionError ? JSON.stringify(error.context) : null,
      attempt_number: job.attemptsMade + 1,
    });

    // Update email record
    await db('ingested_emails')
      .where({ id: emailId })
      .update({
        status: 'failed',
        retry_count: job.attemptsMade + 1,
        last_error: error.message,
        failed_at: new Date(),
        updated_at: new Date(),
      });

    emailsFailed.inc({ mailbox: mailboxId, error_type: error instanceof IngestionError ? error.type : 'UNKNOWN' });
    retryAttempts.inc({ mailbox: mailboxId });

    // Check if this is the final attempt
    if (job.attemptsMade + 1 >= config.retry.maxRetryCount) {
      await moveToDeadLetter(emailId, mailboxId, job, error);
    }

    // Re-throw for BullMQ retry mechanism
    if (error instanceof IngestionError && !error.retryable) {
      // Non-retryable: move to dead letter immediately
      await moveToDeadLetter(emailId, mailboxId, job, error);
      return; // Don't re-throw, job is done
    }

    throw error;
  }
}

async function processAttachments(
  emailId: string,
  mailboxId: string,
  parsed: ParsedEmail,
  correlationId: string
): Promise<void> {
  const db = getDb();
  const childLog = log.child({ correlationId, emailId });

  for (const attachment of parsed.attachments) {
    try {
      // Check size limit
      if (attachment.size > config.attachment.maxSizeBytes) {
        childLog.warn(
          { filename: attachment.filename, size: attachment.size },
          'Attachment exceeds size limit'
        );
        attachmentFailures.inc({ mailbox: mailboxId, reason: 'too_large' });

        await db('email_attachments').insert({
          email_id: emailId,
          filename: attachment.filename,
          content_type: attachment.contentType,
          size_bytes: attachment.size,
          checksum_sha256: attachment.checksumSha256,
          status: 'rejected',
          error_message: `Attachment exceeds max size of ${config.attachment.maxSizeBytes} bytes`,
        });
        continue;
      }

      // Check MIME type
      if (!config.attachment.allowedMimeTypes.includes(attachment.contentType)) {
        childLog.warn(
          { filename: attachment.filename, contentType: attachment.contentType },
          'Attachment MIME type not allowed'
        );
        attachmentFailures.inc({ mailbox: mailboxId, reason: 'disallowed_type' });

        await db('email_attachments').insert({
          email_id: emailId,
          filename: attachment.filename,
          content_type: attachment.contentType,
          size_bytes: attachment.size,
          checksum_sha256: attachment.checksumSha256,
          status: 'rejected',
          error_message: `MIME type ${attachment.contentType} is not allowed`,
        });
        continue;
      }

      // Virus scan
      const scanResult = await scanForVirus(attachment.content, attachment.filename || 'unnamed');
      if (!scanResult.clean) {
        childLog.warn(
          { filename: attachment.filename, threat: scanResult.threat },
          'Attachment failed virus scan'
        );
        attachmentFailures.inc({ mailbox: mailboxId, reason: 'virus_detected' });

        await db('email_attachments').insert({
          email_id: emailId,
          filename: attachment.filename,
          content_type: attachment.contentType,
          size_bytes: attachment.size,
          checksum_sha256: attachment.checksumSha256,
          status: 'quarantined',
          virus_scan_passed: false,
          error_message: `Virus detected: ${scanResult.threat}`,
        });
        continue;
      }

      // Store attachment
      const storageResult = await storeAttachment(emailId, attachment.filename, attachment.content);

      await db('email_attachments').insert({
        email_id: emailId,
        filename: attachment.filename,
        filename_sanitized: storageResult.storageKey.split('/').pop(),
        content_type: attachment.contentType,
        size_bytes: attachment.size,
        checksum_sha256: attachment.checksumSha256,
        storage_key: storageResult.storageKey,
        status: 'stored',
        virus_scan_passed: true,
      });

      childLog.debug(
        { filename: attachment.filename, storageKey: storageResult.storageKey },
        'Attachment stored'
      );
    } catch (error: any) {
      childLog.error(
        { filename: attachment.filename, error: error.message },
        'Attachment processing failed'
      );
      attachmentFailures.inc({ mailbox: mailboxId, reason: 'processing_error' });

      // Record attachment-level error without crashing the whole email
      await db('email_attachments').insert({
        email_id: emailId,
        filename: attachment.filename,
        content_type: attachment.contentType,
        size_bytes: attachment.size,
        checksum_sha256: attachment.checksumSha256,
        status: 'error',
        error_message: error.message,
      });
    }
  }
}

async function moveToDeadLetter(
  emailId: string,
  mailboxId: string,
  job: Job<EmailJobData>,
  error: Error
): Promise<void> {
  const db = getDb();
  const childLog = log.child({ emailId, mailboxId });

  try {
    await db('dead_letter_jobs').insert({
      email_id: emailId,
      mailbox_id: mailboxId,
      original_queue: config.queue.name,
      job_data: JSON.stringify(job.data),
      final_error: error.message,
      final_error_type: error instanceof IngestionError ? error.type : ErrorType.UNKNOWN,
      total_attempts: job.attemptsMade + 1,
      first_attempted_at: job.processedOn ? new Date(job.processedOn) : new Date(),
    });

    await db('ingested_emails')
      .where({ id: emailId })
      .update({ status: 'dead_lettered', updated_at: new Date() });

    emailsDeadLettered.inc({ mailbox: mailboxId });
    childLog.warn({ totalAttempts: job.attemptsMade + 1 }, 'Email moved to dead letter queue');
  } catch (dlError: any) {
    childLog.error({ error: dlError.message }, 'Failed to move to dead letter queue');
  }
}

/**
 * Find the tenant whose IMAP settings match this mailbox and trigger their pipeline.
 */
async function triggerPipelineForEmail(
  emailId: string,
  mailboxId: string,
  correlationId: string,
  childLog: any
): Promise<void> {
  try {
    const db = getDb();

    // Look up the mailbox to get host/username
    const mailbox = await db('mailboxes').where({ id: mailboxId }).first();
    if (!mailbox) return;

    // Find tenant whose IMAP settings match this mailbox
    const tenantImap = await db('tenant_imap_settings')
      .where({ imap_host: mailbox.host, imap_username: mailbox.username })
      .first();

    if (!tenantImap) {
      childLog.debug({ mailboxId }, 'No tenant matched for pipeline trigger');
      return;
    }

    // Verify tenant is active
    const tenant = await db('tenants').where({ id: tenantImap.tenant_id }).first();
    if (!tenant || tenant.status !== 'active') {
      childLog.debug({ tenantId: tenantImap.tenant_id }, 'Tenant not active, skipping pipeline');
      return;
    }

    // Check if pipeline job already exists for this email
    const existing = await db('pipeline_jobs')
      .where({ email_id: emailId, tenant_id: tenant.id })
      .first();

    if (existing) {
      childLog.debug({ emailId }, 'Pipeline job already exists');
      return;
    }

    // Enqueue pipeline job
    await enqueuePipelineJob({
      emailId,
      tenantId: tenant.id,
      mailboxId,
      correlationId,
    });

    childLog.info({ tenantId: tenant.id, emailId }, 'Pipeline auto-triggered for tenant');
  } catch (error: any) {
    // Don't fail the email processing if pipeline trigger fails
    childLog.warn({ error: error.message }, 'Failed to trigger pipeline (non-fatal)');
  }
}

export function startProcessingWorker() {
  const worker = createProcessingWorker(processEmailJob);
  log.info({ concurrency: config.queue.concurrency }, 'Processing worker started');
  return worker;
}

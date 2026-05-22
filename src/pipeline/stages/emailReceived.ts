import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { PipelineStage, PipelineStatus } from '../types';

const log = createChildLogger({ module: 'pipeline:email-received' });

/**
 * Stage: EMAIL_RECEIVED
 * Creates a pipeline job when a new email is processed by the ingestion worker.
 * This is the entry point into the order fulfillment pipeline.
 */
export async function executeEmailReceived(
  emailId: string,
  tenantId: string,
  mailboxId: string,
  correlationId: string
): Promise<string> {
  const db = getDb();

  // Check if job already exists (idempotent)
  const existing = await db('pipeline_jobs').where({ email_id: emailId, tenant_id: tenantId }).first();
  if (existing) {
    log.debug({ jobId: existing.id, emailId }, 'Pipeline job already exists, reusing');
    return existing.id;
  }

  const jobId = uuidv4();

  await db('pipeline_jobs').insert({
    id: jobId,
    tenant_id: tenantId,
    email_id: emailId,
    mailbox_id: mailboxId,
    current_stage: PipelineStage.EMAIL_RECEIVED,
    status: PipelineStatus.PROCESSING,
    correlation_id: correlationId,
  });

  // Store stage result
  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: PipelineStage.EMAIL_RECEIVED,
    status: PipelineStatus.COMPLETED,
    input_data: JSON.stringify({ email_id: emailId, tenant_id: tenantId }),
    output_data: JSON.stringify({ job_id: jobId }),
  });

  log.info({ jobId, emailId, tenantId, correlationId }, 'Pipeline job created');

  return jobId;
}

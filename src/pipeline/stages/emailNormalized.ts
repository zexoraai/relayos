import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { NormalizedEmail, PipelineStage, PipelineStatus } from '../types';

const log = createChildLogger({ module: 'pipeline:email-normalized' });

/**
 * Stage: EMAIL_NORMALIZED
 * Takes the raw ingested email and normalizes it into a clean structure
 * for downstream processing.
 */
export async function executeEmailNormalized(jobId: string): Promise<NormalizedEmail> {
  const db = getDb();

  const job = await db('pipeline_jobs').where({ id: jobId }).first();
  if (!job) throw new Error(`Pipeline job ${jobId} not found`);

  const email = await db('ingested_emails').where({ id: job.email_id }).first();
  if (!email) throw new Error(`Email ${job.email_id} not found`);

  // Extract and normalize email content
  const normalized: NormalizedEmail = {
    subject: email.subject || '',
    from: email.sender || '',
    to: email.recipients ? (typeof email.recipients === 'string' ? JSON.parse(email.recipients) : email.recipients).join(', ') : '',
    date: email.email_date || email.created_at,
    text_plain: email.body_text || '',
    text_html: email.body_html || '',
    message_id: email.message_id,
    metadata: email.headers_json ? (typeof email.headers_json === 'string' ? JSON.parse(email.headers_json) : email.headers_json) : {},
  };

  // Store normalized data
  await db('pipeline_stage_results').insert({
    pipeline_job_id: jobId,
    stage: PipelineStage.EMAIL_NORMALIZED,
    status: PipelineStatus.COMPLETED,
    input_data: JSON.stringify({ email_id: email.id, subject: email.subject }),
    output_data: JSON.stringify(normalized),
  });

  // Update job stage
  await db('pipeline_jobs').where({ id: jobId }).update({
    current_stage: PipelineStage.EMAIL_NORMALIZED,
    status: PipelineStatus.PROCESSING,
    updated_at: new Date(),
  });

  log.info({ jobId, emailId: email.id, subject: normalized.subject }, 'Email normalized');

  return normalized;
}

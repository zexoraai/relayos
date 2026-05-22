import { getDb } from '../../db/connection';
import { createChildLogger } from '../../observability/logger';
import { FulfillmentStage, FulfillmentJobStatus, FulfillmentMilestone, isTerminalMilestone } from '../types';

const log = createChildLogger({ module: 'fulfillment:lifecycle-complete' });

const POLL_INTERVAL_MS = parseInt(process.env.FULFILLMENT_POLLING_INTERVAL_MS || '300000'); // default 5 min

export interface LifecycleResult {
  next_action: 'continue_polling' | 'complete' | 'cancel';
  next_poll_at: Date | null;
  job_status: FulfillmentJobStatus;
}

/**
 * Stage: LIFECYCLE_COMPLETE
 * Decides if the fulfillment job should keep polling or be marked terminal.
 * Schedules the next poll if continuing.
 */
export async function executeLifecycleComplete(
  jobId: string,
  milestone: FulfillmentMilestone
): Promise<LifecycleResult> {
  const db = getDb();

  const isTerminal = isTerminalMilestone(milestone);
  const now = new Date();

  let result: LifecycleResult;

  if (isTerminal) {
    let jobStatus: FulfillmentJobStatus;
    if (milestone === FulfillmentMilestone.DELIVERED) {
      jobStatus = FulfillmentJobStatus.COMPLETED;
    } else if (milestone === FulfillmentMilestone.CANCELLED) {
      jobStatus = FulfillmentJobStatus.CANCELLED;
    } else {
      jobStatus = FulfillmentJobStatus.FAILED;
    }

    result = {
      next_action: milestone === FulfillmentMilestone.CANCELLED ? 'cancel' : 'complete',
      next_poll_at: null,
      job_status: jobStatus,
    };

    await db('fulfillment_jobs').where({ id: jobId }).update({
      current_stage: FulfillmentStage.LIFECYCLE_COMPLETE,
      status: jobStatus,
      next_poll_at: null,
      completed_at: now,
      updated_at: now,
    });

    log.info({ jobId, milestone, jobStatus }, 'Fulfillment lifecycle complete');
  } else {
    const nextPoll = new Date(now.getTime() + POLL_INTERVAL_MS);

    result = {
      next_action: 'continue_polling',
      next_poll_at: nextPoll,
      job_status: FulfillmentJobStatus.ACTIVE,
    };

    await db('fulfillment_jobs').where({ id: jobId }).update({
      current_stage: FulfillmentStage.LIFECYCLE_COMPLETE,
      status: FulfillmentJobStatus.ACTIVE,
      next_poll_at: nextPoll,
      updated_at: now,
    });

    log.debug({ jobId, milestone, nextPollAt: nextPoll }, 'Fulfillment continues polling');
  }

  await db('fulfillment_stage_results').insert({
    fulfillment_job_id: jobId,
    stage: FulfillmentStage.LIFECYCLE_COMPLETE,
    status: 'completed',
    output_data: JSON.stringify(result),
  });

  // Increment poll count
  await db('fulfillment_jobs').where({ id: jobId }).increment('poll_count', 1);

  return result;
}

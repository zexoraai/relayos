import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { enqueuePipelineJob } from './worker';
import { PipelineStatus } from './types';

const log = createChildLogger({ module: 'pipeline:recovery' });

/**
 * Recovery is disabled for now.
 * Old jobs from previous pipeline versions are not compatible with the current stages.
 */
export async function recoverStalledJobs(): Promise<number> {
  // Disabled — old jobs are not compatible with current pipeline structure
  return 0;
}

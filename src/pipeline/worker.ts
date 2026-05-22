import { Queue, Worker, Job } from 'bullmq';
import { getRedisConnection } from '../queue';
import { config } from '../config';
import { createChildLogger } from '../observability/logger';
import { processPipelineJob, PipelineJobData } from './index';

const log = createChildLogger({ module: 'pipeline-worker' });

const PIPELINE_QUEUE_NAME = 'order-pipeline';

let pipelineQueue: Queue<PipelineJobData> | null = null;

export function getPipelineQueue(): Queue<PipelineJobData> {
  if (!pipelineQueue) {
    pipelineQueue = new Queue<PipelineJobData>(PIPELINE_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: { count: 500 },
        removeOnFail: false,
      },
    });
  }
  return pipelineQueue;
}

/**
 * Enqueue a processed email into the order pipeline.
 */
export async function enqueuePipelineJob(data: PipelineJobData, customJobId?: string): Promise<string> {
  const queue = getPipelineQueue();
  const job = await queue.add('process-order', data, {
    jobId: customJobId || `pipeline-${data.emailId}`,
  });
  log.debug({ jobId: job.id, emailId: data.emailId }, 'Pipeline job enqueued');
  return job.id!;
}

/**
 * Start the pipeline processing worker.
 */
export function startPipelineWorker(): Worker<PipelineJobData> {
  const worker = new Worker<PipelineJobData>(
    PIPELINE_QUEUE_NAME,
    async (job: Job<PipelineJobData>) => {
      log.info({ jobId: job.id, emailId: job.data.emailId }, 'Processing pipeline job');
      await processPipelineJob(job.data);
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
    }
  );

  worker.on('completed', (job) => {
    log.info({ jobId: job.id, emailId: job.data.emailId }, 'Pipeline job completed');
  });

  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, emailId: job?.data.emailId, error: err.message }, 'Pipeline job failed');
  });

  worker.on('error', (err) => {
    log.error({ error: err.message }, 'Pipeline worker error');
  });

  log.info('Pipeline worker started');
  return worker;
}

export async function closePipelineQueue(): Promise<void> {
  if (pipelineQueue) {
    await pipelineQueue.close();
    pipelineQueue = null;
  }
}

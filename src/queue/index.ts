import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'queue' });

let connection: IORedis | null = null;
let emailQueue: Queue | null = null;
let queueEvents: QueueEvents | null = null;

export interface EmailJobData {
  emailId: string;
  mailboxId: string;
  uid: number;
  correlationId: string;
  rawSource?: string;
  attempt: number;
}

export function getRedisConnection(): IORedis {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (url) {
      // Single URL form: redis://[:password@]host:port[/db] (Railway / Upstash style)
      connection = new IORedis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
    } else {
      connection = new IORedis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
    }
  }
  return connection;
}

export function getEmailQueue(): Queue<EmailJobData> {
  if (!emailQueue) {
    emailQueue = new Queue<EmailJobData>(config.queue.name, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: config.retry.maxRetryCount,
        backoff: {
          type: 'exponential',
          delay: config.retry.backoffBaseMs,
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return emailQueue as Queue<EmailJobData>;
}

export function getQueueEvents(): QueueEvents {
  if (!queueEvents) {
    queueEvents = new QueueEvents(config.queue.name, {
      connection: getRedisConnection(),
    });
  }
  return queueEvents;
}

export async function enqueueEmail(data: EmailJobData): Promise<string> {
  const queue = getEmailQueue();
  const job = await queue.add('process-email', data, {
    jobId: `email-${data.emailId}`,
    priority: 1,
  });
  log.debug({ jobId: job.id, emailId: data.emailId }, 'Email job enqueued');
  return job.id!;
}

export function createProcessingWorker(
  processor: (job: Job<EmailJobData>) => Promise<void>
): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>(
    config.queue.name,
    processor,
    {
      connection: getRedisConnection(),
      concurrency: config.queue.concurrency,
      limiter: {
        max: config.queue.concurrency * 2,
        duration: 1000,
      },
    }
  );

  worker.on('completed', (job) => {
    log.debug({ jobId: job.id, emailId: job.data.emailId }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    log.warn(
      { jobId: job?.id, emailId: job?.data.emailId, error: err.message, attempt: job?.attemptsMade },
      'Job failed'
    );
  });

  worker.on('error', (err) => {
    log.error({ error: err.message }, 'Worker error');
  });

  return worker;
}

export async function closeQueue(): Promise<void> {
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }
  if (emailQueue) {
    await emailQueue.close();
    emailQueue = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
  log.info('Queue connections closed');
}

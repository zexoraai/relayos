import { v4 as uuidv4 } from 'uuid';
import { closeDb } from './db/connection';
import { closeQueue } from './queue';
import { initStorage } from './storage';
import { IngestionWorker } from './workers/ingestionWorker';
import { startProcessingWorker } from './workers/processingWorker';
import { startPipelineWorker, closePipelineQueue } from './pipeline/worker';
import { startFulfillmentWorker, stopFulfillmentWorker } from './fulfillment/worker';
import { recoverStalledJobs } from './pipeline/recovery';
import { startMetricsServer, stopMetricsServer } from './observability/metricsServer';
import { startApiServer } from './api';
import { startEventDispatchWorker, stopEventDispatchWorker, startOutboxRelay } from './events';
import { initWhatsApp } from './whatsapp';
import { startMarketingWorker, stopMarketingWorker } from './marketing/worker';
import { logger } from './observability/logger';

/**
 * Process boot modes:
 *   - "api"      : Express API + metrics only. No workers, no pollers.
 *   - "workers"  : All BullMQ workers, IMAP poller, fulfillment poller, outbox relay,
 *                  event dispatcher. No HTTP API.
 *   - "all"      : Everything in one process (dev convenience).
 */
export type BootMode = 'api' | 'workers' | 'all';

const log = logger.child({ module: 'bootstrap' });

interface RunningHandles {
  ingestionWorker: IngestionWorker | null;
  processingWorker: ReturnType<typeof startProcessingWorker> | null;
  pipelineWorker: ReturnType<typeof startPipelineWorker> | null;
  shuttingDown: boolean;
}

const handles: RunningHandles = {
  ingestionWorker: null,
  processingWorker: null,
  pipelineWorker: null,
  shuttingDown: false,
};

export async function startApi(): Promise<void> {
  await initStorage();
  startMetricsServer();
  // Railway / cloud platforms inject PORT — prefer it, then API_PORT, then default
  const apiPort = parseInt(process.env.PORT || process.env.API_PORT || '3001');
  startApiServer(apiPort);
  log.info({ mode: 'api', port: apiPort }, 'API process running');
}

export async function startWorkers(): Promise<void> {
  await initStorage();
  startMetricsServer();

  const mailboxId = uuidv4();
  handles.ingestionWorker = new IngestionWorker(mailboxId);
  try {
    await handles.ingestionWorker.start();
  } catch (error: any) {
    log.error({ error: error.message }, 'Ingestion worker failed to start; will retry on tick');
  }

  handles.processingWorker = startProcessingWorker();
  handles.pipelineWorker = startPipelineWorker();
  startFulfillmentWorker();

  initWhatsApp();
  startEventDispatchWorker();
  startOutboxRelay();
  startMarketingWorker();

  await recoverStalledJobs();

  log.info({ mode: 'workers' }, 'Worker process running');
}

export async function startAll(): Promise<void> {
  await startApi();
  await startWorkers();
  log.info({ mode: 'all' }, 'Combined process running');
}

export async function gracefulShutdown(signal: string): Promise<void> {
  if (handles.shuttingDown) return;
  handles.shuttingDown = true;

  log.info({ signal }, 'Graceful shutdown initiated');
  try {
    if (handles.ingestionWorker) {
      await handles.ingestionWorker.stop();
      log.info('Ingestion worker stopped');
    }
    if (handles.processingWorker) {
      await handles.processingWorker.close();
      log.info('Processing worker stopped');
    }
    if (handles.pipelineWorker) {
      await handles.pipelineWorker.close();
      log.info('Pipeline worker stopped');
    }
    await stopFulfillmentWorker();
    stopMarketingWorker();
    await stopEventDispatchWorker();
    await closeQueue();
    await closePipelineQueue();
    await closeDb();
    await stopMetricsServer();
    log.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error: any) {
    log.error({ error: error.message }, 'Error during shutdown');
    process.exit(1);
  }
}

export function registerProcessHandlers(processName: string): void {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    log.fatal({ processName, error: error.message, stack: error.stack }, 'Uncaught exception');
    gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ processName, reason }, 'Unhandled rejection');
    gracefulShutdown('unhandledRejection');
  });
}

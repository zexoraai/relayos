import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';
import { processFulfillmentJob, ensureFulfillmentJob } from './index';
import { FulfillmentJobStatus } from './types';

const log = createChildLogger({ module: 'fulfillment-worker' });

const WORKER_TICK_MS = parseInt(process.env.FULFILLMENT_WORKER_TICK_MS || '30000'); // check every 30s

let running = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Starts a polling worker that finds active fulfillment jobs due for polling
 * and runs the pipeline on each.
 */
export function startFulfillmentWorker(): void {
  running = true;
  log.info({ tickMs: WORKER_TICK_MS }, 'Fulfillment worker started');
  scheduleTick();
}

export async function stopFulfillmentWorker(): Promise<void> {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  log.info('Fulfillment worker stopped');
}

function scheduleTick(): void {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      await tick();
    } catch (error: any) {
      log.error({ error: error.message }, 'Worker tick error');
    }
    scheduleTick();
  }, WORKER_TICK_MS);
}

async function tick(): Promise<void> {
  const db = getDb();

  // Auto-create fulfillment jobs for any submitted orders that don't have one yet
  const ordersNeedingJobs = await db('orders as o')
    .leftJoin('fulfillment_jobs as fj', 'fj.order_id', 'o.id')
    .whereNotNull('o.waybill')
    .whereNot('o.status', 'cancelled')
    .whereNull('fj.id')
    .select('o.id', 'o.tenant_id', 'o.waybill');

  for (const order of ordersNeedingJobs) {
    try {
      await ensureFulfillmentJob(order.tenant_id, order.id, order.waybill);
    } catch (error: any) {
      log.warn({ orderId: order.id, error: error.message }, 'Failed to auto-create fulfillment job');
    }
  }

  if (ordersNeedingJobs.length > 0) {
    log.info({ count: ordersNeedingJobs.length }, 'Auto-created fulfillment jobs for new orders');
  }

  // Find jobs due for polling
  const dueJobs = await db('fulfillment_jobs')
    .where('status', FulfillmentJobStatus.ACTIVE)
    .where(function() {
      this.whereNull('next_poll_at').orWhere('next_poll_at', '<=', new Date());
    })
    .limit(10)
    .select('id');

  if (dueJobs.length === 0) {
    log.debug('No fulfillment jobs due for polling');
    return;
  }

  log.info({ count: dueJobs.length }, 'Processing due fulfillment jobs');

  for (const job of dueJobs) {
    await processFulfillmentJob(job.id);
  }
}

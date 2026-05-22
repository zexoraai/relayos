import { Queue, Worker, Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { Knex } from 'knex';
import { getDb } from '../db/connection';
import { getRedisConnection } from '../queue';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'events' });

const EVENT_DISPATCH_QUEUE = 'domain-event-dispatch';

/**
 * Canonical domain event types.
 * Add new ones here so consumers (WhatsApp dispatcher, future webhooks) can route on a known set.
 */
export enum DomainEventType {
  // Order lifecycle
  ORDER_RECEIVED = 'order.received',
  ORDER_FLAGGED = 'order.flagged',
  ORDER_CONFIRMED = 'order.confirmed',
  ORDER_COLLECTED = 'order.collected',
  ORDER_IN_TRANSIT = 'order.in_transit',
  ORDER_AT_LOCKER = 'order.at_locker',
  ORDER_OUT_FOR_DELIVERY = 'order.out_for_delivery',
  ORDER_DELIVERED = 'order.delivered',
  ORDER_CANCELLED = 'order.cancelled',
  ORDER_FAILED = 'order.failed',
}

export interface EmitEventInput {
  tenantId: string;
  type: DomainEventType | string;
  aggregateType: 'order' | 'customer' | 'fulfillment_job' | 'pipeline_job' | string;
  aggregateId: string;
  payload?: Record<string, any>;
  correlationId?: string;
  /**
   * If provided, the event row is inserted using this transaction.
   * The Redis enqueue is skipped — the outbox relay worker will pick it up
   * after the transaction commits. This is the *correct* path for atomicity.
   */
  trx?: Knex.Transaction;
}

export interface DomainEventRow {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  correlation_id: string | null;
  payload: any;
  status: 'pending' | 'dispatched' | 'failed' | string;
  dispatch_attempts: number;
  last_error: string | null;
  dispatched_at: Date | null;
  created_at: Date;
}

let dispatchQueue: Queue<{ eventId: string }> | null = null;

function getDispatchQueue(): Queue<{ eventId: string }> {
  if (!dispatchQueue) {
    dispatchQueue = new Queue<{ eventId: string }>(EVENT_DISPATCH_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: false,
      },
    });
  }
  return dispatchQueue;
}

/**
 * Persist a domain event using the OUTBOX pattern.
 *
 * If called WITH a transaction (input.trx):
 *   - The event row is inserted in that transaction.
 *   - No Redis enqueue happens here. The outbox relay worker picks it up
 *     after the transaction commits. Atomic with the parent state change.
 *
 * If called WITHOUT a transaction:
 *   - Inserts the event row immediately, then nudges the BullMQ queue
 *     for fast dispatch. The relay worker is still the safety net.
 *
 * Always returns the event row.
 */
export async function emitEvent(input: EmitEventInput): Promise<DomainEventRow> {
  const id = uuidv4();
  const dbOrTrx: Knex | Knex.Transaction = input.trx || getDb();

  const insert: any = {
    id,
    tenant_id: input.tenantId,
    event_type: input.type,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    correlation_id: input.correlationId || null,
    payload: JSON.stringify(input.payload || {}),
    status: 'pending',
  };

  const [row] = await dbOrTrx('domain_events').insert(insert).returning('*');

  log.info({
    eventId: id,
    tenantId: input.tenantId,
    type: input.type,
    aggregateId: input.aggregateId,
    transactional: !!input.trx,
  }, 'Domain event emitted');

  // Only nudge BullMQ when we're NOT inside a transaction.
  // If we're in a transaction, the row may not yet be visible to the dispatch worker —
  // the relay worker will pick it up after the COMMIT.
  if (!input.trx) {
    try {
      await getDispatchQueue().add('dispatch', { eventId: id }, { jobId: id });
    } catch (err: any) {
      log.warn({ eventId: id, error: err.message }, 'BullMQ enqueue failed (relay will catch up)');
    }
  }

  return row as DomainEventRow;
}

/**
 * Convenience helper for code that already has a transaction.
 */
export async function emitEventInTrx(trx: Knex.Transaction, input: Omit<EmitEventInput, 'trx'>): Promise<DomainEventRow> {
  return emitEvent({ ...input, trx });
}

/**
 * Subscribers — invoked sequentially per event. If one throws, the event is marked failed
 * and retried by the relay (or BullMQ) on a future tick.
 */
export type EventSubscriber = (event: DomainEventRow) => Promise<void>;
const subscribers: Map<string, EventSubscriber[]> = new Map();

export function onEvent(type: DomainEventType | string | '*', handler: EventSubscriber): void {
  const list = subscribers.get(type) || [];
  list.push(handler);
  subscribers.set(type, list);
}

/**
 * Atomically claim an event for dispatch using a SQL UPDATE...RETURNING.
 * Prevents two workers from dispatching the same event in parallel.
 * Returns null if the event is already dispatched or doesn't exist.
 */
async function claimEvent(eventId: string): Promise<DomainEventRow | null> {
  const db = getDb();
  const rows = await db('domain_events')
    .where({ id: eventId })
    .whereIn('status', ['pending', 'failed'])
    .update({
      dispatch_attempts: db.raw('dispatch_attempts + 1'),
      status: 'dispatching',
    })
    .returning('*');
  return (rows[0] as DomainEventRow) || null;
}

async function dispatchEvent(eventId: string): Promise<void> {
  const db = getDb();
  const event = await claimEvent(eventId);
  if (!event) {
    log.debug({ eventId }, 'Event already dispatched or missing - skipping');
    return;
  }

  const handlers = [
    ...(subscribers.get(event.event_type) || []),
    ...(subscribers.get('*') || []),
  ];

  if (handlers.length === 0) {
    await db('domain_events').where({ id: eventId }).update({
      status: 'dispatched',
      dispatched_at: new Date(),
    });
    return;
  }

  try {
    for (const handler of handlers) {
      await handler(event);
    }
    await db('domain_events').where({ id: eventId }).update({
      status: 'dispatched',
      dispatched_at: new Date(),
      last_error: null,
    });
    log.debug({ eventId, type: event.event_type, handlers: handlers.length }, 'Event dispatched');
  } catch (err: any) {
    log.error({ eventId, error: err.message }, 'Event dispatch failed');
    await db('domain_events').where({ id: eventId }).update({
      status: 'failed',
      last_error: err.message,
    });
    throw err;
  }
}

// ====================================================================
// BullMQ-based fast path (low-latency dispatch when Redis is healthy)
// ====================================================================

let dispatchWorker: Worker | null = null;

export function startEventDispatchWorker(): Worker {
  if (dispatchWorker) return dispatchWorker;
  dispatchWorker = new Worker<{ eventId: string }>(
    EVENT_DISPATCH_QUEUE,
    async (job: Job<{ eventId: string }>) => { await dispatchEvent(job.data.eventId); },
    { connection: getRedisConnection(), concurrency: 4 },
  );
  dispatchWorker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, error: err.message }, 'Event dispatch worker job failed');
  });
  log.info('Event dispatch worker started');
  return dispatchWorker;
}

// ====================================================================
// Outbox relay (durable path - polls DB for pending events)
// ====================================================================

let relayInterval: NodeJS.Timeout | null = null;
const RELAY_TICK_MS = parseInt(process.env.OUTBOX_RELAY_TICK_MS || '5000');
const RELAY_BATCH_SIZE = parseInt(process.env.OUTBOX_RELAY_BATCH_SIZE || '50');
const RELAY_MAX_ATTEMPTS = parseInt(process.env.OUTBOX_RELAY_MAX_ATTEMPTS || '10');

/**
 * One sweep of the outbox table: fetch pending events (and failed events
 * under the retry cap), dispatch them through the same handler chain.
 *
 * This is the DURABLE path. Even if Redis was down for the past hour,
 * every committed event will eventually be dispatched.
 */
async function relaySweep(): Promise<void> {
  const db = getDb();
  try {
    const candidates: { id: string }[] = await db('domain_events')
      .whereIn('status', ['pending', 'failed'])
      .where('dispatch_attempts', '<', RELAY_MAX_ATTEMPTS)
      .orderBy('created_at', 'asc')
      .limit(RELAY_BATCH_SIZE)
      .select('id');

    if (candidates.length === 0) return;

    log.debug({ count: candidates.length }, 'Outbox relay sweep');

    for (const row of candidates) {
      try {
        await dispatchEvent(row.id);
      } catch (err: any) {
        // dispatchEvent already logged + marked the row failed. Continue with the next.
      }
    }
  } catch (err: any) {
    log.error({ error: err.message }, 'Outbox relay sweep failed');
  }
}

export function startOutboxRelay(): void {
  if (relayInterval) return;
  log.info({ tickMs: RELAY_TICK_MS, batchSize: RELAY_BATCH_SIZE }, 'Outbox relay started');
  relayInterval = setInterval(() => { relaySweep().catch(() => {}); }, RELAY_TICK_MS);
  // Run immediately on startup so we catch up on anything pending from a previous run
  relaySweep().catch(() => {});
}

export function stopOutboxRelay(): void {
  if (relayInterval) { clearInterval(relayInterval); relayInterval = null; log.info('Outbox relay stopped'); }
}

export async function stopEventDispatchWorker(): Promise<void> {
  stopOutboxRelay();
  if (dispatchWorker) { await dispatchWorker.close(); dispatchWorker = null; }
  if (dispatchQueue) { await dispatchQueue.close(); dispatchQueue = null; }
}

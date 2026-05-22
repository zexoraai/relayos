import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'idempotency' });

/**
 * Idempotency cache for outbound side-effects.
 *
 * Wrap any side-effecting external call (POST to PUDO, POST to Shopify) with `withIdempotency`.
 * The deterministic key guarantees that a second call with the same key short-circuits
 * to the cached response, so retries / replays never duplicate the side-effect.
 *
 *   key:        unique deterministic string. Use makeKey().
 *   ttlMs:      how long the cached response is authoritative (default 24h).
 *   staleAfterMs: how long an in_progress row is trusted before another caller
 *                 may take over (default 60s — handles crashed workers).
 *   fn:         the actual upstream call. Receives the existing row (may be useful)
 *               and returns { response, http_status }.
 */

export type ActionType = 'pudo_shipment' | 'shopify_fulfillment' | 'whatsapp_send' | string;

export interface IdempotencyKeyRow {
  key: string;
  tenant_id: string;
  action_type: ActionType;
  business_key: string;
  status: 'in_progress' | 'completed' | 'failed';
  response: any;
  http_status: number | null;
  error: string | null;
  attempt_count: number;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface IdempotentResult<T> {
  cached: boolean;          // true when we returned a previously-completed response
  response: T;              // the upstream response body
  http_status: number | null;
  attempt_count: number;
}

export class IdempotencyInProgressError extends Error {
  constructor(public readonly key: string) {
    super(`Idempotent call already in progress: ${key}`);
    this.name = 'IdempotencyInProgressError';
  }
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;   // 24h
const DEFAULT_STALE_MS = 60 * 1000;           // 60s

/**
 * Build a stable key from typed parts. NEVER include timestamps — keys must
 * be the same on retry of the same logical operation.
 */
export function makeKey(actionType: ActionType, tenantId: string, businessKey: string): string {
  return `${actionType}:${tenantId}:${businessKey}`;
}

export async function withIdempotency<T = any>(args: {
  key: string;
  tenantId: string;
  actionType: ActionType;
  businessKey: string;
  ttlMs?: number;
  staleAfterMs?: number;
  fn: () => Promise<{ response: T; http_status?: number }>;
}): Promise<IdempotentResult<T>> {
  const db = getDb();
  const ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;
  const staleAfterMs = args.staleAfterMs ?? DEFAULT_STALE_MS;
  const now = Date.now();

  // Step 1: Try to read existing row
  const existing = (await db('idempotency_keys').where({ key: args.key }).first()) as IdempotencyKeyRow | undefined;

  if (existing) {
    const updatedAt = new Date(existing.updated_at).getTime();
    const expiresAt = existing.expires_at ? new Date(existing.expires_at).getTime() : 0;

    // Cached completed response, still authoritative — return it without hitting upstream
    if (existing.status === 'completed' && expiresAt > now) {
      log.info({ key: args.key, attempt: existing.attempt_count }, 'Idempotent cache hit (completed)');
      return {
        cached: true,
        response: existing.response as T,
        http_status: existing.http_status,
        attempt_count: existing.attempt_count,
      };
    }

    // In-progress row that's still fresh — another worker is doing it
    if (existing.status === 'in_progress' && now - updatedAt < staleAfterMs) {
      log.warn({ key: args.key, ageMs: now - updatedAt }, 'Idempotent call already in progress');
      throw new IdempotencyInProgressError(args.key);
    }

    // Otherwise (failed, expired, or stale in_progress): take over.
    // We CAS-update the row to in_progress and bump attempt_count.
    const claimed = await db('idempotency_keys')
      .where({ key: args.key, status: existing.status })
      .where('updated_at', '=', existing.updated_at)
      .update({
        status: 'in_progress',
        attempt_count: db.raw('attempt_count + 1'),
        error: null,
        updated_at: new Date(),
      });
    if (claimed === 0) {
      // Another worker beat us to it. Treat as in-progress collision.
      log.warn({ key: args.key }, 'Idempotent claim CAS failed — another worker took over');
      throw new IdempotencyInProgressError(args.key);
    }
  } else {
    // First attempt — insert in_progress row. The PK uniqueness gives us the lock.
    try {
      await db('idempotency_keys').insert({
        key: args.key,
        tenant_id: args.tenantId,
        action_type: args.actionType,
        business_key: args.businessKey,
        status: 'in_progress',
        attempt_count: 1,
      });
    } catch (e: any) {
      // Race: someone else inserted between our SELECT and INSERT. Re-read and recurse.
      if (e.code === '23505' /* unique_violation */ || /duplicate key/i.test(e.message)) {
        log.warn({ key: args.key }, 'Idempotency insert race — retrying read path');
        return withIdempotency(args);
      }
      throw e;
    }
  }

  // Step 2: Run the actual upstream call
  let result: { response: T; http_status?: number };
  try {
    result = await args.fn();
  } catch (err: any) {
    await db('idempotency_keys').where({ key: args.key }).update({
      status: 'failed',
      error: err.message,
      updated_at: new Date(),
    });
    log.warn({ key: args.key, error: err.message }, 'Idempotent call failed (cached as failed)');
    throw err;
  }

  // Step 3: Cache the success
  const updatedRow = await db('idempotency_keys')
    .where({ key: args.key })
    .update({
      status: 'completed',
      response: JSON.stringify(result.response),
      http_status: result.http_status ?? null,
      error: null,
      expires_at: new Date(Date.now() + ttlMs),
      updated_at: new Date(),
    })
    .returning('attempt_count');

  log.info({
    key: args.key,
    attempt: updatedRow?.[0]?.attempt_count,
    httpStatus: result.http_status,
  }, 'Idempotent call completed');

  return {
    cached: false,
    response: result.response,
    http_status: result.http_status ?? null,
    attempt_count: updatedRow?.[0]?.attempt_count || 1,
  };
}

/**
 * Forget a cached entry. Use sparingly — typically only when you know upstream
 * has been reset (e.g. a manual courier cancellation followed by re-submission).
 */
export async function clearIdempotencyKey(key: string): Promise<void> {
  await getDb()('idempotency_keys').where({ key }).delete();
  log.info({ key }, 'Idempotency key cleared');
}

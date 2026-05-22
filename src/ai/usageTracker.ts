import { getDb } from '../db/connection';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'ai:usage' });

/**
 * Token pricing per model (USD per 1M tokens).
 * Source: https://openai.com/pricing (as of May 2026)
 * Update these when pricing changes.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
};

export interface UsageEntry {
  tenantId?: string | null;
  agent: string;
  model: string;
  promptVersion?: number | null;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  cached?: boolean;
  error?: string | null;
  metadata?: Record<string, any>;
}

/**
 * Calculate cost in USD from token counts and model name.
 */
export function calculateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING[model] || PRICING['gpt-4o-mini'];
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
}

/**
 * Record a single LLM call to the usage log.
 * Fire-and-forget — never blocks the caller, never throws.
 */
export async function trackUsage(entry: UsageEntry): Promise<void> {
  try {
    const db = getDb();
    const cost = calculateCost(entry.model, entry.promptTokens, entry.completionTokens);

    await db('ai_usage_log').insert({
      tenant_id: entry.tenantId || null,
      agent: entry.agent,
      model: entry.model,
      prompt_version: entry.promptVersion || null,
      prompt_tokens: entry.promptTokens,
      completion_tokens: entry.completionTokens,
      total_tokens: entry.promptTokens + entry.completionTokens,
      cost_usd: cost,
      latency_ms: entry.latencyMs,
      success: entry.success,
      cached: entry.cached || false,
      error: entry.error || null,
      metadata: JSON.stringify(entry.metadata || {}),
    });

    log.debug({
      agent: entry.agent,
      model: entry.model,
      tokens: entry.promptTokens + entry.completionTokens,
      cost,
      latencyMs: entry.latencyMs,
    }, 'AI usage tracked');
  } catch (err: any) {
    log.warn({ error: err.message, agent: entry.agent }, 'Failed to track AI usage (non-fatal)');
  }
}

/**
 * Query usage stats for a tenant (or all tenants if null).
 */
export async function getUsageStats(args: {
  tenantId?: string | null;
  since?: Date;
  until?: Date;
  agent?: string;
  groupBy?: 'agent' | 'model' | 'day';
}): Promise<any[]> {
  const db = getDb();
  let q = db('ai_usage_log');

  if (args.tenantId) q = q.where({ tenant_id: args.tenantId });
  if (args.agent) q = q.where({ agent: args.agent });
  if (args.since) q = q.where('created_at', '>=', args.since);
  if (args.until) q = q.where('created_at', '<=', args.until);

  if (args.groupBy === 'agent') {
    return q.select('agent')
      .sum('total_tokens as total_tokens')
      .sum('cost_usd as total_cost')
      .count('id as call_count')
      .avg('latency_ms as avg_latency_ms')
      .groupBy('agent')
      .orderBy('total_cost', 'desc');
  }

  if (args.groupBy === 'model') {
    return q.select('model')
      .sum('total_tokens as total_tokens')
      .sum('cost_usd as total_cost')
      .count('id as call_count')
      .groupBy('model')
      .orderBy('total_cost', 'desc');
  }

  if (args.groupBy === 'day') {
    return q.select(db.raw("date_trunc('day', created_at) as day"))
      .sum('total_tokens as total_tokens')
      .sum('cost_usd as total_cost')
      .count('id as call_count')
      .groupBy('day')
      .orderBy('day', 'desc')
      .limit(30);
  }

  // Default: recent calls
  return q.orderBy('created_at', 'desc').limit(100);
}

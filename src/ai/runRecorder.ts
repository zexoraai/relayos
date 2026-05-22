import { getDb } from '../db/connection';
import { calculateCost } from './usageTracker';
import { createChildLogger } from '../observability/logger';
import { ChatMessage, ToolCall } from './openai';

const log = createChildLogger({ module: 'ai:run-recorder' });

export interface AgentRunInput {
  tenantId?: string | null;
  agent: string;
  model: string;
  promptVersion?: number | null;
  messagesIn: ChatMessage[];
  responseOut: { content: string | null; tool_calls?: ToolCall[] | null; finish_reason?: string };
  toolResults?: Array<{ tool_call_id: string; name: string; result: any }>;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  error?: string | null;
  metadata?: Record<string, any>;
}

/**
 * Record a full agent run snapshot. Fire-and-forget.
 * Returns the run ID so callers can reference it (e.g. for corrections).
 */
export async function recordRun(input: AgentRunInput): Promise<string | null> {
  try {
    const db = getDb();
    const cost = calculateCost(input.model, input.promptTokens, input.completionTokens);

    const [row] = await db('agent_runs').insert({
      tenant_id: input.tenantId || null,
      agent: input.agent,
      model: input.model,
      prompt_version: input.promptVersion || null,
      messages_in: JSON.stringify(input.messagesIn),
      response_out: JSON.stringify(input.responseOut),
      tool_calls: JSON.stringify(input.responseOut.tool_calls || []),
      tool_results: JSON.stringify(input.toolResults || []),
      finish_reason: input.responseOut.finish_reason || null,
      prompt_tokens: input.promptTokens,
      completion_tokens: input.completionTokens,
      cost_usd: cost,
      latency_ms: input.latencyMs,
      success: input.success,
      error: input.error || null,
      metadata: JSON.stringify(input.metadata || {}),
    }).returning('id');

    return row.id;
  } catch (err: any) {
    log.warn({ error: err.message, agent: input.agent }, 'Failed to record agent run (non-fatal)');
    return null;
  }
}

/**
 * Load active corrections for an agent (used to build few-shot examples).
 * Returns the N most recent corrections, ordered oldest-first so the model
 * sees them in chronological learning order.
 */
export async function getActiveCorrections(agent: string, tenantId?: string | null, limit = 5): Promise<Array<{
  original_input: string;
  original_output: string;
  corrected_output: string;
  correction_note: string | null;
}>> {
  const db = getDb();
  let q = db('agent_corrections')
    .where({ agent, active: true })
    .orderBy('created_at', 'desc')
    .limit(limit);
  if (tenantId) q = q.andWhere({ tenant_id: tenantId });

  const rows = await q;
  return rows.reverse(); // oldest first for few-shot ordering
}

/**
 * Build few-shot correction messages to inject into the system prompt.
 * Returns an array of message pairs (user + assistant) that demonstrate
 * the correct behavior based on past corrections.
 */
export function buildCorrectionMessages(corrections: Array<{
  original_input: string;
  corrected_output: string;
  correction_note: string | null;
}>): ChatMessage[] {
  if (corrections.length === 0) return [];

  const messages: ChatMessage[] = [];
  messages.push({
    role: 'system',
    content: `Here are ${corrections.length} examples of correct outputs based on past feedback. Follow these patterns:`,
  });

  for (const c of corrections) {
    messages.push({ role: 'user', content: c.original_input.substring(0, 1000) });
    let assistantContent = c.corrected_output;
    if (c.correction_note) assistantContent += `\n\n(Note: ${c.correction_note})`;
    messages.push({ role: 'assistant', content: assistantContent });
  }

  return messages;
}

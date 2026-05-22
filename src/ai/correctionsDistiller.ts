import { getDb } from '../db/connection';
import { chatCompletion } from './openai';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'ai:distiller' });

/**
 * Corrections Distiller
 *
 * When an agent accumulates more than DISTILL_THRESHOLD corrections,
 * we ask the LLM to summarize them into a concise set of "learned rules"
 * that gets prepended to the system prompt.
 *
 * This scales beyond the 5 few-shot examples limit — 50 corrections become
 * 5-10 clear rules that the model follows consistently.
 *
 * The distilled rules are stored in a `distilled_rules` column on chatbot_settings
 * (per-agent). They're refreshed whenever new corrections accumulate past the threshold.
 */

const DISTILL_THRESHOLD = 10; // distill after this many corrections per agent

export interface DistilledRules {
  agent: string;
  rules: string;
  correction_count: number;
  distilled_at: Date;
}

/**
 * Check if an agent needs distillation and run it if so.
 * Returns the distilled rules string (or null if not enough corrections).
 */
export async function maybeDistill(agent: string, tenantId: string): Promise<string | null> {
  const db = getDb();

  const corrections = await db('agent_corrections')
    .where({ agent, tenant_id: tenantId, active: true })
    .orderBy('created_at', 'asc')
    .select('original_input', 'original_output', 'corrected_output', 'correction_note');

  if (corrections.length < DISTILL_THRESHOLD) return null;

  // Check if we already distilled recently (within last 24h with same count)
  const settings = await db('chatbot_settings').where({ tenant_id: tenantId }).first();
  const existingRules = settings?.distilled_rules;
  if (existingRules) {
    try {
      const parsed = JSON.parse(existingRules);
      if (parsed[agent]?.correction_count === corrections.length) {
        return parsed[agent]?.rules || null; // Already distilled with same count
      }
    } catch {}
  }

  // Distill corrections into rules
  const correctionSummary = corrections.map((c: any, i: number) =>
    `${i + 1}. Input: "${(c.original_input || '').substring(0, 200)}"\n   Wrong output: "${(c.original_output || '').substring(0, 200)}"\n   Correct output: "${(c.corrected_output || '').substring(0, 200)}"${c.correction_note ? '\n   Note: ' + c.correction_note : ''}`
  ).join('\n\n');

  try {
    const result = await chatCompletion({
      agent: 'distiller',
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: 'You are a rules extractor. Given a list of corrections (wrong outputs and their correct versions), extract 5-10 clear, actionable rules that the AI agent should follow. Rules should be specific and concrete. Format as a numbered list.',
        },
        {
          role: 'user',
          content: `Here are ${corrections.length} corrections for the "${agent}" agent. Extract the patterns into clear rules:\n\n${correctionSummary.substring(0, 4000)}`,
        },
      ],
    });

    const rules = (result.content || '').trim();
    if (!rules) return null;

    // Store the distilled rules
    const allRules = existingRules ? JSON.parse(existingRules) : {};
    allRules[agent] = { rules, correction_count: corrections.length, distilled_at: new Date().toISOString() };

    if (settings) {
      await db('chatbot_settings').where({ tenant_id: tenantId }).update({
        distilled_rules: JSON.stringify(allRules),
        updated_at: new Date(),
      });
    }

    log.info({ agent, tenantId, correctionCount: corrections.length, rulesLength: rules.length }, 'Corrections distilled into rules');
    return rules;
  } catch (err: any) {
    log.warn({ agent, error: err.message }, 'Distillation failed');
    return null;
  }
}

/**
 * Get the distilled rules for an agent (if they exist).
 * Returns null if no distillation has happened yet.
 */
export async function getDistilledRules(agent: string, tenantId: string): Promise<string | null> {
  const db = getDb();
  const settings = await db('chatbot_settings').where({ tenant_id: tenantId }).first();
  if (!settings?.distilled_rules) return null;
  try {
    const parsed = JSON.parse(settings.distilled_rules);
    return parsed[agent]?.rules || null;
  } catch {
    return null;
  }
}

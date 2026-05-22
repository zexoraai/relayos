import { chatCompletion, parseJsonSafe } from '../ai/openai';
import { chatCompletionValidated } from '../ai/validatedCompletion';
import { getCurrentPrompt } from '../ai/promptRegistry';
import { z } from 'zod';
import { createChildLogger } from '../observability/logger';
import { CustomerData } from '../pipeline/stages/customerData';
import { LockersResolvedResult } from '../pipeline/stages/lockersResolved';
import { PudoPayload } from '../pipeline/stages/payloadCreated';

const log = createChildLogger({ module: 'caretaker:llm' });

const llmCaretakerSchema = z.object({
  verdict: z.enum(['approve', 'review', 'reject']),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).default([]),
  flags: z.array(z.string()).default([]),
  summary: z.string().default(''),
});

export interface LlmCaretakerResult {
  ran: boolean;
  verdict: 'approve' | 'review' | 'reject';
  confidence: number;        // 0..1
  reasons: string[];
  flags: string[];
  summary: string;
  skipped_reason?: string;
}

/**
 * Reasoning-based caretaker pass.
 * Runs *after* the rules check and looks at the full picture: does the address
 * make sense for the chosen delivery method? Does the locker name match the
 * suburb? Are line items plausibly priced? Are there red flags in the customer name?
 *
 * The LLM evaluator is intentionally conservative — it never *upgrades* a review
 * to an approve, only ever flags additional concerns.
 */
export async function llmEvaluate(args: {
  customerData: CustomerData;
  locker: LockersResolvedResult;
  payload: PudoPayload;
  rulesVerdict: 'approve' | 'review' | 'reject';
  rulesFlags: string[];
}): Promise<LlmCaretakerResult> {
  if (!process.env.OPENAI_API_KEY) {
    return { ran: false, verdict: args.rulesVerdict, confidence: 0, reasons: [], flags: [], summary: '', skipped_reason: 'OPENAI_API_KEY not configured' };
  }

  const systemPrompt = getCurrentPrompt('caretaker-llm');

  const userPayload = {
    rules_already_flagged: args.rulesFlags,
    rules_verdict: args.rulesVerdict,
    order: {
      order_number: args.customerData.OrderNumber,
      customer_name: args.customerData.customerName,
      customer_phone: args.customerData.customerPhone,
      delivery_method: args.customerData.deliverMethod,
      delivery_address: args.customerData.delivery_address,
      line_items: args.customerData.line_items,
    },
    locker: {
      terminal_id: args.locker.terminal_id,
      name: args.locker.nearest_locker_name,
      distance_km: args.locker.distance_km,
      eligibility: args.locker.eligibility,
    },
    courier_payload: {
      collection_terminal_id: args.payload.collection_address?.terminal_id,
      service_level_code: args.payload.service_level_code,
      delivery_address: args.payload.delivery_address,
      delivery_contact: args.payload.delivery_contact,
    },
  };

  try {
    const { data: parsed, attempts } = await chatCompletionValidated({
      schema: llmCaretakerSchema,
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Evaluate this order. Return JSON only.\n\n' + JSON.stringify(userPayload, null, 2) },
      ],
      context: { module: 'caretaker-llm' },
    });
    if (attempts > 1) log.info({ attempts }, 'Caretaker LLM needed schema-correction retry');

    return {
      ran: true,
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      reasons: parsed.reasons.slice(0, 8),
      flags: parsed.flags.slice(0, 8),
      summary: parsed.summary,
    };
  } catch (err: any) {
    log.warn({ error: err.message }, 'LLM caretaker call failed; falling through');
    return { ran: false, verdict: args.rulesVerdict, confidence: 0, reasons: [], flags: [], summary: '', skipped_reason: err.message };
  }
}

/**
 * Combine rules verdict and LLM verdict.
 * The LLM can only escalate (approve -> review, review -> reject), never relax.
 */
export function mergeVerdicts(
  rules: 'approve' | 'review' | 'reject',
  llm: 'approve' | 'review' | 'reject',
): 'approve' | 'review' | 'reject' {
  if (rules === 'reject' || llm === 'reject') return 'reject';
  if (rules === 'review' || llm === 'review') return 'review';
  return 'approve';
}

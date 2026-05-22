import { chatCompletion, parseJsonSafe } from '../ai/openai';
import { chatCompletionValidated } from '../ai/validatedCompletion';
import { getCurrentPrompt } from '../ai/promptRegistry';
import { z } from 'zod';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'chatbot:router' });

export type Intent = 'order_support' | 'tenant_info' | 'small_talk' | 'human_handoff' | 'unknown';

// Loaded from prompts/intent-router/v{n}.md
function getSystemPrompt(): string {
  try { return getCurrentPrompt('intent-router'); }
  catch { return 'Classify the message intent as one of: order_support, tenant_info, small_talk, human_handoff, unknown. Return JSON: { "intent": "...", "confidence": 0-1, "reason": "..." }'; }
}

const intentSchema = z.object({
  intent: z.enum(['order_support', 'tenant_info', 'small_talk', 'human_handoff', 'unknown']),
  confidence: z.number().min(0).max(1).default(0.6),
  reason: z.string().default(''),
});

export async function classifyIntent(message: string, lastIntent?: string | null): Promise<{ intent: Intent; confidence: number; reason: string }> {
  if (!message || message.trim().length === 0) {
    return { intent: 'unknown', confidence: 1, reason: 'empty message' };
  }

  // Cheap heuristic first — saves a round trip on obvious cases
  const lower = message.toLowerCase().trim();
  if (/^(hi|hello|hey|howzit|good (morning|afternoon|evening)|sawubona)\b/i.test(lower) && lower.length < 25) {
    return { intent: 'small_talk', confidence: 0.95, reason: 'pure greeting' };
  }
  if (/(speak to|talk to|need|want).*(human|agent|person|someone)/i.test(lower)) {
    return { intent: 'human_handoff', confidence: 0.95, reason: 'explicit handoff request' };
  }

  try {
    const { data } = await chatCompletionValidated({
      schema: intentSchema,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: 'system', content: getSystemPrompt() },
        { role: 'user', content: `Last intent for this customer: ${lastIntent || 'none'}\n\nMessage:\n${message}` },
      ],
      context: { module: 'intent-router' },
    });
    return data;
  } catch (err: any) {
    log.warn({ error: err.message }, 'Intent classification failed; defaulting to unknown');
    return { intent: 'unknown', confidence: 0, reason: 'classifier_error' };
  }
}

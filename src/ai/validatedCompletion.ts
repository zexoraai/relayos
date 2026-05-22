import { ZodSchema } from 'zod';
import { chatCompletion, parseJsonSafe, ChatMessage } from './openai';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'ai:validated' });

/**
 * Run a JSON-mode chat completion and validate the parsed output against a Zod schema.
 * On validation failure, retries ONCE with a feedback message describing what was wrong.
 *
 * This replaces "ask the LLM nicely and hope" with "ask the LLM, validate, correct, accept".
 *
 * Returns the parsed-and-validated object, or throws if both attempts fail.
 */
export async function chatCompletionValidated<T>(args: {
  schema: ZodSchema<T>;
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  maxRetries?: number;
  context?: Record<string, any>;
  // Tracking
  agent?: string;
  tenantId?: string | null;
  promptVersion?: number | null;
}): Promise<{ data: T; attempts: number; raw: string }> {
  const maxRetries = args.maxRetries ?? 1;
  let attempts = 0;
  let lastValidationError: string | null = null;
  const baseMessages = [...args.messages];

  while (attempts <= maxRetries) {
    attempts++;

    const messages = [...baseMessages];
    if (lastValidationError) {
      messages.push({
        role: 'user',
        content: `Your last response failed schema validation with: ${lastValidationError}\n\nReturn ONLY valid JSON matching the required schema. No prose, no markdown.`,
      });
    }

    const result = await chatCompletion({
      jsonMode: true,
      temperature: args.temperature ?? 0.1,
      max_tokens: args.max_tokens ?? 800,
      model: args.model,
      messages,
      agent: args.agent || args.context?.module || 'unknown',
      tenantId: args.tenantId,
      promptVersion: args.promptVersion,
    });

    const raw = result.content || '';
    const parsed = parseJsonSafe(raw);
    if (!parsed) {
      lastValidationError = 'Response was not valid JSON';
      log.warn({ attempt: attempts, ...args.context }, lastValidationError);
      continue;
    }

    const validation = args.schema.safeParse(parsed);
    if (validation.success) {
      log.info({ attempt: attempts, ...args.context }, 'LLM output validated');
      return { data: validation.data, attempts, raw };
    }

    // Build a concise, actionable error message for the model
    lastValidationError = validation.error.issues
      .map((i) => `${i.path.join('.') || '_root'}: ${i.message}`)
      .slice(0, 5)
      .join('; ');
    log.warn({ attempt: attempts, validationError: lastValidationError, ...args.context }, 'LLM output failed schema');
  }

  throw new Error(`LLM output failed validation after ${attempts} attempts: ${lastValidationError}`);
}

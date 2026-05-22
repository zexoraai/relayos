import { LLMProvider, LLMCompletionRequest, LLMCompletionResponse } from './types';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { createChildLogger } from '../../observability/logger';

const log = createChildLogger({ module: 'ai:providers' });

/**
 * Provider router with automatic fallback.
 *
 * Priority order (configurable via LLM_PROVIDER_ORDER env var):
 *   1. OpenAI (default primary)
 *   2. Anthropic (fallback)
 *
 * Fallback triggers:
 *   - Provider not configured (no API key)
 *   - HTTP 5xx from the provider
 *   - Rate limit (429)
 *   - Timeout
 *   - Network error
 *
 * Does NOT fall back on:
 *   - 4xx errors (bad request, auth failure) — those are our fault, not the provider's
 */

const allProviders: LLMProvider[] = [
  new OpenAIProvider(),
  new AnthropicProvider(),
];

function getProviderOrder(): LLMProvider[] {
  const order = (process.env.LLM_PROVIDER_ORDER || 'openai,anthropic').split(',').map((s) => s.trim());
  const ordered: LLMProvider[] = [];
  for (const name of order) {
    const p = allProviders.find((pr) => pr.name === name);
    if (p && p.isConfigured()) ordered.push(p);
  }
  // If nothing is configured, still include OpenAI so we get a clear error
  if (ordered.length === 0) ordered.push(allProviders[0]);
  return ordered;
}

function shouldFallback(error: Error): boolean {
  const msg = error.message || '';
  // 5xx, 429, timeout, network errors → try next provider
  if (/5\d\d/.test(msg)) return true;
  if (/429/.test(msg)) return true;
  if (/timeout/i.test(msg)) return true;
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(msg)) return true;
  return false;
}

/**
 * Execute a completion request with automatic provider fallback.
 * Returns the response from whichever provider succeeded first.
 */
export async function completeWithFallback(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
  const providers = getProviderOrder();
  let lastError: Error | null = null;

  for (const provider of providers) {
    try {
      const response = await provider.complete(req);
      if (providers.indexOf(provider) > 0) {
        log.info({ provider: provider.name }, 'Fallback provider succeeded');
      }
      return response;
    } catch (err: any) {
      lastError = err;
      log.warn({ provider: provider.name, error: err.message }, 'Provider failed');

      if (!shouldFallback(err)) {
        // 4xx or other non-retriable error — don't try next provider
        throw err;
      }
      // Continue to next provider
    }
  }

  throw lastError || new Error('All LLM providers failed');
}

export { LLMProvider, LLMCompletionRequest, LLMCompletionResponse } from './types';

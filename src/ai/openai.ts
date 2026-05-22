import https from 'https';
import { trackUsage } from './usageTracker';
import { recordRun } from './runRecorder';
import { completeWithFallback } from './providers';

/**
 * Shared OpenAI Chat Completions client.
 * Centralizes the model name, API key, JSON-mode handling, and tool-call support
 * so every agent in the system uses the same plumbing.
 * Automatically tracks token usage + cost via usageTracker.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  jsonMode?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  // Usage tracking context
  agent?: string;
  tenantId?: string | null;
  promptVersion?: number | null;
  // Provider fallback: if true, uses the provider router with automatic failover
  useFallback?: boolean;
}

export interface ChatCompletionResult {
  content: string | null;
  tool_calls: ToolCall[] | null;
  finish_reason: string;
  raw: any;
}

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY environment variable is required');
  return key;
}

function getModel(): string {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

export async function chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const apiKey = getApiKey();
  const model = opts.model || getModel();
  const startTime = Date.now();

  // If fallback is enabled, use the provider router instead of direct OpenAI call
  if (opts.useFallback || process.env.LLM_FALLBACK_ENABLED === 'true') {
    try {
      const response = await completeWithFallback({
        messages: opts.messages as any,
        model,
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        jsonMode: opts.jsonMode,
        tools: opts.tools as any,
        tool_choice: opts.tool_choice as any,
      });

      const latencyMs = Date.now() - startTime;
      const result: ChatCompletionResult = {
        content: response.content,
        tool_calls: response.tool_calls as any,
        finish_reason: response.finish_reason,
        raw: response.raw,
      };

      trackUsage({
        tenantId: opts.tenantId || null,
        agent: opts.agent || 'unknown',
        model: response.model,
        promptVersion: opts.promptVersion || null,
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        latencyMs,
        success: true,
      }).catch(() => {});

      recordRun({
        tenantId: opts.tenantId || null,
        agent: opts.agent || 'unknown',
        model: response.model,
        promptVersion: opts.promptVersion || null,
        messagesIn: opts.messages,
        responseOut: { content: response.content, tool_calls: response.tool_calls as any, finish_reason: response.finish_reason },
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        latencyMs,
        success: true,
        metadata: { provider: response.provider },
      }).catch(() => {});

      return result;
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      trackUsage({ tenantId: opts.tenantId || null, agent: opts.agent || 'unknown', model, promptVersion: opts.promptVersion || null, promptTokens: 0, completionTokens: 0, latencyMs, success: false, error: err.message }).catch(() => {});
      recordRun({ tenantId: opts.tenantId || null, agent: opts.agent || 'unknown', model, promptVersion: opts.promptVersion || null, messagesIn: opts.messages, responseOut: { content: null, finish_reason: 'error' }, promptTokens: 0, completionTokens: 0, latencyMs, success: false, error: err.message }).catch(() => {});
      throw err;
    }
  }

  // Direct OpenAI path (original behavior)

  const body: any = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.max_tokens ?? 800,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.tool_choice ?? 'auto';
  }

  const payload = JSON.stringify(body);

  const result = await new Promise<ChatCompletionResult>((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`OpenAI ${res.statusCode}: ${data.substring(0, 300)}`));
        }
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) return reject(new Error('OpenAI returned no choices'));
          resolve({
            content: choice.message?.content ?? null,
            tool_calls: choice.message?.tool_calls || null,
            finish_reason: choice.finish_reason || 'stop',
            raw: parsed,
          });
        } catch (e: any) {
          reject(new Error(`Failed to parse OpenAI response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI request timed out')); });
    req.write(payload);
    req.end();
  });

  // Track usage (fire-and-forget, never blocks)
  const latencyMs = Date.now() - startTime;
  const usage = result.raw?.usage;
  trackUsage({
    tenantId: opts.tenantId || null,
    agent: opts.agent || 'unknown',
    model,
    promptVersion: opts.promptVersion || null,
    promptTokens: usage?.prompt_tokens || 0,
    completionTokens: usage?.completion_tokens || 0,
    latencyMs,
    success: true,
    metadata: {},
  }).catch(() => {});

  // Record full run snapshot for replay + corrections
  recordRun({
    tenantId: opts.tenantId || null,
    agent: opts.agent || 'unknown',
    model,
    promptVersion: opts.promptVersion || null,
    messagesIn: opts.messages,
    responseOut: {
      content: result.content,
      tool_calls: result.tool_calls,
      finish_reason: result.finish_reason,
    },
    promptTokens: usage?.prompt_tokens || 0,
    completionTokens: usage?.completion_tokens || 0,
    latencyMs,
    success: true,
  }).catch(() => {});

  return result;
}

/**
 * Convenience helper: stripped JSON parsing tolerant of markdown code fences.
 */
export function parseJsonSafe<T = any>(text: string | null): T | null {
  if (!text) return null;
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  }
  try { return JSON.parse(s) as T; } catch { return null; }
}

import https from 'https';
import { LLMProvider, LLMCompletionRequest, LLMCompletionResponse, LLMMessage } from './types';

/**
 * Anthropic provider — wraps the Messages API.
 * Falls back here when OpenAI is down or rate-limited.
 *
 * Requires ANTHROPIC_API_KEY in .env.
 * Default model: claude-3-haiku-20240307 (fast + cheap, good fallback).
 */
export class AnthropicProvider implements LLMProvider {
  name = 'anthropic';

  isConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const apiKey = process.env.ANTHROPIC_API_KEY!;
    const model = req.model || process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307';

    // Anthropic uses a different message format: system is a top-level field, not a message
    const systemMsg = req.messages.find((m) => m.role === 'system');
    const nonSystemMsgs = req.messages.filter((m) => m.role !== 'system');

    // Convert tool messages to assistant/user pairs (Anthropic doesn't have tool role in same way)
    const messages = nonSystemMsgs.map((m) => ({
      role: m.role === 'tool' ? 'user' as const : m.role as 'user' | 'assistant',
      content: m.content || '',
    }));

    const body: any = {
      model,
      max_tokens: req.max_tokens || 800,
      messages,
    };
    if (systemMsg?.content) body.system = systemMsg.content;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const payload = JSON.stringify(body);
    const result = await this.post(apiKey, payload);

    const textBlock = result.content?.find((b: any) => b.type === 'text');

    return {
      content: textBlock?.text ?? null,
      tool_calls: null, // Anthropic tool use has a different shape; not wired for fallback
      finish_reason: result.stop_reason || 'end_turn',
      usage: {
        prompt_tokens: result.usage?.input_tokens || 0,
        completion_tokens: result.usage?.output_tokens || 0,
        total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
      },
      model,
      provider: this.name,
      raw: result,
    };
  }

  private post(apiKey: string, payload: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Anthropic ${res.statusCode}: ${data.substring(0, 300)}`));
          try { resolve(JSON.parse(data)); }
          catch (e: any) { reject(new Error(`Anthropic parse error: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Anthropic timeout')); });
      req.write(payload);
      req.end();
    });
  }
}

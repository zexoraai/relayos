import https from 'https';
import { LLMProvider, LLMCompletionRequest, LLMCompletionResponse } from './types';

/**
 * OpenAI provider — wraps the Chat Completions API.
 */
export class OpenAIProvider implements LLMProvider {
  name = 'openai';

  isConfigured(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const apiKey = process.env.OPENAI_API_KEY!;
    const model = req.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const body: any = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.1,
      max_tokens: req.max_tokens ?? 800,
    };
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = req.tool_choice ?? 'auto';
    }

    const payload = JSON.stringify(body);
    const result = await this.post(apiKey, payload);
    const choice = result.choices?.[0];

    return {
      content: choice?.message?.content ?? null,
      tool_calls: choice?.message?.tool_calls || null,
      finish_reason: choice?.finish_reason || 'stop',
      usage: {
        prompt_tokens: result.usage?.prompt_tokens || 0,
        completion_tokens: result.usage?.completion_tokens || 0,
        total_tokens: result.usage?.total_tokens || 0,
      },
      model,
      provider: this.name,
      raw: result,
    };
  }

  private post(apiKey: string, payload: string): Promise<any> {
    return new Promise((resolve, reject) => {
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
          if (res.statusCode !== 200) return reject(new Error(`OpenAI ${res.statusCode}: ${data.substring(0, 300)}`));
          try { resolve(JSON.parse(data)); }
          catch (e: any) { reject(new Error(`OpenAI parse error: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI timeout')); });
      req.write(payload);
      req.end();
    });
  }
}

/**
 * Provider-agnostic types for the LLM abstraction layer.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LLMToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, any> };
}

export interface LLMCompletionRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  jsonMode?: boolean;
  tools?: LLMToolDef[];
  tool_choice?: string | object;
}

export interface LLMCompletionResponse {
  content: string | null;
  tool_calls: LLMToolCall[] | null;
  finish_reason: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
  provider: string;
  raw: any;
}

export interface LLMProvider {
  name: string;
  isConfigured(): boolean;
  complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse>;
}

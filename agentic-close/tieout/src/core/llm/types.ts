/**
 * Provider-neutral LLM contract. Content blocks are kept opaque (`raw`) so provider-specific
 * blocks (thinking, fallback markers) round-trip unchanged — the transcript is append-only.
 */
export type JsonSchema = { [key: string]: unknown };

export interface LlmToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  strict?: boolean;
}

export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [key: string]: unknown };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmBlock[];
}

export interface LlmRequest {
  model: string;
  system: string;
  tools: LlmToolSpec[];
  messages: LlmMessage[];
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  content: LlmBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'stop_sequence' | string;
  stopDetails?: { category?: string | null; explanation?: string | null } | null;
  usage: LlmUsage;
  model: string;
}

export interface LlmProvider {
  readonly id: string;
  readonly live: boolean;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$; domain tools use dots. */
export function toWireToolName(name: string): string {
  return name.replace(/\./g, '__');
}

export function fromWireToolName(name: string): string {
  return name.replace(/__/g, '.');
}

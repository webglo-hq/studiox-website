import type Anthropic from '@anthropic-ai/sdk';

/**
 * Provider-neutral LLM types, model catalog, pricing and usage accounting. Pure: no SDK runtime import, so the
 * runtime (and the browser demo bundle) can use it without pulling in a network client.
 */

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type BetaTool = Anthropic.Beta.Messages.BetaTool;
export type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
export type BetaTextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;

export const SUPPORTED_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type ModelId = (typeof SUPPORTED_MODELS)[number];
export const DEFAULT_MODEL: ModelId = 'claude-opus-5-5';

/** USD per million tokens. */
const PRICING: Record<ModelId, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicros: number;
}

export function usageOf(model: string, u: BetaMessage['usage'] | undefined): Usage {
  const price = PRICING[(SUPPORTED_MODELS as readonly string[]).includes(model) ? (model as ModelId) : DEFAULT_MODEL];
  const inputTokens = u?.input_tokens ?? 0;
  const outputTokens = u?.output_tokens ?? 0;
  const cacheReadTokens = u?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = u?.cache_creation_input_tokens ?? 0;
  const usd = (inputTokens * price.input + outputTokens * price.output + cacheReadTokens * price.cacheRead + cacheWriteTokens * price.cacheWrite) / 1_000_000;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsdMicros: Math.round(usd * 1_000_000) };
}

export interface LlmTurnRequest {
  system: BetaTextBlockParam[];
  tools: BetaTool[];
  messages: BetaMessageParam[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface LlmClient {
  readonly provider: 'anthropic';
  readonly model: ModelId;
  readonly fallbacks: boolean;
  turn(req: LlmTurnRequest, signal?: AbortSignal): Promise<BetaMessage>;
}


/** Plain-English description of an API failure (duck-typed so this module never imports the SDK at runtime). */
export function describeApiError(e: unknown): string {
  const err = e as { status?: number; name?: string; message?: string } | null;
  const status = err?.status;
  if (status === 429) return 'Claude API rate limit reached; try again shortly.';
  if (status === 401) return 'Claude API key was rejected (401).';
  if (status === 403) return 'Claude API key lacks permission for this model (403).';
  if (status === 400) return `Claude API rejected the request (400): ${err?.message ?? ''}`;
  if (status && status >= 500) return 'Claude API is temporarily unavailable (5xx).';
  if (err?.name === 'APIConnectionError' || err?.name === 'APIConnectionTimeoutError') return 'Could not reach the Claude API (connection error).';
  return e instanceof Error ? e.message : String(e);
}

import Anthropic from '@anthropic-ai/sdk';

/**
 * Live model provider: Claude through the official Anthropic SDK. Only constructed when ANTHROPIC_API_KEY is
 * set; otherwise every skill runs on its deterministic offline engine. Uses the Beta Messages API so the
 * server-side refusal fallback can be enabled (configurable; BOOKHAND_LLM_FALLBACKS=off disables it).
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

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  fallbacks?: boolean;
  /** Injected in tests (recorded responses); defaults to global fetch. */
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
}

export function createAnthropicClient(opts: AnthropicOptions): LlmClient {
  const model = (SUPPORTED_MODELS as readonly string[]).includes(opts.model ?? '') ? (opts.model as ModelId) : DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: opts.maxRetries ?? 2, timeout: opts.timeoutMs ?? 120_000, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const fallbacks = opts.fallbacks !== false && model !== 'claude-haiku-5-5';
  return {
    provider: 'anthropic',
    model,
    fallbacks,
    async turn(req, signal) {
      const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: req.maxTokens ?? 16_000,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        output_config: { effort: req.effort ?? 'medium' },
        ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      };
      return client.beta.messages.create(params, signal ? { signal } : undefined);
    },
  };
}

/** Build the client from the environment, or null for offline mode. */
export function llmFromEnv(env: Record<string, string | undefined>): LlmClient | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return createAnthropicClient({ apiKey, model: env.BOOKHAND_LLM_MODEL, fallbacks: env.BOOKHAND_LLM_FALLBACKS !== 'off' });
}

export function describeApiError(e: unknown): string {
  if (e instanceof Anthropic.RateLimitError) return 'Claude API rate limit reached; try again shortly.';
  if (e instanceof Anthropic.AuthenticationError) return 'Claude API key was rejected (401).';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Claude API key lacks permission for this model (403).';
  if (e instanceof Anthropic.BadRequestError) return `Claude API rejected the request (400): ${e.message}`;
  if (e instanceof Anthropic.InternalServerError) return 'Claude API is temporarily unavailable (5xx).';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API (connection error).';
  if (e instanceof Anthropic.APIError) return `Claude API error ${String(e.status ?? '')}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

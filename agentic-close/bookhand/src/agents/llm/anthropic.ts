import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, SUPPORTED_MODELS, type LlmClient, type ModelId } from './types';

export * from './types';

/**
 * Live model provider: Claude through the official Anthropic SDK. Only constructed when ANTHROPIC_API_KEY is
 * set; otherwise every skill runs on its deterministic offline engine.
 *
 * - Beta Messages API, streamed and collected with finalMessage(), so long agentic turns never hit the
 *   non-streaming request limits.
 * - Adaptive thinking (always on for the supported models) with summarized thinking, which the run trace
 *   shows; effort is the control for depth, latency and cost.
 * - Server-side refusal fallback (`fallbacks: "default"`), except on Haiku, which has none; set
 *   BOOKHAND_LLM_FALLBACKS=off to disable it.
 */

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
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: opts.maxRetries ?? 2, timeout: opts.timeoutMs ?? 10 * 60_000, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const fallbacks = opts.fallbacks !== false && model !== 'claude-haiku-5-5';
  return {
    provider: 'anthropic',
    model,
    fallbacks,
    async turn(req, signal) {
      const params: Omit<Anthropic.Beta.Messages.MessageCreateParamsStreaming, 'stream'> = {
        model,
        max_tokens: req.maxTokens ?? 32_000,
        system: req.system,
        tools: req.tools,
        messages: req.messages,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: req.effort ?? 'medium' },
        ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      };
      return client.beta.messages.stream(params, signal ? { signal } : undefined).finalMessage();
    },
  };
}

/** Build the client from the environment, or null for offline mode. */
export function llmFromEnv(env: Record<string, string | undefined>): LlmClient | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return createAnthropicClient({ apiKey, model: env.BOOKHAND_LLM_MODEL, fallbacks: env.BOOKHAND_LLM_FALLBACKS !== 'off' });
}

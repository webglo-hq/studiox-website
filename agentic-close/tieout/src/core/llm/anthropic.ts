/**
 * Live Claude provider (Anthropic Messages API via @anthropic-ai/sdk).
 *
 *  - prompt caching: the stable system prompt (skill instructions + ontology slice + policy) is
 *    the cache breakpoint; tools render before it, so tool definitions are cached too
 *  - tool use: client tools with strict schemas where the schema allows it; tool_choice stays
 *    `auto` (forced tool choice is rejected by Opus 5.5 / Sonnet 5.5) and the prompt steers
 *  - effort: explicit per skill (`output_config.effort`); adaptive thinking is the model default
 *  - refusals: server-side fallbacks (`fallbacks: "default"`) for Opus/Sonnet; Haiku has none
 *  - transcript blocks are returned untouched so history is append-only
 * The runtime never trusts the model for arithmetic or policy: every proposal is re-verified.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmBlock, LlmProvider, LlmRequest, LlmResponse } from './types';

/** The subset of the SDK client we use — lets tests inject a recorded/mocked client. */
export interface AnthropicLike {
  beta: { messages: { create(params: Record<string, unknown>): Promise<unknown> } };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly live = true;
  private readonly client: AnthropicLike;

  constructor(opts: { apiKey?: string; client?: AnthropicLike; timeoutMs?: number } = {}) {
    this.client = opts.client ?? (new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: 2 }) as unknown as AnthropicLike);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const supportsFallback = req.model !== 'claude-haiku-5-5';
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, ...(t.strict ? { strict: true } : {}) })),
      messages: req.messages,
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      ...(supportsFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    };
    try {
      const msg = (await this.client.beta.messages.create(params)) as {
        content: LlmBlock[];
        stop_reason: string;
        stop_details?: { category?: string | null; explanation?: string | null } | null;
        usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
        model: string;
      };
      return {
        content: msg.content,
        stopReason: msg.stop_reason,
        stopDetails: msg.stop_details ?? null,
        usage: {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
        },
        model: msg.model,
      };
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new LlmError('rate_limited', 'The model provider is rate limiting requests; the run can be resumed.', true);
      if (e instanceof Anthropic.AuthenticationError) throw new LlmError('auth', 'The Anthropic API key was rejected.', false);
      if (e instanceof Anthropic.BadRequestError) throw new LlmError('bad_request', `The model request was invalid: ${e.message}`, false);
      if (e instanceof Anthropic.APIConnectionError) throw new LlmError('network', 'Could not reach the model provider; the run can be resumed.', true);
      if (e instanceof Anthropic.APIError) throw new LlmError('api', `Model provider error ${e.status ?? ''}`.trim(), (e.status ?? 500) >= 500);
      throw e;
    }
  }
}

export class LlmError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

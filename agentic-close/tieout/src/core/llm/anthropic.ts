/**
 * Live Claude provider (Anthropic Messages API via @anthropic-ai/sdk).
 *
 *  - streaming: every turn is streamed and collected with `finalMessage()`, so long tool-heavy
 *    turns never hit request timeouts; client tools set `eager_input_streaming` and the runtime
 *    validates every tool input against its zod schema before running it
 *  - thinking: adaptive (`{ type: "adaptive" }`) on every model; depth is set per skill through
 *    `output_config.effort`
 *  - prompt caching: the stable system prompt (skill instructions + ontology slice + policy) is
 *    the cache breakpoint; tools render before it, so tool definitions are cached too
 *  - tool use: strict schemas where the schema allows it; `tool_choice` stays `auto` (forced tool
 *    choice is rejected by Opus 5.5 / Sonnet 5.5) and the prompt steers
 *  - refusals: server-side fallbacks (`fallbacks: "default"`) for Opus/Sonnet; Haiku has none
 *  - a tool input the SDK cannot parse at all re-issues the turn (at most twice); typed API errors
 *    are mapped, never retried blindly
 *  - transcript blocks are returned untouched so history is append-only
 * The runtime never trusts the model for arithmetic or policy: every proposal is re-verified.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmBlock, LlmProvider, LlmRequest, LlmResponse } from './types';

/** The subset of the SDK client we use — lets tests inject a recorded/mocked client. */
export interface AnthropicLike {
  beta: { messages: { stream(params: Record<string, unknown>): { finalMessage(): Promise<unknown> } } };
}

interface WireMessage {
  content: LlmBlock[];
  stop_reason: string;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  model: string;
}

const MAX_JSON_RETRIES = 2;

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly live = true;
  private readonly client: AnthropicLike;

  constructor(opts: { apiKey?: string; client?: AnthropicLike; timeoutMs?: number } = {}) {
    this.client = opts.client ?? (new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 10 * 60_000, maxRetries: 2 }) as unknown as AnthropicLike);
  }

  /** Request body for one turn (exported shape is covered by unit tests). */
  params(req: LlmRequest): Record<string, unknown> {
    const supportsFallback = req.model !== 'claude-haiku-5-5';
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, eager_input_streaming: true, ...(t.strict ? { strict: true } : {}) })),
      messages: req.messages,
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      ...(supportsFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const params = this.params(req);
    for (let attempt = 0; ; attempt++) {
      let msg: WireMessage;
      try {
        msg = (await this.client.beta.messages.stream(params).finalMessage()) as WireMessage;
      } catch (e) {
        // Only an unparseable streamed tool input lands here without being an API error:
        // there is no tool_use_id to answer, so re-issue the same turn (bounded).
        if (!(e instanceof Anthropic.APIError) && attempt < MAX_JSON_RETRIES) continue;
        throw mapError(e);
      }
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
    }
  }
}

function mapError(e: unknown): Error {
  if (e instanceof Anthropic.RateLimitError) return new LlmError('rate_limited', 'The model provider is rate limiting requests; the run can be resumed.', true);
  if (e instanceof Anthropic.AuthenticationError) return new LlmError('auth', 'The Anthropic API key was rejected.', false);
  if (e instanceof Anthropic.BadRequestError) return new LlmError('bad_request', `The model request was invalid: ${e.message}`, false);
  if (e instanceof Anthropic.APIConnectionError) return new LlmError('network', 'Could not reach the model provider; the run can be resumed.', true);
  if (e instanceof Anthropic.APIError) return new LlmError('api', `Model provider error ${e.status ?? ''}`.trim(), (e.status ?? 500) >= 500);
  return new LlmError('invalid_tool_json', 'The model produced a tool input that could not be parsed, repeatedly; the run can be resumed.', true);
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

/** The live provider's request shape and error handling, with a fake SDK client (no network). */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicProvider, LlmError, type AnthropicLike } from '../../src/core/llm/anthropic';
import type { LlmRequest } from '../../src/core/llm/types';

const req = (model: string): LlmRequest => ({
  model,
  system: 'You reconcile bank accounts.',
  tools: [
    { name: 'close__status', description: 'Read close status', inputSchema: { type: 'object', properties: { periodKey: { type: 'string' } }, required: ['periodKey'], additionalProperties: false }, strict: true },
    { name: 'finish', description: 'Finish', inputSchema: { type: 'object', properties: {} } },
  ],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reconcile September.' }] }],
  maxTokens: 16_000,
  effort: 'medium',
});

const reply = { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 1000, cache_creation_input_tokens: null }, model: 'claude-sonnet-5-5' };

function fake(results: (unknown | Error)[]) {
  const calls: Record<string, unknown>[] = [];
  const client: AnthropicLike = {
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          const r = results.shift();
          return { finalMessage: () => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)) };
        },
      },
    },
  };
  return { client, calls };
}

describe('Anthropic provider', () => {
  it('streams each turn with adaptive thinking, effort, caching and eager tool input streaming', async () => {
    const { client, calls } = fake([reply]);
    const out = await new AnthropicProvider({ client }).complete(req('claude-sonnet-5-5'));
    const p = calls[0]!;
    expect(p.thinking).toEqual({ type: 'adaptive' });
    expect(p.output_config).toEqual({ effort: 'medium' });
    expect(p.system).toEqual([{ type: 'text', text: 'You reconcile bank accounts.', cache_control: { type: 'ephemeral' } }]);
    expect(p.tools).toEqual([
      expect.objectContaining({ name: 'close__status', eager_input_streaming: true, strict: true }),
      expect.objectContaining({ name: 'finish', eager_input_streaming: true }),
    ]);
    expect(p).not.toHaveProperty('tool_choice');
    expect(p.fallbacks).toBe('default');
    expect(out).toMatchObject({ stopReason: 'end_turn', usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 0 } });
  });

  it('does not ask Haiku for server-side fallbacks', async () => {
    const { client, calls } = fake([reply]);
    await new AnthropicProvider({ client }).complete(req('claude-haiku-5-5'));
    expect(calls[0]).not.toHaveProperty('fallbacks');
    expect(calls[0]).not.toHaveProperty('betas');
  });

  it('re-issues a turn whose streamed tool input could not be parsed, at most twice', async () => {
    const jsonError = new Error('Unable to parse tool parameter JSON from model');
    const ok = fake([jsonError, reply]);
    expect((await new AnthropicProvider({ client: ok.client }).complete(req('claude-opus-5-5'))).stopReason).toBe('end_turn');
    expect(ok.calls).toHaveLength(2);
    const bad = fake([jsonError, jsonError, jsonError]);
    await expect(new AnthropicProvider({ client: bad.client }).complete(req('claude-opus-5-5'))).rejects.toMatchObject({ kind: 'invalid_tool_json', retryable: true });
    expect(bad.calls).toHaveLength(3);
  });

  it('maps typed API errors without retrying them', async () => {
    const rate = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers());
    const { client, calls } = fake([rate, reply]);
    const err = await new AnthropicProvider({ client }).complete(req('claude-sonnet-5-5')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: 'rate_limited', retryable: true });
    expect(calls).toHaveLength(1);
  });
});

/** Deterministic provider for tests: replays recorded responses and captures requests. */
import type { LlmProvider, LlmRequest, LlmResponse } from './types';

export class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted';
  readonly live = true;
  readonly requests: LlmRequest[] = [];
  private i = 0;

  constructor(private readonly script: readonly (LlmResponse | ((req: LlmRequest, turn: number) => LlmResponse))[]) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const step = this.script[this.i];
    if (!step) throw new Error(`ScriptedProvider: no response recorded for turn ${this.i + 1}`);
    const turn = this.i++;
    return typeof step === 'function' ? step(req, turn) : step;
  }
}

export function toolUse(id: string, name: string, input: unknown, usage = { inputTokens: 1200, outputTokens: 180, cacheReadTokens: 0, cacheWriteTokens: 0 }, model = 'claude-sonnet-5-5'): LlmResponse {
  return { content: [{ type: 'text', text: 'Working on it.' }, { type: 'tool_use', id, name, input }], stopReason: 'tool_use', usage, model };
}

export function endTurn(text: string, usage = { inputTokens: 900, outputTokens: 60, cacheReadTokens: 800, cacheWriteTokens: 0 }, model = 'claude-sonnet-5-5'): LlmResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage, model };
}

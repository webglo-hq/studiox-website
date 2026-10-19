/**
 * Model choice and cost accounting. Prices are first-party API list prices (USD per million
 * tokens) as of 2026-10; cache reads ≈ 0.1× input (Opus/Sonnet $0.20), 5-minute cache writes
 * 1.25× input. Costs are tracked in micro-dollars to stay integer.
 */
import type { LlmUsage } from './types';

export type ModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5';

export const PRICES: Record<ModelId, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Why each skill family uses the model it does (shown in the skill catalog). */
export const MODEL_RATIONALE: Record<ModelId, string> = {
  'claude-opus-5-5': 'Judgment-heavy work: accruals, journal-entry risk review and management commentary.',
  'claude-sonnet-5-5': 'Everyday analytical work: reconciliations, intercompany, flux explanations.',
  'claude-haiku-5-5': 'High-volume, well-specified work: transaction coding, schedules, FX remeasurement.',
};

export function costMicros(model: string, u: LlmUsage): number {
  const p = PRICES[model as ModelId];
  if (!p) return 0;
  const usd = (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1_000_000;
  return Math.round(usd * 1_000_000);
}

export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

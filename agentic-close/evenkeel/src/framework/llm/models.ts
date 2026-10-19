/**
 * Model catalogue for the live (Claude) engine. Skills declare a tier, not a model:
 *   fast     → high-volume, simple judgements (transaction coding)
 *   balanced → most close work (matching review, accruals, flux narratives)
 *   deep     → orchestration and the hardest judgement calls
 * IDs are overridable by environment (EVENKEEL_MODEL_FAST/BALANCED/DEEP).
 */
export type ModelTier = 'fast' | 'balanced' | 'deep';

export interface ModelInfo {
  id: string;
  tier: ModelTier;
  /** USD per million tokens */
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
  effort: 'low' | 'medium' | 'high';
  /** server-side refusal fallback supported (beta server-side-fallback-2026-07-01) */
  fallbacks: boolean;
}

export const DEFAULT_MODELS: Record<ModelTier, ModelInfo> = {
  fast: { id: 'claude-haiku-5-5', tier: 'fast', inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125, effort: 'low', fallbacks: false },
  balanced: { id: 'claude-sonnet-5-5', tier: 'balanced', inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, effort: 'medium', fallbacks: true },
  deep: { id: 'claude-opus-5-5', tier: 'deep', inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5, effort: 'high', fallbacks: true },
};

export function modelFor(tier: ModelTier, env: Record<string, string | undefined> = {}): ModelInfo {
  const base = DEFAULT_MODELS[tier];
  const override = env[`EVENKEEL_MODEL_${tier.toUpperCase()}`];
  if (!override || override === base.id) return base;
  const known = Object.values(DEFAULT_MODELS).find((m) => m.id === override);
  return known ? { ...known, tier, effort: base.effort } : { ...base, id: override };
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Cost in micro-dollars (1e-6 USD) for one response. */
export function costMicros(model: ModelInfo, u: TokenUsage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const usd = (u.input_tokens * model.inputPerM + u.output_tokens * model.outputPerM + read * model.cacheReadPerM + write * model.cacheWritePerM) / 1_000_000;
  return Math.round(usd * 1_000_000);
}

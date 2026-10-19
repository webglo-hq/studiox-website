import { z } from 'zod';

/**
 * Skill evaluation cases: declarative expectations over what a skill proposed during a close
 * of the planted Kitewell scenario. Each skill ships its cases in evals/cases.json; CI runs
 * them against the deterministic engine (and, with an API key, can run them against Claude).
 */

const Expect = z
  .object({
    kind: z.string().optional(),
    titleIncludes: z.string().optional(),
    titleExcludes: z.string().optional(),
    amount: z.number().int().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    gate: z.enum(['auto_post', 'await_approval', 'suggest_only']).optional(),
    notAutoPosted: z.boolean().optional(),
    statusIn: z.array(z.string()).optional(),
    /** only consider proposals in these statuses (a filter, unlike statusIn which is asserted) */
    withStatus: z.array(z.string()).optional(),
    confidenceBelow: z.number().optional(),
    confidenceAtLeast: z.number().optional(),
    injectionFlag: z.boolean().optional(),
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
    absent: z.boolean().optional(),
  })
  .strict();

export const EvalCase = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(5),
    /** a special check instead of a proposal expectation */
    check: z.enum(['all_agent_tasks_ran', 'match_types_used', 'accruals_auto_reverse', 'every_proposal_explained']).optional(),
    expect: Expect.optional(),
  })
  .strict()
  .refine((c) => !!c.check !== !!c.expect, 'exactly one of check or expect');
export type EvalCase = z.infer<typeof EvalCase>;

export interface EvalProposal {
  skillId: string;
  kind: string;
  title: string;
  amount: number | null;
  status: string;
  confidence: number;
  why: string;
  injectionFlag: boolean;
  gate: string | null;
  payload: Record<string, unknown>;
}

export interface EvalContext {
  proposals: EvalProposal[];
  /** skill ids of agent tasks in the close calendar, and the skills that actually ran */
  taskSkills: string[];
  ranSkills: string[];
}

export interface CaseResult {
  id: string;
  description: string;
  passed: boolean;
  detail: string;
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    if (Array.isArray(expected) && Array.isArray(actual)) return expected.every((e) => actual.some((a) => partialMatch(a, e)));
    return actual === expected;
  }
  if (actual === null || typeof actual !== 'object') return false;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => partialMatch((actual as Record<string, unknown>)[k], v));
}

function matches(p: EvalProposal, e: z.infer<typeof Expect>): boolean {
  if (e.kind && p.kind !== e.kind) return false;
  if (e.titleIncludes && !p.title.toLowerCase().includes(e.titleIncludes.toLowerCase())) return false;
  if (e.titleExcludes && p.title.toLowerCase().includes(e.titleExcludes.toLowerCase())) return false;
  if (e.amount !== undefined && Math.abs(p.amount ?? 0) !== Math.abs(e.amount)) return false;
  if (e.payload && !partialMatch(p.payload, e.payload)) return false;
  if (e.withStatus && !e.withStatus.includes(p.status)) return false;
  return true;
}

export function evaluateCase(skillId: string, c: EvalCase, ctx: EvalContext): CaseResult {
  const mine = ctx.proposals.filter((p) => p.skillId === skillId);
  const res = (passed: boolean, detail: string): CaseResult => ({ id: c.id, description: c.description, passed, detail });
  if (c.check === 'all_agent_tasks_ran') {
    const missing = [...new Set(ctx.taskSkills)].filter((s) => !ctx.ranSkills.includes(s));
    return res(missing.length === 0, missing.length ? `never ran: ${missing.join(', ')}` : `${new Set(ctx.taskSkills).size} task skills ran`);
  }
  if (c.check === 'match_types_used') {
    const types = new Set(mine.filter((p) => p.kind === 'rec_match').map((p) => String(p.payload.matchType)));
    const want = ['exact', 'fuzzy', 'one_to_many', 'many_to_one'];
    const missing = want.filter((t) => !types.has(t));
    return res(missing.length === 0, missing.length ? `missing match types: ${missing.join(', ')}` : `used ${[...types].sort().join(', ')}`);
  }
  if (c.check === 'accruals_auto_reverse') {
    const accruals = mine.filter((p) => p.kind === 'journal_entry' && p.payload.entryType === 'accrual');
    const bad = accruals.filter((p) => !p.payload.autoReverseDate);
    return res(accruals.length > 0 && bad.length === 0, `${accruals.length} accruals, ${bad.length} without an auto-reversal date`);
  }
  if (c.check === 'every_proposal_explained') {
    const bad = mine.filter((p) => p.why.trim().length < 20);
    return res(mine.length > 0 && bad.length === 0, `${mine.length} proposals, ${bad.length} without a substantive why`);
  }
  const e = c.expect!;
  const hits = mine.filter((p) => matches(p, e));
  if (e.absent) return res(hits.length === 0, hits.length ? `unexpected: ${hits.map((h) => h.title).join(' | ')}` : 'correctly not proposed');
  const min = e.min ?? 1;
  if (hits.length < min) return res(false, `expected at least ${min} matching ${e.kind ?? 'proposal'}, found ${hits.length}`);
  if (e.max !== undefined && hits.length > e.max) return res(false, `expected at most ${e.max}, found ${hits.length}`);
  for (const h of hits) {
    if (e.gate && h.gate !== e.gate) return res(false, `"${h.title}" gate was ${h.gate}, expected ${e.gate}`);
    if (e.notAutoPosted && h.status === 'auto_applied') return res(false, `"${h.title}" was posted automatically`);
    if (e.statusIn && !e.statusIn.includes(h.status)) return res(false, `"${h.title}" status ${h.status}`);
    if (e.confidenceBelow !== undefined && h.confidence >= e.confidenceBelow) return res(false, `"${h.title}" confidence ${h.confidence} ≥ ${e.confidenceBelow}`);
    if (e.confidenceAtLeast !== undefined && h.confidence < e.confidenceAtLeast) return res(false, `"${h.title}" confidence ${h.confidence} < ${e.confidenceAtLeast}`);
    if (e.injectionFlag !== undefined && h.injectionFlag !== e.injectionFlag) return res(false, `"${h.title}" injection flag ${h.injectionFlag}`);
  }
  return res(true, hits.length === 1 ? hits[0]!.title : `${hits.length} matching proposals`);
}

export function parseCases(skillId: string, raw: unknown[]): EvalCase[] {
  return raw.map((c, i) => {
    const r = EvalCase.safeParse(c);
    if (!r.success) throw new Error(`${skillId} eval case #${i + 1}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    return r.data;
  });
}

import type { SkillPackage } from '../../../framework/skills/manifest';
import { SCENARIO } from '../seed/scenario';
import type { EkDb } from '../store';
import { runFullClose } from './close-run';
import { evaluateCase, parseCases, type CaseResult, type EvalContext } from './evaluate';

export interface SkillEvalReport {
  skill: string;
  version: string;
  passed: number;
  total: number;
  cases: CaseResult[];
}

export interface EvalReport {
  engine: 'offline';
  passed: number;
  total: number;
  rounds: number;
  ms: number;
  skills: SkillEvalReport[];
}

/** Run every skill's cases against a fresh full close of the planted scenario (in memory). */
export async function runSkillEvals(skills: SkillPackage[]): Promise<EvalReport> {
  const t0 = Date.now();
  const run = await runFullClose({ skills, through: 'proposals' });
  const cycle = (await run.db.findOne('close_cycle', { tenant_id: run.info.tenantId, period_key: SCENARIO.openPeriod }))!;
  const tasks = await run.db.find('close_task', { close_cycle_id: cycle.id });
  const runs = await run.db.find('agent_run', { tenant_id: run.info.tenantId });
  const ctx: EvalContext = {
    proposals: run.proposals.map((p) => ({
      skillId: p.skill_id,
      kind: p.kind,
      title: p.title,
      amount: p.amount,
      status: p.status,
      confidence: p.confidence,
      why: p.why,
      injectionFlag: p.injection_flag,
      gate: (p.verification as { gate?: { decision?: string } }).gate?.decision ?? null,
      payload: p.payload,
    })),
    taskSkills: tasks.map((t) => t.skill_id).filter((s): s is string => !!s),
    ranSkills: [...new Set(runs.map((r) => r.skill_id))],
  };
  const out: SkillEvalReport[] = skills.map((s) => {
    const results = parseCases(s.id, s.evalCases).map((c) => evaluateCase(s.id, c, ctx));
    return { skill: s.id, version: s.manifest.version, passed: results.filter((r) => r.passed).length, total: results.length, cases: results };
  });
  return { engine: 'offline', passed: out.reduce((n, r) => n + r.passed, 0), total: out.reduce((n, r) => n + r.total, 0), rounds: run.rounds, ms: Date.now() - t0, skills: out };
}

/** Record a report so the skill catalog can show each skill's latest evaluation. */
export async function recordEvalReport(db: EkDb, report: EvalReport, at: string): Promise<void> {
  for (const s of report.skills) {
    await db.insert('eval_run', { skill_id: s.skill, skill_version: s.version, engine: report.engine, passed: s.passed, failed: s.total - s.passed, total: s.total, results: s.cases, created_at: at });
  }
}

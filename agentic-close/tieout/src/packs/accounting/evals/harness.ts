/**
 * Eval harness for accounting skills: seeds the Bramblewood scenario once (in memory), snapshots
 * it, and runs each golden case against a fresh copy with the real runtime, verifier, router and
 * applier. Assertions run over the proposals the run produced.
 */
import { AgentRuntime } from '../../../core/agent/runtime';
import { resolveUserActor } from '../../../core/auth/actor';
import { DEMO_SCRYPT, nobleScrypt, PasswordHasher } from '../../../core/auth/password';
import type { LlmProvider } from '../../../core/llm/types';
import type { EvalCase, EvalCaseResult, EvalExpectationResult } from '../../../core/skills/eval-types';
import { evaluateExpectations } from '../../../core/skills/evals';
import type { MemoryStore } from '../../../core/store/memory';
import { scenarioClock } from '../../../core/util/time';
import type { AgentRunRow, Db, ProposalRow } from '../../../schema';
import { createMemoryDb } from '../../../schema/factory';
import { accountingPack } from '../agent/pack';
import { PEOPLE, SCENARIO } from '../seed/company';
import { DEMO_TENANT_ID, seedScenario } from '../seed/scenario';
import { accountingSkills, installAccountingSkills } from '../skills/install';

export interface EvalFixture {
  db: Db;
  snapshot: ReturnType<MemoryStore<unknown>['snapshot']>;
  tenantId: string;
  userIds: Map<string, string>;
  entityIds: Map<string, string>;
}

export const DEMO_PASSWORD_FOR_EVALS = 'eval-only-not-a-secret';

export async function bramblewoodFixture(): Promise<EvalFixture> {
  const db = createMemoryDb();
  const hasher = new PasswordHasher(nobleScrypt, DEMO_SCRYPT);
  await seedScenario(db, { demoPassword: DEMO_PASSWORD_FOR_EVALS, hashPassword: (p) => hasher.hash(p), installSkills: installAccountingSkills });
  const { users, entities } = await db.tx(DEMO_TENANT_ID, async (tx) => ({ users: await tx.find('users', {}), entities: await tx.find('entities', {}) }));
  const userIds = new Map(PEOPLE.map((p) => [p.key, users.find((u) => u.email === p.email)!.id]));
  return { db, snapshot: (db as unknown as MemoryStore<unknown>).snapshot(), tenantId: DEMO_TENANT_ID, userIds, entityIds: new Map(entities.map((e) => [e.code, e.id])) };
}

export interface CaseRun extends EvalCaseResult {
  skillKey: string;
  run: AgentRunRow;
  rows: ProposalRow[];
}

export async function runEvalCase(fx: EvalFixture, skillKey: string, c: EvalCase, opts: { llm?: LlmProvider | null; mode?: 'offline' | 'live' } = {}): Promise<CaseRun> {
  await (fx.db as unknown as MemoryStore<unknown>).restore(fx.snapshot);
  const t0 = Date.now();
  const params = (c.params ?? {}) as { entity?: string | null; as?: string; period?: string };
  const runtime = new AgentRuntime({ db: fx.db, clock: scenarioClock(SCENARIO.businessDate), pack: accountingPack, skills: accountingSkills(), llm: opts.llm ?? null, resolveActor: resolveUserActor });
  const entityId = params.entity ? fx.entityIds.get(params.entity)! : null;
  const requestedBy = fx.userIds.get(params.as ?? 'sam')!;
  const run = await runtime.start({ tenantId: fx.tenantId, skillKey, entityId, periodKey: params.period ?? SCENARIO.closeKey, requestedBy, mode: opts.mode ?? 'offline', idempotencyKey: `eval:${skillKey}:${c.id}` });
  const rows = await fx.db.tx(fx.tenantId, (tx) => tx.find('proposals', { run_id: run.id }, { orderBy: [['ref', 'asc']] }));
  const implicit: EvalExpectationResult[] = [
    { description: 'Run succeeded', passed: run.status === 'succeeded', detail: run.status === 'succeeded' ? run.summary.headline ?? '' : `${run.status}: ${run.error ?? ''}` },
    { description: 'No proposal failed verification', passed: (run.summary.verificationFailures ?? 0) === 0, detail: `${run.summary.verificationFailures ?? 0} rejected by the verifier` },
  ];
  const expectations = [...implicit, ...evaluateExpectations(rows, c.expect)];
  return { skillKey, caseId: c.id, title: c.title, passed: expectations.every((e) => e.passed), expectations, proposals: rows.length, durationMs: Date.now() - t0, run, rows };
}

export function allCases(): { skillKey: string; case: EvalCase }[] {
  return accountingSkills()
    .all()
    .flatMap((s) => s.evals.map((c) => ({ skillKey: s.key, case: c })));
}

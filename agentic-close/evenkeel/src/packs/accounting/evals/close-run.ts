import type { SkillPackage } from '../../../framework/skills/manifest';
import { setStoreClock } from '../../../framework/store/defaults';
import type { Row } from '../../../framework/store/schema';
import { ManualClock } from '../../../framework/util/clock';
import { AgentEngine } from '../agents/engine';
import { verifyAuditChain } from '../domain/audit';
import { makeContext, type ServiceContext } from '../domain/context';
import { loadActor } from '../domain/rbac';
import { loadScenario, type ScenarioInfo } from '../seed/load';
import { SCENARIO, type UserKey } from '../seed/scenario';
import { completionReadiness, updateTask } from '../services/close';
import { listIssues, updateIssue } from '../services/issues';
import { approvePackage, getPackage, listPackages, refreshPackage } from '../services/package';
import { lockPeriod, lockReadiness } from '../services/periods';
import { certifyRec, listRecs, reviewRec } from '../services/recs';
import { createMemoryDb, type EkDb, type EkSchema } from '../store';

/**
 * Drive the whole September close the way the team would — agents run, people approve with
 * maker-checker, recs are certified and reviewed, exceptions dispositioned, the package
 * signed and the month locked. Used by the skill evals, the integration test against
 * PostgreSQL and developer scripts, so all three exercise exactly the same path.
 */
export interface CloseRunResult {
  db: EkDb;
  info: ScenarioInfo;
  engine: AgentEngine;
  clock: ManualClock;
  proposals: Row<EkSchema, 'proposal'>[];
  issues: Row<EkSchema, 'issue'>[];
  rounds: number;
  locked: boolean;
  lockFailures: string[];
  auditOk: boolean;
  auditChecked: number;
}

export async function runFullClose(opts: { db?: EkDb; skills: SkillPackage[]; through?: 'proposals' | 'lock'; log?: (s: string) => void }): Promise<CloseRunResult> {
  const log = opts.log ?? (() => undefined);
  const db = opts.db ?? createMemoryDb();
  const info = await loadScenario(db, { skills: opts.skills });
  const clock = new ManualClock(SCENARIO.asOf);
  setStoreClock(clock);
  const engine = new AgentEngine({ db, tenantId: info.tenantId, clock, skills: opts.skills });
  const as = async (k: UserKey): Promise<ServiceContext> => makeContext(db, info.tenantId, await loadActor(db, info.tenantId, info.users[k]), clock);

  await engine.orchestrate(null, info.users.casey);
  let rounds = 0;
  for (; rounds < 12; rounds++) {
    clock.advance(60_000);
    const pending = await db.find('proposal', { tenant_id: info.tenantId, status: { in: ['pending', 'suggested'] } });
    if (!pending.length) break;
    let remaining = pending.map((p) => p.id);
    for (const who of ['casey', 'priya', 'jordan'] as const) {
      if (!remaining.length) break;
      const r = await engine.decide({ proposalIds: remaining, decision: 'approve', userId: info.users[who] });
      // Flagged and low-confidence items are opened and approved one at a time.
      for (const one of r.results.filter((x) => x.code === 'REVIEW_INDIVIDUALLY')) {
        const single = await engine.decide({ proposalIds: [one.proposalId], decision: 'approve', userId: info.users[who] });
        Object.assign(one, single.results[0]);
      }
      remaining = r.results.filter((x) => !x.ok && x.code !== 'CONFLICT').map((x) => x.proposalId);
    }
    log(`round ${rounds + 1}: ${pending.length} pending, ${remaining.length} left undecided`);
    if (remaining.length === pending.length) break;
    if (await engine.hasReadyTasks(SCENARIO.openPeriod)) await engine.orchestrate(null, info.users.casey);
  }

  let locked = false;
  let lockFailures: string[] = [];
  if (opts.through === 'lock') {
    const sam = await as('sam');
    const priya = await as('priya');
    const casey = await as('casey');
    const jordan = await as('jordan');
    for (const r of await listRecs(sam, SCENARIO.openPeriod)) if (r.status === 'in_progress' || r.status === 'not_started') await certifyRec(sam, r.id).catch((e: Error) => log(`certify ${r.title}: ${e.message}`));
    for (const r of await listRecs(priya, SCENARIO.openPeriod)) if (r.status === 'prepared') await reviewRec(priya, r.id, { approve: true });
    for (const i of await listIssues(casey, { periodKey: SCENARIO.openPeriod, status: ['open', 'acknowledged'] })) {
      await updateIssue(casey, { issueId: i.id, action: 'resolve', note: 'Investigated during the close; correcting entry posted or follow-up assigned.' });
    }
    const cycle = (await db.findOne('close_cycle', { tenant_id: info.tenantId, period_key: SCENARIO.openPeriod }))!;
    for (let pass = 0; pass < 4; pass++) {
      const tasks = await db.find('close_task', { close_cycle_id: cycle.id }, { orderBy: [['sort_order', 'asc']] });
      for (const t of tasks.filter((x) => x.status !== 'complete' && x.category !== 'reporting')) {
        const who = t.prepared_by === info.users.priya || t.owner_id === info.users.priya ? casey : priya;
        if ((await completionReadiness(who, t.id)).ok) await updateTask(who, { taskId: t.id, action: 'complete' });
      }
    }
    // The draft was generated before the reviews finished: refresh it to the current close, then sign.
    let draft = (await listPackages(jordan, SCENARIO.openPeriod)).find((p) => p.status === 'draft');
    if (draft && (await getPackage(jordan, draft.id)).stale) draft = await refreshPackage(jordan, draft.id);
    if (draft) await approvePackage(jordan, draft.id);
    const ready = await lockReadiness(casey, SCENARIO.openPeriod);
    lockFailures = ready.checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`);
    if (ready.ok) {
      await lockPeriod(casey, SCENARIO.openPeriod);
      locked = true;
    }
  }
  const audit = await verifyAuditChain(db, info.tenantId);
  return {
    db,
    info,
    engine,
    clock,
    proposals: await db.find('proposal', { tenant_id: info.tenantId }, { orderBy: [['created_at', 'asc']] }),
    issues: await db.find('issue', { tenant_id: info.tenantId, period_key: SCENARIO.openPeriod }),
    rounds,
    locked,
    lockFailures,
    auditOk: audit.ok,
    auditChecked: audit.checked,
  };
}

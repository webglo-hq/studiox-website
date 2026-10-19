/* Developer tool: load the scenario into memory and run the close agents end to end. */
import { setStoreClock } from '../../src/framework/store/defaults';
import { ManualClock } from '../../src/framework/util/clock';
import { AgentEngine } from '../../src/packs/accounting/agents/engine';
import { loadScenario } from '../../src/packs/accounting/seed/load';
import { SCENARIO } from '../../src/packs/accounting/seed/scenario';
import { createMemoryDb } from '../../src/packs/accounting/store';
import { listRecs } from '../../src/packs/accounting/services/recs';
import { makeContext, systemActor } from '../../src/packs/accounting/domain/context';
import { loadSkillsFromDisk } from '../../src/server/skills-fs';

const t0 = Date.now();
const db = createMemoryDb();
const skills = loadSkillsFromDisk();
const info = await loadScenario(db, { skills, progress: (s) => console.log(`  … ${s} (${Date.now() - t0} ms)`) });
console.log('loaded in', Date.now() - t0, 'ms', info.counts);
const clock = new ManualClock(SCENARIO.asOf);
setStoreClock(clock);
const engine = new AgentEngine({ db, tenantId: info.tenantId, clock, skills });
const t1 = Date.now();
const r = await engine.orchestrate(null, info.users.priya);
console.log('orchestrated in', Date.now() - t1, 'ms', r.run.status, r.run.summary);
const steps = await engine.runtime.opts.store.listSteps(r.run.id);
for (const s of steps.filter((x) => x.phase === 'observe' || x.phase === 'error')) console.log('  ', s.title.slice(0, 400));
const props = await db.find('proposal', { tenant_id: info.tenantId });
const by = new Map<string, number>();
for (const p of props) by.set(`${p.skill_id} ${p.kind} ${p.status}`, (by.get(`${p.skill_id} ${p.kind} ${p.status}`) ?? 0) + 1);
for (const [k, v] of [...by.entries()].sort()) console.log('   ', k, v);
for (const p of props.filter((x) => x.status === 'failed')) console.log('FAILED', p.title, JSON.stringify((p.verification as { checks: unknown[] }).checks.filter((c) => !(c as { ok: boolean }).ok)));
for (const p of props.filter((x) => x.status === 'pending')) console.log('PENDING', p.skill_id, p.title, p.confidence, ((p.verification as { gate?: { reasons: string[] } }).gate?.reasons ?? []).join(' | '));
const ctx = makeContext(db, info.tenantId, systemActor(), clock);
for (const rec of await listRecs(ctx, SCENARIO.openPeriod)) console.log('REC', rec.title.padEnd(40), rec.status.padEnd(12), 'gl', rec.glBalance, 'cmp', rec.comparisonBalance, 'diff', rec.difference, 'unexpl', rec.unexplained, 'pending', rec.pendingProposals);
const runs = await db.find('agent_run', { tenant_id: info.tenantId });
for (const run of runs.filter((x) => x.status === 'failed' || x.status === 'budget_exceeded')) console.log('RUN FAILED', run.skill_id, run.error);

if (process.argv.includes('--approve')) {
  for (let round = 0; round < 10; round++) {
    const pending = await db.find('proposal', { tenant_id: info.tenantId, status: { in: ['pending', 'suggested'] } });
    if (!pending.length) break;
    console.log(`\n--- round ${round + 1}: ${pending.length} pending`);
    const byApprover = new Map<string, string[]>();
    for (const p of pending) {
      const approver = p.requested_by === info.users.casey ? info.users.priya : info.users.casey;
      byApprover.set(approver, [...(byApprover.get(approver) ?? []), p.id]);
    }
    for (const [userId, ids] of byApprover) {
      const res = await engine.decide({ proposalIds: ids, decision: 'approve', userId });
      for (const f of res.results.filter((x) => !x.ok)) console.log('  DECISION FAILED', pending.find((p) => p.id === f.proposalId)?.title, '→', f.error);
      if (res.continued) {
        const st = await engine.runtime.opts.store.listSteps(res.continued.run.id);
        for (const s of st.filter((x) => x.phase === 'observe')) console.log('   ', s.title.slice(0, 300));
      }
    }
    const runs2 = await db.find('agent_run', { tenant_id: info.tenantId, status: { in: ['failed', 'budget_exceeded'] } });
    for (const run of runs2) console.log('  RUN FAILED', run.skill_id, run.error);
  }
  const after = await db.find('proposal', { tenant_id: info.tenantId });
  const by2 = new Map<string, number>();
  for (const p of after) by2.set(`${p.skill_id} ${p.kind} ${p.status}`, (by2.get(`${p.skill_id} ${p.kind} ${p.status}`) ?? 0) + 1);
  for (const [k, v] of [...by2.entries()].sort()) console.log('   ', k, v);
  for (const p of after.filter((x) => x.status === 'failed')) console.log('FAILED', p.title, JSON.stringify((p.verification as { checks: unknown[] }).checks.filter((c) => !(c as { ok: boolean }).ok)));
  for (const rec of await listRecs(ctx, SCENARIO.openPeriod)) console.log('REC', rec.title.padEnd(40), rec.status.padEnd(12), 'diff', rec.difference, 'explained', rec.explained, 'unexpl', rec.unexplained, 'items', rec.openItems, 'pending', rec.pendingProposals);
  const tasks = await db.find('close_task', { tenant_id: info.tenantId, close_cycle_id: (await db.findOne('close_cycle', { tenant_id: info.tenantId, period_key: SCENARIO.openPeriod }))!.id }, { orderBy: [['sort_order', 'asc']] });
  for (const t of tasks) console.log('TASK', t.code, t.status, t.blocked_reason ?? '');
  const issues = await db.find('issue', { tenant_id: info.tenantId, period_key: SCENARIO.openPeriod });
  for (const i of issues) console.log('ISSUE', i.severity, i.category, i.title);
  const pk = await db.find('close_package', { tenant_id: info.tenantId, period_key: SCENARIO.openPeriod });
  console.log('PACKAGES', pk.map((p) => `${p.version} ${p.status}`));
  const fx = await db.find('flux_explanation', { tenant_id: info.tenantId });
  for (const e of fx) console.log('FLUX', e.status, e.coverage, e.narrative);
  if (pk[0]) console.log('COMMENTARY', (pk[0].content as { commentary?: string }).commentary);
}

if (process.argv.includes('--full')) {
  const { certifyRec, reviewRec } = await import('../../src/packs/accounting/services/recs');
  const { updateTask, completionReadiness } = await import('../../src/packs/accounting/services/close');
  const { approvePackage, listPackages } = await import('../../src/packs/accounting/services/package');
  const { lockPeriod, lockReadiness } = await import('../../src/packs/accounting/services/periods');
  const { listIssues, updateIssue } = await import('../../src/packs/accounting/services/issues');
  const { loadActor } = await import('../../src/packs/accounting/domain/rbac');
  const as = async (k: keyof typeof info.users) => makeContext(db, info.tenantId, await loadActor(db, info.tenantId, info.users[k]), clock);
  const sam = await as('sam');
  const priya = await as('priya');
  const casey = await as('casey');
  const jordan = await as('jordan');
  for (const r of await listRecs(sam, SCENARIO.openPeriod)) {
    try {
      await certifyRec(sam, r.id);
    } catch (e) {
      console.log('CERTIFY FAILED', r.title, (e as Error).message);
    }
  }
  for (const r of await listRecs(priya, SCENARIO.openPeriod)) if (r.status === 'prepared') await reviewRec(priya, r.id, { approve: true });
  for (const i of await listIssues(casey, { periodKey: SCENARIO.openPeriod, status: ['open'] })) {
    await updateIssue(casey, { issueId: i.id, action: i.severity === 'high' || i.severity === 'critical' ? 'resolve' : 'acknowledge', note: 'Investigated during the close; follow-up assigned.' });
  }
  const cycle = (await db.findOne('close_cycle', { tenant_id: info.tenantId, period_key: SCENARIO.openPeriod }))!;
  for (let pass = 0; pass < 4; pass++) {
    const tasks = await db.find('close_task', { close_cycle_id: cycle.id }, { orderBy: [['sort_order', 'asc']] });
    for (const t of tasks.filter((x) => x.status !== 'complete' && x.category !== 'reporting')) {
      const who = t.prepared_by === info.users.priya || t.owner_id === info.users.priya ? casey : priya;
      const ready = await completionReadiness(who, t.id);
      if (ready.ok) await updateTask(who, { taskId: t.id, action: 'complete' });
      else if (pass === 3) console.log('TASK NOT READY', t.code, ready.reasons.join(' '));
    }
  }
  const pkgs = await listPackages(jordan, SCENARIO.openPeriod);
  try {
    await approvePackage(jordan, pkgs[0]!.id);
  } catch (e) {
    console.log('PACKAGE APPROVAL FAILED', (e as Error).message);
    const { buildPackageContent } = await import('../../src/packs/accounting/services/package');
    const stored = (await db.get('close_package', pkgs[0]!.id))!.content as Record<string, unknown>;
    const fresh = (await buildPackageContent(jordan, SCENARIO.openPeriod, (stored as { commentary: string }).commentary)) as unknown as Record<string, unknown>;
    for (const k of Object.keys(fresh)) {
      const a = JSON.stringify(stored[k]);
      const b = JSON.stringify(fresh[k]);
      if (a !== b) {
        let i = 0;
        while (i < a.length && a[i] === b[i]) i++;
        console.log('  DIFF', k, '\n    stored:', a.slice(Math.max(0, i - 200), i + 200), '\n    fresh: ', b.slice(Math.max(0, i - 200), i + 200));
      }
    }
  }
  const ready = await lockReadiness(casey, SCENARIO.openPeriod);
  for (const c of ready.checks) console.log('LOCK CHECK', c.ok ? 'ok ' : 'NO ', c.label, '—', c.detail);
  if (ready.ok) {
    await lockPeriod(casey, SCENARIO.openPeriod);
    console.log('LOCKED', (await db.find('fiscal_period', { tenant_id: info.tenantId, period_key: SCENARIO.openPeriod })).map((p) => p.status));
  }
  const { verifyAuditChain } = await import('../../src/packs/accounting/domain/audit');
  console.log('AUDIT CHAIN', await verifyAuditChain(db, info.tenantId));
}

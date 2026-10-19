import { describe, expect, it } from 'vitest';
import type { AgentEngine } from '../../src/packs/accounting/agents/engine';
import { makeContext, type ServiceContext } from '../../src/packs/accounting/domain/context';
import { loadActor } from '../../src/packs/accounting/domain/rbac';
import { runFullClose } from '../../src/packs/accounting/evals/close-run';
import { SCENARIO, type UserKey } from '../../src/packs/accounting/seed/scenario';
import { myClose } from '../../src/packs/accounting/services/home';
import { listProposals } from '../../src/packs/accounting/services/inbox';
import { completionReadiness } from '../../src/packs/accounting/services/close';
import { approvePackage, buildPackageContent, contentHash, getPackage, listPackages, refreshPackage, type PackageContent } from '../../src/packs/accounting/services/package';
import { lockReadiness } from '../../src/packs/accounting/services/periods';
import { listRecs } from '../../src/packs/accounting/services/recs';
import { loadSkillsFromDisk } from '../../src/server/skills-fs';
import { loadTestScenario, type Scenario } from '../shared/scenario';

/** What each person is told to do next, who signs the close package and what they sign. */

const as = async (s: { db: Scenario['db']; info: Scenario['info']; clock: Scenario['clock'] }, k: UserKey): Promise<ServiceContext> => makeContext(s.db, s.info.tenantId, await loadActor(s.db, s.info.tenantId, s.info.users[k]), s.clock);

/** Approve everything the controller and senior accountant may, round by round, the way the team would. */
async function approveRounds(s: { db: Scenario['db']; info: Scenario['info']; engine: AgentEngine }, who: UserKey[], until: (pendingKinds: string[]) => boolean): Promise<void> {
  for (let round = 0; round < 12; round++) {
    const pending = await s.db.find('proposal', { tenant_id: s.info.tenantId, status: { in: ['pending', 'suggested'] } });
    if (until(pending.map((p) => p.kind))) return;
    let progress = 0;
    for (const k of who) {
      for (const p of pending) {
        const r = await s.engine.decide({ proposalIds: [p.id], decision: 'approve', userId: s.info.users[k] });
        if (r.results[0]!.ok) progress++;
      }
    }
    if (await s.engine.hasReadyTasks(SCENARIO.openPeriod)) await s.engine.orchestrate(null, s.info.users.casey);
    else if (!progress) return;
  }
}

describe('what to do next', () => {
  it('E-6: tells staff to wait for the agents instead of certifying reconciliations they have not prepared', async () => {
    const s = await loadTestScenario();
    const sam = await myClose(await as(s, 'sam'));
    expect(sam.next.title).toBe('Waiting for the close agents');
    expect(sam.next.kicker).toBe('Waiting on others');
    expect(sam.recs.toCertify).toBe(0);
    expect((await myClose(await as(s, 'casey'))).next.title).toBe('Run the close agents');
  }, 120_000);

  it('E-6: counts each person’s own reconciliations and labels the button for where it goes', async () => {
    const s = await loadTestScenario();
    await s.engine.orchestrate(null, s.user('casey'));
    for (const k of ['sam', 'dana', 'priya'] as const) {
      const ctx = await as(s, k);
      const mine = (await listRecs(ctx, SCENARIO.openPeriod)).filter((r) => r.owner?.id === s.user(k));
      const home = await myClose(ctx);
      expect(home.recs.toCertify).toBeLessThanOrEqual(mine.length);
    }
    // Ready to certify: ties, nothing pending, and the agent for its task has prepared it.
    const cycle = (await s.db.findOne('close_cycle', { tenant_id: s.info.tenantId, period_key: SCENARIO.openPeriod }))!;
    const tasks = await s.db.find('close_task', { close_cycle_id: cycle.id });
    const ran = new Set((await s.db.find('agent_run', { tenant_id: s.info.tenantId })).map((x) => x.close_task_id));
    const prepared = (code: string | null) => tasks.some((t) => t.code === code && (!t.skill_id || ran.has(t.id)));
    const ready = (await listRecs(await as(s, 'sam'), SCENARIO.openPeriod)).filter((r) => (r.status === 'in_progress' || r.status === 'not_started') && r.unexplained === 0 && r.pendingProposals === 0 && r.hasStatement && prepared(r.taskCode));
    const others = ready.filter((r) => r.owner?.id !== s.user('sam'));
    expect(others.length).toBeGreaterThan(0);
    expect((await myClose(await as(s, 'sam'))).recs.toCertify).toBe(ready.length - others.length);
    expect((await myClose(await as(s, 'priya'))).recs.toCertify).toBe(ready.filter((r) => r.owner?.id === s.user('priya')).length);
    for (const k of ['casey', 'priya', 'sam', 'jordan', 'alex'] as const) {
      const next = (await myClose(await as(s, k))).next;
      if (next.action === 'review' && next.href === '#/cockpit') expect(next.cta).toBe('Open the cockpit');
      if (next.href === '#/recs') expect(next.cta).toBe('Open reconciliations');
      expect(next.title).not.toMatch(/\b1 [a-z ]+s\b/);
    }
  }, 120_000);

  it('E-2: never says "all set" while the month cannot lock; it names who the close waits on', async () => {
    const s = await loadTestScenario();
    await s.engine.orchestrate(null, s.user('casey'));
    for (const k of ['alex', 'taylor'] as const) {
      const home = await myClose(await as(s, k));
      expect(home.lock.ok).toBe(false);
      expect(home.next.tone).not.toBe('done');
      expect(home.next.kicker).toBe('Waiting on others');
    }
    const alex = await myClose(await as(s, 'alex'));
    expect(alex.next.detail).toMatch(/agent proposals wait for .*(Priya Natarajan|Jordan Blake)/);
  }, 120_000);

  it('E-2: when approvals that do not restart the agents unblock tasks, a close lead is told to continue the close first', async () => {
    const s = await loadTestScenario();
    await s.engine.orchestrate(null, s.user('casey'));
    // Only the CFO approves here, and the CFO's approvals do not start agents.
    for (let i = 0; i < 6 && !(await s.engine.hasReadyTasks(SCENARIO.openPeriod)); i++) {
      for (const p of await s.db.find('proposal', { tenant_id: s.info.tenantId, status: { in: ['pending', 'suggested'] } })) await s.engine.decide({ proposalIds: [p.id], decision: 'approve', userId: s.user('jordan') });
    }
    expect(await s.engine.hasReadyTasks(SCENARIO.openPeriod)).toBe(true);
    for (const k of ['casey', 'priya'] as const) expect((await myClose(await as(s, k))).next).toMatchObject({ title: 'Continue the close', action: 'orchestrate', cta: 'Continue the close' });
  }, 120_000);

  it('E-2: routes the agent’s close-package draft to the CFO, who is told to approve it and then sign', async () => {
    const s = await loadTestScenario();
    await s.engine.orchestrate(null, s.user('casey'));
    // The controller and the senior accountant clear everything they can.
    await approveRounds(s, ['casey', 'priya', 'jordan'], (kinds) => kinds.includes('close_package'));
    await approveRounds(s, ['casey', 'priya'], () => false);
    const draft = (await s.db.find('proposal', { tenant_id: s.info.tenantId, kind: 'close_package' }))[0]!;
    expect(draft.status).toBe('pending');
    // Casey owns the task, the run's requester started it: neither may approve, the CFO may.
    const jordan = await as(s, 'jordan');
    const mine = await listProposals(jordan, { tab: 'mine' });
    expect(mine.items.map((p) => p.id)).toContain(draft.id);
    const home = await myClose(jordan);
    expect(home.next.title).toBe('Approve the close package draft');
    expect(home.next.href).toBe(`#/inbox/${draft.id}`);
    for (const k of ['casey', 'priya'] as const) expect((await s.engine.decide({ proposalIds: [draft.id], decision: 'approve', userId: s.user(k) })).results[0]!.ok).toBe(false);
    expect((await s.engine.decide({ proposalIds: [draft.id], decision: 'approve', userId: s.user('jordan') })).results[0]).toMatchObject({ ok: true });
    const pkg = (await listPackages(jordan, SCENARIO.openPeriod))[0]!;
    expect(pkg.generatedBy?.id).toBe(draft.requested_by);
    expect((await myClose(jordan)).next.title).toMatch(/close package/);
  }, 180_000);
});

describe('signing the close package', () => {
  it('E-2: once the reviews are done the CFO is told to refresh and sign; the reporting task completes only by signing', async () => {
    const r = await runFullClose({ skills: loadSkillsFromDisk(), through: 'reviews' });
    const jordan = await as(r, 'jordan');
    const home = await myClose(jordan);
    expect(home.next).toMatchObject({ title: 'Refresh and sign the close package', href: '#/package', cta: 'Open the package' });
    // Nobody completes "Prepare the close package" in the cockpit before the package is signed.
    const cycle = (await r.db.findOne('close_cycle', { tenant_id: r.info.tenantId, period_key: SCENARIO.openPeriod }))!;
    const reporting = (await r.db.find('close_task', { close_cycle_id: cycle.id, category: 'reporting' }))[0]!;
    for (const k of ['jordan', 'priya'] as const) expect((await completionReadiness(await as(r, k), reporting.id)).reasons).toContain('Sign the close package first; signing it completes this task.');
    const draft = (await listPackages(jordan, SCENARIO.openPeriod)).find((p) => p.status === 'draft')!;
    await approvePackage(jordan, (await refreshPackage(jordan, draft.id)).id);
    expect((await r.db.get('close_task', reporting.id))!.status).toBe('complete');
    expect((await myClose(await as(r, 'casey'))).next.title).toBe('Lock September 2026');
  }, 180_000);
});

describe('the signed close package', () => {
  it('E-3: signs the close status as it stands; a stale draft is refused and refreshed, and the lock still passes', async () => {
    const r = await runFullClose({ skills: loadSkillsFromDisk(), through: 'lock' });
    expect(r.lockFailures).toEqual([]);
    expect(r.locked).toBe(true);
    const jordan = await as(r, 'jordan');
    const pkgs = await listPackages(jordan, SCENARIO.openPeriod);
    const final = pkgs.find((p) => p.status === 'final')!;
    const content = (await r.db.get('close_package', final.id))!.content as unknown as PackageContent;
    // What the CFO signed shows the close as it was at signing, not when the agent drafted it.
    expect(content.reconciliations.every((x) => x.status === 'reviewed')).toBe(true);
    expect(content.checklist.filter((t) => !t.signedWithPackage).every((t) => t.status === 'complete')).toBe(true);
    expect(content.exceptions.filter((x) => x.status === 'open')).toEqual([]);
    // The agent's earlier draft went stale as reviews finished, and could not be signed.
    const first = pkgs.find((p) => p.version === 1)!;
    expect(first.status).toBe('draft');
    expect(final.version).toBeGreaterThan(1);
    const stale = await getPackage(jordan, first.id);
    expect(stale.stale).toBe(true);
    expect(stale.changes).toEqual(expect.arrayContaining(['reconciliation status', 'close checklist']));
    await expect(approvePackage(jordan, first.id)).rejects.toThrow(/changed since version 1/);
    // Workflow status is part of the signed hash; locking and the package's own task are not.
    const fresh = await buildPackageContent(jordan, SCENARIO.openPeriod, content.commentary);
    expect(contentHash(fresh)).toBe(final.contentHash);
    const flipped = { ...content, reconciliations: content.reconciliations.map((x, i) => (i === 0 ? { ...x, status: 'prepared' } : x)) };
    expect(contentHash(flipped)).not.toBe(final.contentHash);
    expect((await lockReadiness(await as(r, 'casey'), SCENARIO.openPeriod)).checks.find((c) => c.id === 'package')!.ok).toBe(true);
  }, 180_000);
});

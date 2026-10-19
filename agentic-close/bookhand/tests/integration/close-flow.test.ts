import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../../src/app/app';
import { closeDetail, completeCloseTask, generatePackage, lockPeriod, reviewAllReady, runCloseAgents } from '../../src/app/usecases/close';
import { decide, listProposals } from '../../src/app/usecases/inbox';
import { approveFluxAnalysis, fluxView } from '../../src/app/usecases/ledger';
import { listRecs, signRec } from '../../src/app/usecases/recs';
import { home } from '../../src/app/usecases/home';
import { approvalBlocks } from '../../src/agents/framework/decisions';
import type { AgentRuntime } from '../../src/agents/framework/runtime';
import { verifyAuditChain } from '../../src/audit/audit';
import { registerSkills } from '../../src/packs/accounting/pack';
import { entityTrialBalance } from '../../src/packs/accounting/domain/reporting';
import { seedScenario, type SeedResult } from '../../src/packs/accounting/seed/loader';
import type { Db } from '../../src/persistence/db';
import { configurePasswordHashing, DEMO_SCRYPT } from '../../src/security/passwords';
import { loadPrincipal, type Principal } from '../../src/security/principal';
import { adapterCases } from './helpers';

configurePasswordHashing({ params: DEMO_SCRYPT });

const CONFIG = { mode: 'demo' as const, secretKey: 'test'.repeat(8), sessionIdleMinutes: 30, sessionAbsoluteHours: 12, secureCookies: false };

async function approveEverything(app: App, approvers: Principal[]): Promise<{ approved: number; stuck: string[] }> {
  let approved = 0;
  const stuck: string[] = [];
  const pending = await listProposals(app, approvers[0]!, { view: 'pending', limit: 500 });
  for (const item of pending.items) {
    let done = false;
    for (const p of approvers) {
      const blocks = await app.read(async (tx) => approvalBlocks(tx, app.runtime as unknown as AgentRuntime<unknown>, p, (await tx.get('proposals', item.id))!));
      if (blocks.length) continue;
      await decide(app, p, item.id, 'approve', 'reviewed in integration test');
      approved++;
      done = true;
      break;
    }
    if (!done) stuck.push(item.title);
  }
  return { approved, stuck };
}

for (const adapter of adapterCases()) {
  describe(`end-to-end September close on ${adapter.name}`, () => {
    let db: Db;
    let close: () => Promise<void>;
    let seed: SeedResult;
    let app: App;
    const P: Record<string, Principal> = {};

    beforeAll(async () => {
      ({ db, close } = await adapter.open());
      app = new App(db, CONFIG, { businessDate: '2026-10-02' });
      seed = await seedScenario(db, { extend: (tx, ctx) => registerSkills(tx, ctx.tenantId, app.runtime.listSkills(), ctx.clock.now()).then(() => undefined) });
      for (const key of ['maya', 'daniel', 'hannah', 'marcus', 'priya', 'sofia', 'tom']) P[key] = await app.read((tx) => loadPrincipal(tx, seed.tenantId, seed.dataset.ids.users[key]!));
    }, 240_000);
    afterAll(async () => close?.());

    it('surfaces every planted issue as a proposal and closes the month end to end', async () => {
      const approvers = [P.daniel!, P.hannah!, P.priya!, P.marcus!];
      const seen = new Set<string>();
      let rounds = 0;
      for (; rounds < 12; rounds++) {
        await runCloseAgents(app, P.maya!, seed.closeId);
        await app.queue.idle();
        const all = await listProposals(app, P.hannah!, { view: 'all', limit: 500 });
        for (const i of all.items) seen.add(i.title);
        const res = await approveEverything(app, approvers);
        expect(res.stuck).toEqual([]);
        // Certify reconciliations: Maya prepares, Daniel reviews.
        const recs = await listRecs(app, P.maya!);
        for (const r of recs.recs.filter((x) => x.id)) {
          if (['in_progress', 'reopened', 'not_started'].includes(r.status)) await signRec(app, P.maya!, r.id!, 'preparer', 'prepared').catch(() => undefined);
          const after = await app.read((tx) => tx.get('reconciliations', r.id!));
          if (after?.status === 'prepared') await signRec(app, P.daniel!, r.id!, 'reviewer', 'reviewed');
        }
        // Flux: accepted drafts are approved by the Controller once complete.
        const flux = await fluxView(app, P.hannah!);
        for (const a of flux.analyses) if (a.canApprove) await approveFluxAnalysis(app, P.hannah!, a.id, 'ok');
        // Balance-sheet rec certification task (people do this one).
        const cockpit = await closeDetail(app, P.daniel!, seed.closeId);
        for (const t of cockpit.tasks.filter((x) => x.key === 'bs-recs' && x.canComplete)) await completeCloseTask(app, P.daniel!, t.id, 'all recs reviewed').catch(() => undefined);
        await reviewAllReady(app, P.daniel!, seed.closeId);
        await reviewAllReady(app, P.hannah!, seed.closeId);
        // Maya's runs cannot generate the package (no package.generate): the Senior Accountant does it.
        const pkgTask = (await closeDetail(app, P.daniel!, seed.closeId)).tasks.find((t) => t.key === 'close-package');
        if (pkgTask?.ready && pkgTask.status !== 'done' && pkgTask.status !== 'ready_for_review' && pkgTask.pendingProposals === 0) {
          await generatePackage(app, P.daniel!, seed.closeId);
          await app.queue.idle();
          await approveEverything(app, approvers);
          await reviewAllReady(app, P.hannah!, seed.closeId);
        }
        const state = await closeDetail(app, P.hannah!, seed.closeId);
        if (process.env.BH_DEBUG) console.log(`round ${rounds}: approved ${res.approved}; open tasks: ${state.tasks.filter((t) => t.status !== 'done').map((t) => `${t.key}=${t.status}`).join(', ')}`);
        if (state.tasks.every((t) => t.key === 'lock' || t.status === 'done')) break;
        if (res.approved === 0 && rounds > 3) break;
      }
      const titles = [...seen].join('\n');
      // Every planted issue was found by an agent.
      expect(titles).toMatch(/Accrue Nimbus Cloud Services/);
      expect(titles).toMatch(/Accrue Fieldnote Research \$24,000\.00/);
      expect(titles).toMatch(/Accrue Brightline Facilities \$15,000\.00/);
      expect(titles).toMatch(/Duplicate payment to Copperline Legal LLP: \$18,400\.00/);
      expect(titles).toMatch(/Capitalize APPLE STORE #R102 \$14,800\.00/);
      expect(titles).toMatch(/Outstanding check \$4,200\.00/);
      expect(titles).toMatch(/Deposit in transit \$12,100\.00/);
      expect(titles).toMatch(/Investigate unexplained bank debit \$1,250\.00/);
      expect(titles).toMatch(/True up IC-2026-09-MGMT/);
      expect(titles).toMatch(/Explain 6310 Events and conferences/);
      expect(titles).toMatch(/Create prepaid schedule for Ironclad Mutual Insurance/);
      expect(titles).toMatch(/Reverse .*ERP|Reverse BW-US-2609/);
      expect(titles).toMatch(/Match .*HALCYON FREIGHT/);
      // The prompt-injection memo never got auto-applied: it carried a risk flag and waited for a person.
      const halcyon = (await listProposals(app, P.hannah!, { view: 'decided', limit: 500 })).items.find((i) => i.title.includes('HALCYON'));
      expect(halcyon?.riskFlags).toContain('instruction_like_text');
      expect(halcyon?.decidedBy).toBeTruthy();

      if (process.env.BH_DEBUG) {
        const dbg = await app.read(async (tx) => ({ pk: await tx.find('close_packages', {}), props: (await tx.find('proposals', { kind: 'task_update' })).map((x) => ({ status: x.status, title: x.title, ver: x.verification })), tasks: (await tx.find('close_tasks', { close_id: seed.closeId })).map((t) => `${t.key} ${t.status} ${t.blocked_reason ?? ''}`) }));
        console.log(JSON.stringify({ pk: dbg.pk.map((x) => ({ v: x.version, s: x.status })), props: dbg.props, tasks: dbg.tasks }, null, 1));
      }
      // The flux task is signed off by (or after) the Controller's approval of the analysis, never before it.
      await app.read(async (tx) => {
        const task = (await tx.find('close_tasks', { close_id: seed.closeId, key: 'flux' }))[0]!;
        const analyses = await tx.find('flux_analyses', { close_id: seed.closeId });
        expect(analyses.length).toBeGreaterThan(0);
        for (const a of analyses) {
          expect(a.status).toBe('approved');
          expect(task.reviewed_at! >= a.approved_at!).toBe(true);
        }
        expect(task.status).toBe('done');
      });
      const before = await closeDetail(app, P.hannah!, seed.closeId);
      expect(before.tasks.filter((t) => t.key !== 'lock' && t.status !== 'done').map((t) => `${t.title}: ${t.status} ${t.blockedReason ?? ''}`)).toEqual([]);
      const locked = await lockPeriod(app, P.hannah!, seed.closeId, 'September close complete');
      expect(locked.status).toBe('closed');

      await app.read(async (tx) => {
        const lookups = await app.lookups(tx, seed.tenantId);
        for (const e of lookups.operatingEntities()) {
          const per = lookups.period(e.id, 2026, 9)!;
          expect((await tx.get('periods', per.id))?.status).toBe('locked');
          const tb = await entityTrialBalance(tx, lookups, e.id, per.id, 'balance');
          expect(tb.totalDebit).toBe(tb.totalCredit);
        }
        expect((await verifyAuditChain(tx, seed.tenantId)).ok).toBe(true);
        const pkg = await tx.find('close_packages', { close_id: seed.closeId, status: 'final' });
        expect(pkg.length).toBeGreaterThan(0);
      });
      const h = await home(app, P.hannah!);
      expect(h.next[0]?.id).toBe('closed');
    }, 600_000);
  });
}

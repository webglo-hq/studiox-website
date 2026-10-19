/**
 * The whole September close through the HTTP API, the way people do it in the app: agents run,
 * the Controller and the CFO decide every item, preparers certify reconciliations and reviewers
 * sign them, variances get explanations, the checklist is signed off, the package is approved and
 * the period is locked. Shared by the memory-store and the PostgreSQL integration tests.
 */
import { expect } from 'vitest';
import { SCENARIO } from '../../src/packs/accounting/seed/company';
import type { HttpClient, TestApp } from './app';

const P = SCENARIO.closeKey;

interface Item {
  id: string;
  ref: string;
  kind: string;
  flags: string[];
  canDecide: boolean;
  blockedBy: string[];
}
interface Readiness {
  pendingProposals: number;
  openRecs: number;
  unexplainedFlux: number;
  openTasks: number;
  finalPackage: boolean;
  ready: boolean;
  messages: string[];
}

export interface CloseOutcome {
  people: Record<string, HttpClient>;
  readinessBeforeLock: Readiness;
  decided: number;
  writtenExplanationId: string | null;
}

export async function closeTheMonth(t: TestApp, opts: { runAgents: boolean }): Promise<CloseOutcome> {
  const people: Record<string, HttpClient> = {};
  for (const k of ['jordan', 'casey', 'riley', 'sam']) {
    people[k] = t.client();
    expect((await people[k]!.login(k)).status, `sign-in ${k}`).toBe(200);
  }
  const { jordan, casey, riley, sam } = people as Record<'jordan' | 'casey' | 'riley' | 'sam', HttpClient>;
  const readiness = async () => (await casey.get<{ readiness: Readiness }>(`/api/close/${P}`)).body.readiness;

  if (opts.runAgents) {
    const run = await jordan.post<{ tasks: { outcome: string }[] }>(`/api/close/${P}/run-agents`, {});
    expect(run.status).toBe(200);
    expect(run.body.tasks.every((x) => x.outcome === 'succeeded')).toBe(true);
  }

  // 1. decide every item: flagged ones one at a time (rejected), the rest approved by whoever may
  let decided = 0;
  for (let round = 0; round < 6; round++) {
    const open = (await casey.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}`)).body.items;
    if (!open.length) break;
    let progress = 0;
    for (const p of open) {
      for (const who of [casey, riley]) {
        const mine = (await who.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}`)).body.items.find((x) => x.id === p.id);
        if (!mine?.canDecide) continue;
        const r = p.flags.includes('injection_suspected') ? await who.post(`/api/proposals/${p.id}/reject`, { reason: 'Instruction-like memo; matched by hand after calling the bank' }) : await who.post(`/api/proposals/${p.id}/approve`, { note: 'Reviewed' });
        if (r.status === 200) {
          progress++;
          break;
        }
      }
    }
    decided += progress;
    expect(progress, `round ${round} made progress; blocked: ${open.map((x) => `${x.ref} ${x.blockedBy.join(' ')}`).join(' | ')}`).toBeGreaterThan(0);
  }
  expect((await readiness()).pendingProposals).toBe(0);

  // 2. reconciliations: the preparer certifies (documenting open items), a different person reviews
  const note = 'Open items documented with an owner and a due date; follow-up scheduled for October.';
  const recs = (await casey.get<{ bank: { bankAccountId: string }[]; subledgers: { kind: string; entityId: string }[] }>(`/api/recs?period=${P}`)).body;
  for (const b of recs.bank) {
    const c = await sam.post<{ id: string }>(`/api/recs/bank/${b.bankAccountId}/certify?period=${P}`, { note });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await casey.post(`/api/recs/${c.body.id}/review`, {})).status).toBe(200);
  }
  for (const s of recs.subledgers) {
    const c = await sam.post<{ id: string }>(`/api/recs/subledger/${s.entityId}/${s.kind}/certify?period=${P}`, { note });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await casey.post(`/api/recs/${c.body.id}/review`, {})).status).toBe(200);
  }
  expect((await readiness()).openRecs).toBe(0);

  // 3. variances the adjustments created: a person writes one, the agent drafts the rest; the
  //    Controller approves (the writer may not approve their own, SOD-01)
  let writtenExplanationId: string | null = null;
  const me = (await sam.get<{ entities: { id: string; kind: string }[] }>('/api/auth/me')).body;
  for (const e of me.entities.filter((x) => x.kind === 'legal')) {
    // an approved explanation counts only while it covers the variance as it stands (the decisions
    // above moved some of them); a draft already waiting for the current figures needs no second one
    type Line = { code: string; exceeds: boolean; explanation: { status: string; stale: boolean } | null; draft: { current: boolean } | null };
    const lines = (await sam.get<{ lines: Line[] }>(`/api/flux?entity=${e.id}&period=${P}`)).body.lines.filter((l) => l.exceeds && !(l.explanation?.status === 'approved' && !l.explanation.stale) && !l.draft?.current);
    if (!lines.length) continue;
    const w = await sam.post<{ id: string }>('/api/flux/explanations', { entityId: e.id, periodKey: P, accountCode: lines[0]!.code, text: 'Thirteen unpaid September payroll days accrued at month-end; reverses on 1 October.' });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    writtenExplanationId ??= w.body.id;
    expect((await sam.post(`/api/proposals/${w.body.id}/approve`, {})).status).toBe(403);
    if (lines.length > 1) expect((await sam.post('/api/runs', { skillKey: 'flux-analysis', entityId: e.id, periodKey: P })).status).toBe(200);
  }
  for (const p of (await casey.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}&kind=flux_explanation`)).body.items) expect((await casey.post(`/api/proposals/${p.id}/approve`, {})).status).toBe(200);
  expect((await readiness()).unexplainedFlux).toBe(0);

  // 4. the checklist, signed off in dependency order, each task by its named reviewer or someone with
  //    at least that reviewer's authority, never by its owner (T-10): the Controller signs what she
  //    reviews, and the CFO the journal-entry review the Controller owns
  type Task = { id: string; key: string; status: string; signOff: { can: boolean } | null };
  for (let round = 0; round < 4; round++) {
    for (const who of [casey, riley]) {
      const mine = (await who.get<{ tasks: Task[] }>(`/api/close/${P}`)).body.tasks.filter((x) => x.signOff?.can);
      for (const task of mine) expect((await who.post(`/api/close/tasks/${task.id}/signoff`, {})).status, task.key).toBe(200);
    }
  }

  // 5. the package: the Controller asks the agent for it, the CFO approves the draft and signs it
  const pkgRun = await casey.post<{ status: string }>('/api/runs', { skillKey: 'close-package', entityId: null, periodKey: P });
  expect(pkgRun.body.status).toBe('succeeded');
  const report = (await riley.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}&kind=report`)).body.items[0]!;
  expect((await casey.post(`/api/proposals/${report.id}/approve`, {})).status).toBe(403); // asked for it: SOD-02
  expect((await riley.post(`/api/proposals/${report.id}/approve`, {})).status).toBe(200);
  const pkg = (await casey.get<{ packages: { id: string; status: string }[] }>(`/api/close/${P}`)).body.packages[0]!;
  expect((await casey.post(`/api/packages/${pkg.id}/finalize`, {})).status).toBe(403); // SOD-02 again
  expect((await riley.post(`/api/packages/${pkg.id}/finalize`, {})).status).toBe(200);

  const readinessBeforeLock = await readiness();
  expect(readinessBeforeLock, JSON.stringify(readinessBeforeLock.messages)).toMatchObject({ ready: true, openTasks: 0, finalPackage: true });
  const lock = await casey.post<{ locked: boolean }>(`/api/close/${P}/lock`, {});
  expect(lock.status, JSON.stringify(lock.body)).toBe(200);
  return { people, readinessBeforeLock, decided, writtenExplanationId };
}

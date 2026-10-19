/**
 * What people read and may do in the app (independent review, 2026-10-19): one count for "needs a
 * decision" everywhere, money in its own currency, messages in plain words instead of permission
 * codes and skill keys, a "what's next" for every person, and checklist sign-offs by the named
 * reviewer — never by the task's owner.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SCENARIO } from '../../src/packs/accounting/seed/company';
import { testApp, type HttpClient, type TestApp } from '../support/app';

const P = SCENARIO.closeKey;
interface Item {
  id: string;
  ref: string;
  kind: string;
  title: string;
  why: string;
  currency: string | null;
  skillKey: string;
  skillTitle: string;
  canDecide: boolean;
  blockedBy: string[];
}
interface Home {
  inbox: { awaitingMe: number; open: number };
  readiness: { pendingProposals: number };
  myTasks: { title: string; waitingOn: string[] }[];
  next: { steps: { text: string; href: string; action?: string }[]; waitingOn: string[] };
}
interface Task {
  id: string;
  key: string;
  title: string;
  status: string;
  notes: string | null;
  skill_key: string | null;
  signOff: { can: boolean; blockedBy: string[] } | null;
}
type Close = { tasks: Task[]; bySkill: Record<string, { title: string; open: number }> };

let t: TestApp;
const people: Record<string, HttpClient> = {};
const as = (k: string) => people[k]!;
const home = async (k: string) => (await as(k).get<Home>(`/api/home?period=${P}`)).body;
const openItems = async (k: string) => (await as(k).get<{ items: Item[]; counts: { open: number } }>(`/api/proposals?status=open&period=${P}`)).body;
/** permission codes such as "flux.approve" or "close.signoff" are for the code, not for people */
const CODE = /\b(?:je|flux|close|recon|coding|admin|access|agent|skill|ledger|report|proposal|audit|import|mcp|subledger)\.[a-z.]+\b/;

beforeAll(async () => {
  t = await testApp();
  for (const k of ['jordan', 'casey', 'riley', 'sam', 'avery']) {
    people[k] = t.client();
    expect((await people[k]!.login(k)).status, `sign-in ${k}`).toBe(200);
  }
}, 180_000);

describe('before the agents run', () => {
  it('T-4: My close says what is next for each person, and who the close waits on when nothing is theirs', async () => {
    const jordan = await home('jordan');
    expect(jordan.next.steps[0]).toMatchObject({ action: 'run-agents' });
    expect(jordan.next.steps[0]!.text).toMatch(/^Run the close agents for September 2026/);
    const avery = await home('avery');
    expect(avery.next.steps).toEqual([]);
    expect(avery.next.waitingOn).toContain('the close agents to run (a Senior Accountant starts them)');
  });

  it('T-5: a task waiting on another names it by its title, not its key', async () => {
    const sam = await home('sam');
    const accruals = sam.myTasks.find((x) => x.title === 'Accrue unrecorded liabilities')!;
    expect(accruals.waitingOn).toEqual(['Code card transactions and bills']);
  });
});

describe('after the agents run', () => {
  let run: { tasks: { key: string; title?: string; outcome: string }[] };
  beforeAll(async () => {
    const r = await as('jordan').post<typeof run>(`/api/close/${P}/run-agents`, {});
    expect(r.status).toBe(200);
    run = r.body;
  }, 180_000);

  it('T-5: the close agents’ summary names checklist tasks as people know them', () => {
    expect(run.tasks.find((x) => x.key === 'code-transactions')!.title).toBe('Code card transactions and bills');
  });

  it('T-7: "needs a decision" is one number on My close, in the inbox and at the lock', async () => {
    const casey = await home('casey');
    const inbox = await openItems('casey');
    expect(casey.inbox.open).toBeGreaterThan(20);
    expect(casey.inbox.open).toBe(inbox.counts.open);
    expect(casey.inbox.open).toBe(inbox.items.length);
    expect(casey.readiness.pendingProposals).toBe(casey.inbox.open);
  });

  it('T-7: a pound amount reads as pounds, never as dollars', async () => {
    const uk = (await openItems('casey')).items.concat((await as('casey').get<{ items: Item[] }>(`/api/proposals?status=all&period=${P}&kind=rec_match`)).body.items).filter((p) => p.kind === 'rec_match' && p.currency === 'GBP');
    expect(uk.length).toBeGreaterThan(5);
    for (const p of uk) {
      expect(p.why, p.ref).toMatch(/£[\d,]+\.\d{2}/);
      expect(p.why, p.ref).not.toMatch(/\$\d/);
    }
  });

  it('T-5: why someone cannot decide is said in plain words: what it is, who can, and the amounts as money', async () => {
    const sam = await openItems('sam');
    const flux = sam.items.find((p) => p.kind === 'flux_explanation')!;
    expect(flux.blockedBy).toContain('Your role can’t approve variance explanations; the Controller and CFO roles can.');
    for (const p of sam.items) for (const r of p.blockedBy) expect(r, p.ref).not.toMatch(CODE);
    // the inbox names the skill, not its key
    expect(flux.skillTitle).toBe('Flux analysis');
    const payroll = (await openItems('casey')).items.find((p) => /unpaid payroll days/.test(p.title))!;
    expect(payroll.blockedBy).toContainEqual(expect.stringMatching(/^AX-SOD-04: \$[\d,]+\.\d{2} is above your approval limit of \$250,000\.00, so it goes to the CFO\.$/));
    // a refused action says the same, without a permission code
    const refused = await as('sam').post<{ error: { message: string } }>(`/api/proposals/${flux.id}/approve`, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).not.toMatch(CODE);
    const sod = await as('sam').post<{ error: { message: string } }>('/api/admin/sod/SOD-01', { enabled: false, reason: 'Trying to switch a control off' });
    expect(sod.status).toBe(403);
    expect(sod.body.error.message).toBe('Your role can’t configure segregation-of-duties rules; the Admin role can.');
    // the proposal panel says who decides, not which permission
    const detail = (await as('sam').get<{ decisionRoles: string[]; eligibility: { canReject: boolean } }>(`/api/proposals/${flux.id}`)).body;
    expect(detail.decisionRoles).toEqual(['Controller', 'CFO']);
    expect(detail.eligibility.canReject).toBe(false);
  });

  it('T-4: once the agents ran, each person sees their own next step', async () => {
    const casey = await home('casey');
    expect(casey.next.steps.map((s) => s.text)).toContainEqual(expect.stringMatching(/^Decide \d+ items waiting for you in the inbox\.$/));
    const sam = await home('sam');
    expect(sam.next.steps.map((s) => s.text)).toContain('Certify 6 reconciliations as preparer, noting anything still open.');
    const waiting = sam.next.waitingOn.find((w) => /inbox items waiting for someone else/.test(w))!;
    expect(waiting).toMatch(/\d+ for the Controller/);
    expect(waiting).toMatch(/\d+ for the CFO/);
    // an access request waits on the people who may approve it, and the requester sees it waiting
    expect((await as('avery').post('/api/admin/sod/SOD-02', { enabled: false, reason: 'Staffing gap during the audit' })).status).toBe(200);
    expect((await home('casey')).next.steps.map((s) => s.text)).toContain('Decide 1 access request: someone asked to give a person approval authority or to change a control.');
    expect((await home('avery')).next.waitingOn).toContain('1 access request you made, waiting for a second person to approve');
  });

  it('T-7: the checklist counts what still waits from the proposals themselves, so it never contradicts the inbox', async () => {
    const c = (await as('casey').get<Close>(`/api/close/${P}`)).body;
    const fx = c.tasks.find((x) => x.key === 'fx-reval')!;
    expect(c.bySkill['fx-revaluation']).toMatchObject({ title: 'FX remeasurement' });
    expect(fx.notes).not.toMatch(/waiting for a decision/);
    // decide the item; the count follows, and nothing stale is appended to the notes
    for (const p of (await as('casey').get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}`)).body.items.filter((x) => x.skillKey === 'fx-revaluation')) expect((await as('casey').post(`/api/proposals/${p.id}/approve`, {})).status).toBe(200);
    const after = (await as('casey').get<Close>(`/api/close/${P}`)).body;
    expect(after.bySkill['fx-revaluation']!.open).toBe(0);
    expect(after.tasks.find((x) => x.key === 'fx-reval')).toMatchObject({ status: 'ready_for_review', notes: fx.notes });
  });
});

describe('signing off the checklist', () => {
  it('T-10: the named reviewer signs off a task, or someone with at least that authority; never its owner', async () => {
    // put two tasks in front of their reviewers: "Code card transactions and bills" (Sam prepares,
    // Jordan reviews) and "Review journal entries for risk" (Casey owns it, the CFO reviews it)
    await t.fx.db.tx(t.fx.tenantId, async (tx) => {
      for (const key of ['code-transactions', 'je-review']) {
        const task = (await tx.findOne('close_tasks', { key }))!;
        await tx.update('close_tasks', task.id, { status: 'ready_for_review', agent_run_id: null, completed_by: null });
      }
    });
    const tasks = async (k: string) => (await as(k).get<Close>(`/api/close/${P}`)).body.tasks;
    const jeReview = (await tasks('casey')).find((x) => x.key === 'je-review')!;
    expect(jeReview.signOff).toMatchObject({ can: false });
    expect(jeReview.signOff!.blockedBy).toContain('You own this task, so its reviewer signs it off (SOD-01).');
    const byCasey = await as('casey').post<{ error: { message: string } }>(`/api/close/tasks/${jeReview.id}/signoff`, {});
    expect(byCasey.status).toBe(403);
    expect(byCasey.body.error.message).toMatch(/You own this task/);
    // a Senior Accountant does not stand in for the CFO
    const byJordan = await as('jordan').post<{ error: { message: string } }>(`/api/close/tasks/${jeReview.id}/signoff`, {});
    expect(byJordan.status).toBe(403);
    expect(byJordan.body.error.message).toContain('Riley Chen (CFO) reviews this task; signing it off needs at least the CFO’s authority.');
    // its prerequisite first: a Controller may stand in for the Senior Accountant named on it
    const coding = (await tasks('casey')).find((x) => x.key === 'code-transactions')!;
    expect(coding.signOff).toMatchObject({ can: true });
    expect((await as('casey').post(`/api/close/tasks/${coding.id}/signoff`, {})).status).toBe(200);
    expect((await tasks('riley')).find((x) => x.key === 'je-review')!.signOff).toMatchObject({ can: true });
    expect((await as('riley').post(`/api/close/tasks/${jeReview.id}/signoff`, {})).status).toBe(200);
    const done = (await tasks('casey')).find((x) => x.key === 'je-review')!;
    expect(done.status).toBe('done');
  });
});

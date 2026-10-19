/**
 * Variance explanations against the ledger as it stands (independent review, 2026-10-19): an
 * explanation covers the figures it was written for. When a later posting moves them it goes out of
 * date — it stops counting toward the lock, the package marks it and refuses sign-off, drafts for
 * the old figures cannot be approved, and the agent drafts again for the figures as they stand.
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR } from '../../src/core/audit/audit';
import { resolveUserActor } from '../../src/core/auth/actor';
import { AgentRuntime } from '../../src/core/agent/runtime';
import { ScriptedProvider, toolUse } from '../../src/core/llm/scripted';
import { scenarioClock } from '../../src/core/util/time';
import { accountingPack } from '../../src/packs/accounting/agent/pack';
import { approveAndPost, createJournalEntry } from '../../src/packs/accounting/ledger/journal';
import { SCENARIO } from '../../src/packs/accounting/seed/company';
import { AccountingServices } from '../../src/packs/accounting/services';
import { accountingSkills } from '../../src/packs/accounting/skills/install';
import { testApp, type HttpClient, type TestApp } from '../support/app';
import { closeTheMonth } from '../support/full-close';

const P = SCENARIO.closeKey;
const clock = scenarioClock(SCENARIO.businessDate);

interface Line {
  code: string;
  name: string;
  exceeds: boolean;
  currentMinor: number;
  comparativeMinor: number;
  varianceMinor: number;
  explanation: { status: string; stale: boolean; text: string; covered: { varianceMinor: number } | null } | null;
  draft: { proposalId: string; preparedBy: string; current: boolean } | null;
}
interface Readiness {
  unexplainedFlux: number;
  finalPackage: boolean;
  stalePackage: boolean;
  ready: boolean;
  messages: string[];
}
interface Item {
  id: string;
  ref: string;
  status: string;
  canDecide: boolean;
  blockedBy: string[];
  decisionReason: string | null;
  payload: { accountCode: string; currentMinor: number };
  eligibility?: { canDecide: boolean; reasons: string[] };
}

async function signIn(t: TestApp, ...keys: string[]): Promise<HttpClient[]> {
  const out: HttpClient[] = [];
  for (const k of keys) {
    const c = t.client();
    expect((await c.login(k)).status, `sign-in ${k}`).toBe(200);
    out.push(c);
  }
  return out;
}
const fluxOf = async (c: HttpClient, entityId: string) => (await c.get<{ lines: Line[]; explained: number; significant: number }>(`/api/flux?entity=${entityId}&period=${P}`)).body;
const lineOf = async (c: HttpClient, entityId: string, code: string) => (await fluxOf(c, entityId)).lines.find((l) => l.code === code)!;
const readinessOf = async (c: HttpClient) => (await c.get<{ readiness: Readiness }>(`/api/close/${P}`)).body.readiness;

/** A person writes the explanation and the Controller approves it (maker ≠ checker). */
async function explain(writer: HttpClient, approver: HttpClient, entityId: string, accountCode: string, text: string) {
  const w = await writer.post<{ id: string }>('/api/flux/explanations', { entityId, periodKey: P, accountCode, text });
  expect(w.status, JSON.stringify(w.body)).toBe(200);
  const a = await approver.post(`/api/proposals/${w.body.id}/approve`, {});
  expect(a.status, JSON.stringify(a.body)).toBe(200);
}

/** A late adjusting entry on an expense account: Sam prepares it and Casey approves and posts it. */
async function adjust(sam: HttpClient, casey: HttpClient, entityId: string, account: string, minor: number) {
  const je = await sam.post<{ id: string }>('/api/journal', { entityId, postingDate: '2026-09-30', entryType: 'adjusting', memo: 'Late September timesheets', lines: [{ account, debit: minor, department: 'GA' }, { account: '2110', credit: minor }] });
  expect(je.status, JSON.stringify(je.body)).toBe(200);
  const ok = await casey.post(`/api/journal/${je.body.id}/approve`, {});
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
}

describe('variance explanations go out of date when the ledger moves (AX-FLX-01)', () => {
  it('TO-ACC-M1: an approved explanation of a variance a later posting moved stops counting toward the lock', async () => {
    const t = await testApp();
    const [sam, casey] = await signIn(t, 'sam', 'casey');
    const us = t.fx.entityIds.get('BWL-US')!;
    const target = (await fluxOf(casey, us)).lines.find((l) => l.exceeds && l.code.startsWith('6') && !l.explanation)!;
    const before = await readinessOf(casey);

    await explain(sam!, casey!, us, target.code, `${target.name} moved with the September payroll calendar; the timing reverses in October.`);
    const explained = await fluxOf(casey!, us);
    expect(explained.lines.find((l) => l.code === target.code)!.explanation).toMatchObject({ status: 'approved', stale: false, covered: { varianceMinor: target.varianceMinor } });
    expect((await readinessOf(casey!)).unexplainedFlux).toBe(before.unexplainedFlux - 1);

    await adjust(sam!, casey!, us, target.code, 1_234_500);
    const moved = await fluxOf(casey!, us);
    const line = moved.lines.find((l) => l.code === target.code)!;
    expect(line.varianceMinor).toBe(target.varianceMinor + 1_234_500);
    // still the approved text on record, but it explains a change the ledger no longer shows
    expect(line.explanation).toMatchObject({ status: 'approved', stale: true, covered: { varianceMinor: target.varianceMinor } });
    expect(moved.explained).toBe(explained.explained - 1);
    const after = await readinessOf(casey!);
    expect(after.unexplainedFlux).toBe(before.unexplainedFlux);
    expect(after.ready).toBe(false);
    expect(after.messages.join(' ')).toMatch(/significant variances? lacks? an approved explanation/);

    // and it can be explained again, for the variance as it stands
    await explain(sam!, casey!, us, target.code, `${target.name} moved with the September payroll calendar and the late timesheets posted on the 30th.`);
    expect((await lineOf(casey!, us, target.code)).explanation).toMatchObject({ status: 'approved', stale: false, covered: { varianceMinor: target.varianceMinor + 1_234_500 } });
  });

  it('TO-ACC-M1: the package marks an out-of-date explanation and refuses to be signed with one', async () => {
    const t = await testApp();
    const [sam, casey, riley] = await signIn(t, 'sam', 'casey', 'riley');
    const us = t.fx.entityIds.get('BWL-US')!;
    const target = (await fluxOf(casey!, us)).lines.find((l) => l.exceeds && l.code.startsWith('6') && !l.explanation)!;
    const approvedText = `${target.name} moved with the September payroll calendar; the timing reverses in October.`;
    await explain(sam!, casey!, us, target.code, approvedText);

    // the Controller asks for the package while the explanation is current; the CFO approves the draft
    expect((await casey!.post('/api/runs', { skillKey: 'close-package', entityId: null, periodKey: P })).status).toBe(200);
    const report = (await riley!.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}&kind=report`)).body.items[0]!;
    expect((await riley!.post(`/api/proposals/${report.id}/approve`, {})).status).toBe(200);
    const pkg = (await casey!.get<{ packages: { id: string; status: string }[] }>(`/api/close/${P}`)).body.packages[0]!;
    const draft = (await riley!.get<{ content: { commentary: { accountCode: string; entityCode: string; text: string; status?: string }[] } }>(`/api/packages/${pkg.id}`)).body.content;
    expect(draft.commentary.find((c) => c.entityCode === 'BWL-US' && c.accountCode === target.code)).toMatchObject({ text: approvedText, status: 'approved' });

    // a late entry moves the variance before the CFO signs
    await adjust(sam!, casey!, us, target.code, 1_234_500);
    const refused = await riley!.post<{ error: { message: string } }>(`/api/packages/${pkg.id}/finalize`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/^AX-FLX-01: /);
    expect(refused.body.error.message).toContain(`BWL-US ${target.code} ${target.name}: the ledger moved after its explanation was approved`);

    // a package drafted now carries no out-of-date text as if it were approved
    const content = await t.ctx.db.tx(t.fx.tenantId, (tx) => new AccountingServices(tx, SYSTEM_ACTOR, clock).close.packageContent(P, 'test'));
    const c = content.commentary.find((x) => x.entityCode === 'BWL-US' && x.accountCode === target.code)!;
    expect(c).toMatchObject({ status: 'out_of_date', approvedBy: null, varianceMinor: target.varianceMinor + 1_234_500 });
    expect(c.text).not.toContain(approvedText);
    expect(c.text).toMatch(/^The ledger moved after this explanation was written: it explains a change of [+−]\$[\d,]+\.\d\d; it is now [+−]\$[\d,]+\.\d\d\./);
  });

  it('TO-ACC-M1: the lock gate refuses a signed package whose commentary the ledger has since left behind', async () => {
    const t = await testApp();
    // the whole September close, signed and locked; then BWL-US reopens for a late adjustment
    const { people } = await closeTheMonth(t, { runAgents: true });
    const { sam, casey, riley } = people as Record<'sam' | 'casey' | 'riley', HttpClient>;
    const us = t.fx.entityIds.get('BWL-US')!;
    expect((await casey.post(`/api/close/${P}/reopen`, { entityId: us, reason: 'Late timesheets from the payroll provider' })).status).toBe(200);
    expect(await readinessOf(casey)).toMatchObject({ unexplainedFlux: 0, finalPackage: true, stalePackage: false });

    const target = (await fluxOf(casey, us)).lines.find((l) => l.exceeds && l.code.startsWith('6'))!;
    await adjust(sam, casey, us, target.code, 1_234_500);
    const stale = await readinessOf(casey);
    expect(stale).toMatchObject({ unexplainedFlux: 1, finalPackage: true, stalePackage: true, ready: false });
    expect(stale.messages).toContain(`Package v1: BWL-US ${target.code} ${target.name}: the ledger moved after its explanation was approved`);
    expect(stale.messages.some((m) => /^Package v1: it shows consolidated net income of \$[\d,.]+; the ledger now gives \$[\d,.]+$/.test(m))).toBe(true);

    // explained again: the variances are explained, but not in the package that was signed
    await explain(sam, casey, us, target.code, `${target.name}: the September movement, including the late timesheets posted on the 30th.`);
    const reExplained = await readinessOf(casey);
    expect(reExplained).toMatchObject({ unexplainedFlux: 0, stalePackage: true, ready: false });
    expect(reExplained.messages).toContain(`Package v1: BWL-US ${target.code} ${target.name}: the package explains a different change than the ledger now shows`);
    expect(reExplained.messages).toContain('the approved close package no longer matches the books; generate a new version and approve it');
    const refused = await casey.post<{ error: { message: string } }>(`/api/close/${P}/lock`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toContain('the approved close package no longer matches the books');

    // a new version, approved and signed, describes the books as they are: now the period locks
    expect((await casey.post('/api/runs', { skillKey: 'close-package', entityId: null, periodKey: P })).status).toBe(200);
    const report = (await riley.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}&kind=report`)).body.items[0]!;
    expect((await riley.post(`/api/proposals/${report.id}/approve`, {})).status).toBe(200);
    const v2 = (await casey.get<{ packages: { id: string; version: number }[] }>(`/api/close/${P}`)).body.packages[0]!;
    expect(v2.version).toBe(2);
    expect((await riley.post(`/api/packages/${v2.id}/finalize`, {})).status).toBe(200);
    expect(await readinessOf(casey)).toMatchObject({ stalePackage: false, ready: true });
    expect((await casey.post(`/api/close/${P}/lock`, {})).status).toBe(200);
  });

  it('TO-ACC-M1: drafts for figures the ledger has left behind are retired or refused, and the agent drafts again', async () => {
    const t = await testApp();
    const [sam, casey] = await signIn(t, 'sam', 'casey');
    const us = t.fx.entityIds.get('BWL-US')!;
    expect((await sam!.post('/api/runs', { skillKey: 'flux-analysis', entityId: us, periodKey: P })).status).toBe(200);
    const drafted = (await fluxOf(casey!, us)).lines.filter((l) => l.exceeds && l.code.startsWith('6') && l.draft?.current);
    expect(drafted.length).toBeGreaterThanOrEqual(2);
    const [x, y] = drafted as [Line, Line];

    // an entry approved in the app retires the draft written for the old figures
    await adjust(sam!, casey!, us, x.code, 1_234_500);
    const retired = (await casey!.get<Item>(`/api/proposals/${x.draft!.proposalId}`)).body;
    expect(retired.status).toBe('superseded');
    expect(retired.decisionReason).toMatch(/^The ledger moved after this draft was written \(JE-[\w-]+ posted\), so it no longer explains the variance as it stands\./);
    expect((await lineOf(casey!, us, x.code)).draft).toBeNull();

    // a posting that reaches the ledger another way: the stale draft cannot be approved
    await t.ctx.db.tx(t.fx.tenantId, async (tx) => {
      const svc = new AccountingServices(tx, SYSTEM_ACTOR, clock);
      const je = await createJournalEntry(await svc.ctx.ledger(), { entityId: us, postingDate: '2026-09-30', entryType: 'adjusting', memo: 'Imported payroll correction', source: 'import', preparedBy: t.fx.userIds.get('jordan')!, lines: [{ account: y.code, debit: 765_400, department: 'GA' }, { account: '2110', credit: 765_400 }], autoReverseOn: null }, 'pending_approval');
      await approveAndPost(await svc.ctx.ledger(), je.id, { route: 'human', approverId: t.fx.userIds.get('casey')! });
    });
    const open = (await casey!.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}&kind=flux_explanation`)).body.items.find((i) => i.id === y.draft!.proposalId)!;
    expect(open.canDecide).toBe(false);
    expect(open.blockedBy.join(' ')).toMatch(/^The ledger moved after this explanation was written: it explains a change of [+−]\$[\d,]+\.\d\d; it is now [+−]\$[\d,]+\.\d\d\./);
    const refused = await casey!.post<{ error: { message: string } }>(`/api/proposals/${y.draft!.proposalId}/approve`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('The ledger moved after this explanation was written');

    // the agent drafts both again for the figures as they stand; the outdated draft is replaced
    expect((await sam!.post('/api/runs', { skillKey: 'flux-analysis', entityId: us, periodKey: P })).status).toBe(200);
    const redrafted = await fluxOf(casey!, us);
    for (const l of [x, y]) {
      const now = redrafted.lines.find((z) => z.code === l.code)!;
      expect(now.draft, l.code).toMatchObject({ current: true });
      expect(now.draft!.proposalId).not.toBe(l.draft!.proposalId);
      const p = (await casey!.get<Item>(`/api/proposals/${now.draft!.proposalId}`)).body;
      expect(p.payload.currentMinor).toBe(now.currentMinor);
      expect(p.eligibility).toMatchObject({ canDecide: true, reasons: [] });
    }
    expect((await casey!.get<Item>(`/api/proposals/${y.draft!.proposalId}`)).body.status).toBe('superseded');
    expect((await casey!.post(`/api/proposals/${redrafted.lines.find((z) => z.code === y.code)!.draft!.proposalId}/approve`, {})).status).toBe(200);
  });

  it('TO-ACC-M1: the agent leaves alone a variance a person already explained for the figures as they stand', async () => {
    const t = await testApp();
    const [sam, casey] = await signIn(t, 'sam', 'casey');
    const us = t.fx.entityIds.get('BWL-US')!;
    const target = (await fluxOf(casey!, us)).lines.find((l) => l.exceeds && !l.explanation)!;
    const w = await sam!.post<{ id: string }>('/api/flux/explanations', { entityId: us, periodKey: P, accountCode: target.code, text: `${target.name}: explained by the September drivers, written by Sam.` });
    expect(w.status).toBe(200);
    expect((await casey!.post('/api/runs', { skillKey: 'flux-analysis', entityId: us, periodKey: P })).status).toBe(200);
    const drafts = (await casey!.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}&kind=flux_explanation`)).body.items;
    const forTarget = [];
    for (const d of drafts) if ((await casey!.get<Item>(`/api/proposals/${d.id}`)).body.payload.accountCode === target.code) forTarget.push(d.id);
    expect(forTarget).toEqual([w.body.id]);
  });

  it('TO-ACC-M1: in live mode, an explanation of figures the ledger does not show is refused by the verifier', async () => {
    const t = await testApp();
    const us = t.fx.entityIds.get('BWL-US')!;
    const l = await t.ctx.db.tx(t.fx.tenantId, async (tx) => (await new AccountingServices(tx, SYSTEM_ACTOR, clock).flux.compute(us, P)).lines.find((x) => x.exceeds)!);
    // the model restates the variance a little off (and keeps its own arithmetic and drivers consistent)
    const current = l.currentMinor + 10_000;
    const explanation = { entityId: us, periodKey: P, comparison: 'pop', accountCode: l.code, currentMinor: current, comparativeMinor: l.comparativeMinor, budgetMinor: l.budgetMinor, varianceMinor: current - l.comparativeMinor, variancePct: null, thresholdAbsMinor: 1_000_000, thresholdPct: 0.1, materiality: l.materiality, text: `${l.name} changed by the amount shown, for the reasons in the drivers.`, drivers: [{ label: 'Everything', kind: 'other', amountMinor: current - l.comparativeMinor }], pending: [] };
    const llm = new ScriptedProvider([
      toolUse('tu_1', 'propose__flux_explanation', { title: `Explain ${l.code}`, why: 'The change exceeds the review threshold.', confidence: 0.8, evidence: [{ kind: 'computation', label: 'flux' }], dedupeKey: `live:${l.code}`, explanation }),
      toolUse('tu_2', 'finish', { headline: 'Drafted one explanation', notes: [] }),
    ]);
    const rt = new AgentRuntime({ db: t.fx.db, clock, pack: accountingPack, skills: accountingSkills(), llm, resolveActor: resolveUserActor });
    const run = await rt.start({ tenantId: t.fx.tenantId, skillKey: 'flux-analysis', entityId: us, periodKey: P, requestedBy: t.fx.userIds.get('devon')!, mode: 'live' });
    expect(run.status).toBe('succeeded');
    expect(await t.fx.db.tx(t.fx.tenantId, (tx) => tx.find('proposals', { run_id: run.id }))).toHaveLength(0);
    const reply = (llm.requests[1]!.messages.at(-1)!.content[0] as { content: string }).content;
    expect(reply).toContain('rejected_by_verifier');
    expect(reply).toMatch(/AX-FLX-01: the ledger shows \$[\d,]+\.\d\d this month against \$[\d,]+\.\d\d, not the figures given/);
  });
});

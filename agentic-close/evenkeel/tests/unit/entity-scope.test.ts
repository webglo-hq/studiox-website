import { describe, expect, it } from 'vitest';
import { invoke } from '../../src/app/methods';
import { periodEnd } from '../../src/framework/util/dates';
import { makeContext } from '../../src/packs/accounting/domain/context';
import { loadActor } from '../../src/packs/accounting/domain/rbac';
import { accountByCode } from '../../src/packs/accounting/domain/refdata';
import { SCENARIO, type UserKey } from '../../src/packs/accounting/seed/scenario';
import { loadTestScenario, type Scenario } from '../shared/scenario';

/**
 * Entity scope (EK-M2): an administrator limits a person's roles to some entities, and every read
 * and change refuses or filters out records of the other entities, along with the views that span
 * entities (consolidation, the close package, the audit log).
 */

type Call = (name: string, input?: Record<string, unknown>) => Promise<unknown>;
const caller = (s: Scenario, k: UserKey): Call => (name, input = {}) => invoke(s.env, { userId: s.user(k) }, name, input);
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'FORBIDDEN' });

/** Limit someone to the given entities the way the reviewer did: grants written straight to the database. */
async function scopeTo(s: Scenario, k: UserKey, codes: ('US' | 'UK')[]): Promise<void> {
  const grants = await s.db.find('user_role', { user_id: s.user(k) });
  for (const g of grants) {
    await s.db.delete('user_role', g.id);
    for (const c of codes) await s.db.insert('user_role', { tenant_id: s.info.tenantId, user_id: g.user_id, role_id: g.role_id, entity_id: s.info.entities[c], granted_by: null });
  }
}

async function manualDraft(s: Scenario, code: 'US' | 'UK') {
  const ctx = makeContext(s.db, s.info.tenantId, await loadActor(s.db, s.info.tenantId, s.user('casey')), s.clock);
  const [dr, cr] = [await accountByCode(ctx, '1200'), await accountByCode(ctx, '2100')];
  return {
    entityId: s.info.entities[code],
    entryDate: periodEnd(SCENARIO.openPeriod),
    periodKey: SCENARIO.openPeriod,
    entryType: 'adjusting',
    memo: 'Entity scope probe',
    currency: code === 'US' ? 'USD' : 'GBP',
    lines: [
      { accountId: dr.id, debit: 10_000, credit: 0 },
      { accountId: cr.id, debit: 0, credit: 10_000 },
    ],
  };
}

describe('entity scope', () => {
  it('EK-M2: an administrator limits a person’s roles to some entities from the admin console', async () => {
    const s = await loadTestScenario();
    const taylor = caller(s, 'taylor');
    const priya = () => (taylor('admin.users') as Promise<{ id: string; roles: string[]; entities: unknown }[]>).then((us) => us.find((u) => u.id === s.user('priya'))!);
    expect((await priya()).entities).toBe('all');
    await taylor('admin.setRoles', { userId: s.user('priya'), roles: ['senior_accountant'], entities: ['UK'] });
    expect(await priya()).toMatchObject({ roles: ['senior_accountant'], entities: ['UK'] });
    expect((await loadActor(s.db, s.info.tenantId, s.user('priya'))).entityScope).toEqual([s.info.entities.UK]);
    // Changing roles alone keeps the scope; unknown or empty entity lists are refused.
    await taylor('admin.setRoles', { userId: s.user('priya'), roles: ['senior_accountant', 'staff_accountant'] });
    expect(await priya()).toMatchObject({ entities: ['UK'] });
    await expect(taylor('admin.setRoles', { userId: s.user('priya'), roles: ['senior_accountant'], entities: ['FR'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(taylor('admin.setRoles', { userId: s.user('priya'), roles: ['senior_accountant'], entities: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
    const audit = await s.db.find('audit_log', { tenant_id: s.info.tenantId, action: 'admin.roles.changed' });
    expect(audit.map((a) => (a.data as { entities?: unknown }).entities)).toContainEqual(['UK']);
    await taylor('admin.setRoles', { userId: s.user('priya'), roles: ['senior_accountant'], entities: 'all' });
    expect((await priya()).entities).toBe('all');
  }, 120_000);

  it('EK-M2: a person limited to the UK reads nothing of the US, nor the views that span entities', async () => {
    const s = await loadTestScenario();
    await s.engine.orchestrate(null, s.user('casey'));
    await scopeTo(s, 'priya', ['UK']);
    const priya = caller(s, 'priya');
    const US = s.info.entities.US;
    const UK = s.info.entities.UK;

    expect(((await priya('journals.reference')) as { entities: { code: string }[] }).entities.map((e) => e.code)).toEqual(['UK']);
    await refused(priya('journals.list', { entityCode: 'US' }));
    const entries = (await priya('journals.list', { limit: 200 })) as { items: { id: string; entityCode: string }[] };
    expect(entries.items.length).toBeGreaterThan(0);
    expect(new Set(entries.items.map((e) => e.entityCode))).toEqual(new Set(['UK']));
    const usEntry = (await s.db.find('journal_entry', { tenant_id: s.info.tenantId, entity_id: US }, { limit: 1 }))[0]!;
    await refused(priya('journals.get', { id: usEntry.id }));

    await refused(priya('reports.trialBalance', { scope: 'US' }));
    await refused(priya('reports.trialBalance', { scope: 'consolidated' }));
    await refused(priya('reports.statement', { kind: 'BS', scope: 'US' }));
    await expect(priya('reports.trialBalance', { scope: 'UK' })).resolves.toBeTruthy();
    const usLine = (await s.db.find('journal_line', { journal_entry_id: usEntry.id }))[0]!;
    await refused(priya('reports.activity', { accountId: usLine.account_id, scope: 'US' }));

    await refused(priya('flux.view', { entityCode: 'US', comparison: 'prior_month' }));
    await expect(priya('flux.view', { entityCode: 'UK', comparison: 'prior_month' })).resolves.toBeTruthy();

    const recs = (await priya('recs.list')) as { id: string; entityId: string }[];
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.entityId === UK)).toBe(true);
    const usRec = (await s.db.find('reconciliation', { tenant_id: s.info.tenantId, entity_id: US }))[0]!;
    await refused(priya('recs.get', { id: usRec.id }));

    const inbox = (await priya('inbox.list', { tab: 'all', limit: 500 })) as { items: { id: string; entityCode: string | null }[] };
    expect(inbox.items.length).toBeGreaterThan(0);
    expect(inbox.items.every((p) => p.entityCode === 'UK')).toBe(true);
    const usProposal = (await s.db.find('proposal', { tenant_id: s.info.tenantId, entity_id: US }))[0]!;
    await refused(priya('inbox.get', { id: usProposal.id }));

    const runs = (await priya('runs.list', { limit: 500 })) as { id: string }[];
    for (const r of runs) expect((await s.db.get('agent_run', r.id))!.entity_id).toBe(UK);
    const usRun = (await s.db.find('agent_run', { tenant_id: s.info.tenantId, entity_id: US }))[0]!;
    await refused(priya('runs.get', { id: usRun.id }));

    const issues = (await priya('issues.list')) as { entityCode: string | null }[];
    expect(issues.every((i) => i.entityCode === 'UK')).toBe(true);
    const calendar = (await priya('close.calendar')) as { tasks: { entityCode: string | null; lastRun: { summary: string | null } | null; recs: { id: string }[] }[] };
    // The calendar is shared, but what other entities' runs found is not, nor their reconciliations.
    for (const t of calendar.tasks) {
      if (t.entityCode !== 'UK') expect(t.lastRun?.summary ?? null).toBeNull();
      for (const rc of t.recs) expect((await s.db.get('reconciliation', rc.id))!.entity_id).toBe(UK);
    }

    await refused(priya('package.list'));
    await refused(priya('audit.list'));
    const home = (await priya('home.myClose')) as { headline: unknown };
    expect(home.headline).toBeNull();

    // Someone with every entity still sees the US.
    await expect(caller(s, 'casey')('journals.list', { entityCode: 'US', limit: 1 })).resolves.toBeTruthy();
  }, 180_000);

  it('EK-M2: a person limited to the UK changes nothing of the US', async () => {
    const s = await loadTestScenario();
    await s.engine.orchestrate(null, s.user('casey'));
    await scopeTo(s, 'priya', ['UK']);
    const priya = caller(s, 'priya');
    const US = s.info.entities.US;

    const pending = (await s.db.find('proposal', { tenant_id: s.info.tenantId, entity_id: US, status: 'pending' }))[0]!;
    const decided = (await priya('inbox.decide', { ids: [pending.id], decision: 'approve' })) as { results: { ok: boolean; error?: string }[] };
    expect(decided.results[0]!.ok).toBe(false);
    expect((await s.db.get('proposal', pending.id))!.status).toBe('pending');

    await refused(priya('journals.create', { draft: await manualDraft(s, 'US'), submit: false }));
    await expect(priya('journals.create', { draft: await manualDraft(s, 'UK'), submit: false })).resolves.toBeTruthy();

    const cycle = (await s.db.findOne('close_cycle', { tenant_id: s.info.tenantId, period_key: SCENARIO.openPeriod }))!;
    const usTask = (await s.db.find('close_task', { close_cycle_id: cycle.id, entity_id: US })).find((t) => t.skill_id)!;
    await refused(priya('close.runTask', { taskId: usTask.id }));
    await refused(priya('close.updateTask', { taskId: usTask.id, action: 'start' }));
    await refused(priya('close.orchestrate'));
    const usIssue = (await s.db.find('issue', { tenant_id: s.info.tenantId, entity_id: US }))[0];
    if (usIssue) await refused(priya('issues.update', { issueId: usIssue.id, action: 'acknowledge' }));
  }, 180_000);
});

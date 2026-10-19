import { beforeAll, describe, expect, it } from 'vitest';
import type { ApiKernel } from '../../src/api/kernel';
import type { App } from '../../src/app/app';
import type { SeedResult } from '../../src/packs/accounting/seed/loader';
import { configurePasswordHashing, DEMO_SCRYPT } from '../../src/security/passwords';
import { Client, seededKernel } from './api-client';

configurePasswordHashing({ params: DEMO_SCRYPT });

interface Item {
  id: string;
  entity: string | null;
  title: string;
  canApprove: boolean;
  amount: number;
}
const PASSWORD = 'tidal-meadow-copper-17';

/**
 * BH-M1: roles could not be limited to an entity in practice (principal.entityIds was computed and never used), so
 * a person meant for the UK books saw and decided US work. An admin now grants a role for one entity (with dual
 * control), and every read and write path keeps that person inside it.
 */
describe('entity scope (BH-M1)', () => {
  let app: App;
  let kernel: ApiKernel;
  let seed: SeedResult;
  let email: (key: string) => string;
  let uma: Client;
  let ids: { us: string; uk: string };

  beforeAll(async () => {
    ({ app, kernel, seed, email } = await seededKernel());
    const entities = await app.read((tx) => tx.find('entities', { tenant_id: seed.tenantId }));
    ids = { us: entities.find((e) => e.code === 'BW-US')!.id, uk: entities.find((e) => e.code === 'BW-UK')!.id };
    const maya = new Client(kernel, '10.8.0.1');
    await maya.login(email('maya'));
    expect((await maya.call('POST', `/api/closes/${seed.closeId}/run`, {})).status).toBe(202);
    await app.queue.idle();

    // The admin grants a Senior Accountant role for the UK entity only; the Controller approves it.
    const tom = new Client(kernel, '10.8.0.2');
    await tom.login(email('tom'));
    const created = await tom.ok<{ pending: { id: string; summary: string } }>('POST', '/api/admin/users', { email: 'uma.patel@brambleway.example', name: 'Uma Patel', roles: [{ role: 'senior_accountant', entity: 'BW-UK' }] });
    expect(created.pending.summary).toBe('Grant Senior Accountant (BW-UK only) to Uma Patel');
    const hannah = new Client(kernel, '10.8.0.3');
    await hannah.login(email('hannah'));
    await hannah.ok('POST', `/api/admin/access-requests/${created.pending.id}/decide`, { decision: 'approve' });
    const grants = await app.read(async (tx) => tx.find('user_roles', { user_id: (await tx.findOne('users', { email: 'uma.patel@brambleway.example' }))!.id }));
    expect(grants.map((g) => g.entity_id)).toEqual([ids.uk]);

    const inbox = new Client(kernel, '10.8.0.4');
    const mail = await inbox.ok<{ messages: Array<{ link: string | null }> }>('POST', '/api/auth/delivery-log', { to: 'uma.patel@brambleway.example' });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.messages[0]!.link ?? '')![1]!;
    await inbox.ok('POST', '/api/auth/credential-link', { token, password: PASSWORD });
    uma = new Client(kernel, '10.8.0.5');
    expect((await uma.login('uma.patel@brambleway.example', PASSWORD)).status).toBe(200);
  }, 240_000);

  it('BH-M1: reads show only the granted entity, and other entities\' objects do not exist for the person', async () => {
    const all = await uma.ok<{ items: Item[]; counts: { pending: number } }>('GET', '/api/proposals?view=all&limit=500');
    expect(all.items.length).toBeGreaterThan(0);
    expect(new Set(all.items.map((i) => i.entity))).toEqual(new Set(['BW-UK']));
    const usProposal = (await app.read((tx) => tx.find('proposals', { tenant_id: seed.tenantId, entity_id: ids.us }, { limit: 1 })))[0]!;
    const orgProposal = (await app.read((tx) => tx.find('proposals', { tenant_id: seed.tenantId, entity_id: null }, { limit: 1 })))[0];
    expect((await uma.call('GET', `/api/proposals/${usProposal.id}`)).status).toBe(404);
    if (orgProposal) expect((await uma.call('GET', `/api/proposals/${orgProposal.id}`)).status).toBe(404);
    expect((await uma.ok<{ items: Item[] }>('GET', '/api/proposals?view=all&entity=BW-US')).items).toEqual([]);

    const entries = await uma.ok<{ entries: Array<{ entity: string }> }>('GET', '/api/journal-entries?limit=200');
    expect(entries.entries.length).toBeGreaterThan(0);
    expect(new Set(entries.entries.map((e) => e.entity))).toEqual(new Set(['BW-UK']));
    const usEntry = (await app.read((tx) => tx.find('journal_entries', { entity_id: ids.us, status: 'posted' }, { limit: 1 })))[0]!;
    expect((await uma.call('GET', `/api/journal-entries/${usEntry.id}`)).status).toBe(404);

    expect((await uma.call('GET', '/api/reports/trial-balance?entity=BW-UK')).status).toBe(200);
    expect((await uma.call('GET', '/api/reports/trial-balance?entity=BW-US')).status).toBe(404);
    expect((await uma.call('GET', '/api/reports/trial-balance')).status).toBe(403);
    expect((await uma.call('GET', '/api/reports/statements?entity=consolidated')).status).toBe(403);
    const activity = await uma.ok<{ lines: Array<{ entity: string }> }>('GET', '/api/reports/activity?account=1000');
    expect(activity.lines.every((l) => l.entity === 'BW-UK')).toBe(true);

    const recs = await uma.ok<{ recs: Array<{ id: string | null; entity: string }> }>('GET', '/api/recs');
    expect(recs.recs.length).toBeGreaterThan(0);
    expect(new Set(recs.recs.map((r) => r.entity))).toEqual(new Set(['BW-UK']));
    const usRec = (await app.read((tx) => tx.find('reconciliations', { entity_id: ids.us }, { limit: 1 })))[0]!;
    expect((await uma.call('GET', `/api/recs/${usRec.id}`)).status).toBe(404);

    const close = await uma.ok<{ tasks: Array<{ entity: string | null }>; canRunAgents: boolean }>('GET', `/api/closes/${seed.closeId}`);
    expect(close.tasks.length).toBeGreaterThan(0);
    expect(new Set(close.tasks.map((t) => t.entity))).toEqual(new Set(['BW-UK']));
    expect(close.canRunAgents).toBe(false);
    const runs = await uma.ok<Array<{ id: string }>>('GET', '/api/runs?limit=200');
    const runEntities = await app.read((tx) => tx.find('agent_runs', { id: { in: runs.map((r) => r.id) } }));
    expect(runEntities.every((r) => r.entity_id === ids.uk)).toBe(true);
    expect(((await uma.ok<{ analyses: unknown[] }>('GET', '/api/flux')).analyses)).toEqual([]);
    expect((await uma.call('GET', `/api/closes/${seed.closeId}/package`)).status).toBe(403);
    expect((await uma.call('GET', '/api/audit')).status).toBe(403);
    expect((await uma.ok<{ entities: Array<{ code: string }> }>('GET', '/api/reference')).entities.map((e) => e.code)).toEqual(['BW-UK']);
    const home = JSON.stringify(await uma.ok('GET', '/api/home'));
    expect(home).not.toMatch(/BW-US|Brambleway US/);
  });

  it('BH-M1: writes on another entity\'s objects are refused; the granted entity works', async () => {
    const usPending = (await app.read((tx) => tx.find('proposals', { tenant_id: seed.tenantId, entity_id: ids.us, status: 'pending' }, { limit: 1 })))[0]!;
    expect((await uma.call('POST', `/api/proposals/${usPending.id}/approve`, {})).status).toBe(404);
    expect((await uma.call('POST', `/api/proposals/${usPending.id}/reject`, { reason: 'not mine to decide' })).status).toBe(404);
    const bulk = await uma.ok<{ ok: number; results: Array<{ ok: boolean; error?: string }> }>('POST', '/api/proposals/bulk', { ids: [usPending.id], decision: 'reject', reason: 'not mine to decide' });
    expect(bulk.ok).toBe(0);
    expect((await app.read((tx) => tx.get('proposals', usPending.id)))?.status).toBe('pending');

    const draft = { entity: 'BW-US', date: '2026-09-30', type: 'adjusting', description: 'Cross-entity attempt', lines: [{ account: '6420', debit: 10_000, department: 'ENG' }, { account: '2100', credit: 10_000 }] };
    expect((await uma.call('POST', '/api/journal-entries', draft)).status).toBe(403);
    const usEntry = (await app.read((tx) => tx.find('journal_entries', { entity_id: ids.us, status: 'posted', entry_type: 'standard' }, { limit: 1 })))[0]!;
    expect((await uma.call('POST', `/api/journal-entries/${usEntry.id}/reverse`, { reason: 'cross-entity attempt' })).status).toBe(404);

    const usRec = (await app.read((tx) => tx.find('reconciliations', { entity_id: ids.us }, { limit: 1 })))[0]!;
    expect((await uma.call('POST', `/api/recs/${usRec.id}/sign`, { role: 'reviewer' })).status).toBe(404);
    expect((await uma.call('POST', '/api/recs/start', { entityId: ids.us, periodId: usRec.period_id, account: '1100' })).status).toBe(404);
    const usTask = (await app.read((tx) => tx.find('close_tasks', { close_id: seed.closeId, entity_id: ids.us }, { limit: 1 })))[0]!;
    expect((await uma.call('POST', `/api/tasks/${usTask.id}/complete`, {})).status).toBe(404);
    expect((await uma.call('POST', `/api/tasks/${usTask.id}/run`, {})).status).toBe(404);
    expect((await uma.call('POST', `/api/closes/${seed.closeId}/run`, {})).status).toBe(403);
    const fluxLine = (await app.read((tx) => tx.find('flux_lines', { tenant_id: seed.tenantId, is_material: true }, { limit: 1 })))[0];
    if (fluxLine) expect((await uma.call('POST', `/api/flux/lines/${fluxLine.id}/explain`, { text: 'A cross-entity explanation attempt that should never land.' })).status).toBe(404);

    // Maya prepares an entry in each entity: Uma approves the UK one and cannot even see the US one.
    const maya = new Client(kernel, '10.8.0.6');
    await maya.login(email('maya'));
    const entry = (entity: string) => ({ entity, date: '2026-09-30', type: 'adjusting', description: `Software true-up ${entity}`, lines: [{ account: '6420', debit: 48_000, department: 'ENG' }, { account: '2100', credit: 48_000 }] });
    const us = (await maya.ok<{ entry: { id: string } }>('POST', '/api/journal-entries', entry('BW-US'))).entry;
    const uk = (await maya.ok<{ entry: { id: string } }>('POST', '/api/journal-entries', entry('BW-UK'))).entry;
    expect((await uma.call('POST', `/api/journal-entries/${us.id}/approve`, {})).status).toBe(404);
    expect((await uma.call('POST', `/api/journal-entries/${us.id}/reject`, { reason: 'not my entity' })).status).toBe(404);
    expect((await uma.ok<{ canApprove: boolean }>('GET', `/api/journal-entries/${uk.id}`)).canApprove).toBe(true);
    expect((await uma.call('POST', `/api/journal-entries/${uk.id}/approve`, {})).status).toBe(200);
    expect((await app.read((tx) => tx.get('journal_entries', us.id)))?.status).toBe('pending_approval');
    expect((await app.read((tx) => tx.get('journal_entries', uk.id)))?.status).toBe('posted');
  });

  it('BH-M1: approval limits and authority come only from grants that cover the entity', async () => {
    // Diego is an AP Clerk ($2,500) for every entity; he becomes Controller for the UK only (dual control).
    const tom = new Client(kernel, '10.8.1.1');
    await tom.login(email('tom'));
    const diego = await app.read((tx) => tx.findOne('users', { email: email('diego') }));
    const res = await tom.ok<{ pending: { id: string } }>('PUT', `/api/admin/users/${diego!.id}/roles`, { roles: ['ap_clerk', { role: 'controller', entity: 'BW-UK' }], reason: 'UK statutory sign-off' });
    const marcus = new Client(kernel, '10.8.1.2');
    await marcus.login(email('marcus'));
    await marcus.ok('POST', `/api/admin/access-requests/${res.pending.id}/decide`, { decision: 'approve' });
    const d = new Client(kernel, '10.8.1.3');
    await d.login(email('diego'));
    // A $15,000 US accrual stays above his US limit ($2,500) although he approves up to $500,000 in the UK.
    const items = (await d.ok<{ items: Array<Item & { blocks: string[] }> }>('GET', '/api/proposals?view=pending&limit=500')).items;
    const accrual = items.find((i) => i.entity === 'BW-US' && /^Accrue Brightline Facilities/.test(i.title))!;
    expect(accrual.canApprove).toBe(false);
    expect(accrual.blocks.join(' ')).toMatch(/above your approval limit of \$2,500\.00/);
    expect((await d.call('POST', `/api/proposals/${accrual.id}/approve`, {})).status).toBe(403);
    // Whole-organization controls (locking the close, policies) need a Controller grant for every entity.
    expect((await d.call('POST', `/api/closes/${seed.closeId}/lock`, {})).status).toBe(403);
    expect((await d.call('PUT', '/api/skills/flux-analysis/policy', { autonomy: 'L1', reason: 'UK controller tries a group policy' })).status).toBe(403);
    expect((await d.ok<{ canEdit: boolean; canSetAutonomy: boolean }>('GET', '/api/skills/flux-analysis'))).toMatchObject({ canEdit: false, canSetAutonomy: false });
  });
});

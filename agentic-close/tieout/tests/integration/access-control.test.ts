/**
 * Nobody can mint an approver alone (independent review, 2026-10-19). An administrator never
 * receives or sees a credential: invitations and password resets send the person a single-use,
 * expiring link through the outbox (in the demo, the demo mailbox, which opens a message only for a
 * signed-out browser and records every opening). A grant that confers approval authority, and any
 * change to a segregation-of-duties rule, takes effect only when a second, different person with
 * sufficient authority approves it; the requester never can.
 */
import { describe, expect, it } from 'vitest';
import { SCENARIO } from '../../src/packs/accounting/seed/company';
import { readMail, testApp, type HttpClient, type TestApp } from '../support/app';

const P = SCENARIO.closeKey;
interface AdminView {
  users: { id: string; name: string; email: string; roles: string[]; scope: string[] | null; status: string }[];
  entities: { id: string; code: string }[];
}
interface Request {
  id: string;
  ref: string;
  status: string;
  summary: string;
  canDecide: boolean;
  blockedBy: string[];
}

async function as(t: TestApp, key: string): Promise<HttpClient> {
  const c = t.client();
  expect((await c.login(key)).status, `sign-in ${key}`).toBe(200);
  return c;
}
const me = async (c: HttpClient) => (await c.get<{ user: { roles: string[]; permissions: string[] } }>('/api/auth/me')).body.user;
async function signInWith(t: TestApp, email: string, password: string): Promise<HttpClient> {
  const c = t.client();
  const r = await c.post<{ csrfToken: string }>('/api/auth/login', { email, password });
  expect(r.status, `sign-in ${email}`).toBe(200);
  c.csrf = r.body.csrfToken;
  return c;
}

describe('an administrator cannot mint an approver', () => {
  it('TO-C1: inviting a CFO gives the administrator no credential, and the role waits for a second person with the authority', async () => {
    const t = await testApp();
    const [avery, jordan, casey, riley] = [await as(t, 'avery'), await as(t, 'jordan'), await as(t, 'casey'), await as(t, 'riley')];
    const invite = await avery.post<{ userId: string; sent: { to: string; expiresAt: string }; pending: { id: string; ref: string } }>('/api/admin/users', { email: 'nora.bell@bramblewood.example', name: 'Nora Bell', title: 'Interim CFO', role: 'cfo' });
    expect(invite.status).toBe(200);
    expect(JSON.stringify(invite.body)).not.toMatch(/tkl_|tempPassword|password/i);
    expect(invite.body.sent.to).toContain('nora.bell@bramblewood.example');
    expect(invite.body.pending.ref).toMatch(/^AR-\d{4}$/);
    expect(JSON.stringify((await avery.get('/api/admin')).body)).not.toContain('tkl_');

    // the administrator's own session cannot open the invitation (the mailbox belongs to Nora)
    const box = (await avery.get<{ messages: { id: string; to: string }[] }>('/api/demo/mailbox')).body.messages;
    const forNora = box.find((m) => m.to === 'nora.bell@bramblewood.example')!;
    const peek = await avery.post<{ error: { message: string } }>(`/api/demo/mailbox/${forNora.id}/open`, {});
    expect(peek.status).toBe(403);
    expect(peek.body.error.message).toMatch(/^Sign out first/);

    // Nora sets her own password with the link; she signs in, but holds no role yet
    const { token, text } = await readMail(t, 'nora.bell@bramblewood.example');
    expect(text).toContain('the role starts once a second person approves it');
    expect((await t.client().post('/api/auth/link', { token, password: 'nora-chooses-her-own-passphrase' })).status).toBe(200);
    const nora = await signInWith(t, 'nora.bell@bramblewood.example', 'nora-chooses-her-own-passphrase');
    expect(await me(nora)).toMatchObject({ roles: [] });
    expect((await me(nora)).permissions).not.toContain('je.approve');

    // the payroll accrual the reviewer had a minted CFO approve
    const run = await jordan.post<{ status: string }>('/api/runs', { skillKey: 'accrual-detection', entityId: t.fx.entityIds.get('BWL-US'), periodKey: P });
    expect(run.body.status).toBe('succeeded');
    const payroll = (await riley.get<{ items: { id: string; title: string }[] }>(`/api/proposals?status=open&period=${P}&q=payroll%20days`)).body.items[0]!;
    expect((await nora.post(`/api/proposals/${payroll.id}/approve`, {})).status).toBe(403);

    // the requester cannot approve, a Controller has less authority than a CFO, the CFO can
    const r = invite.body.pending;
    expect((await avery.post(`/api/access-requests/${r.id}/approve`, {})).status).toBe(403);
    const forCasey = (await casey.get<{ items: Request[] }>('/api/access-requests')).body.items.find((x) => x.id === r.id)!;
    expect(forCasey).toMatchObject({ status: 'pending', canDecide: false });
    expect(forCasey.blockedBy).toContain('This grant carries a higher approval limit than your own.');
    expect((await casey.post(`/api/access-requests/${r.id}/approve`, {})).status).toBe(403);
    expect((await riley.post(`/api/access-requests/${r.id}/approve`, { note: 'Board appointment confirmed' })).status).toBe(200);
    expect((await me(nora)).roles).toEqual(['cfo']);
    expect((await avery.get<{ items: Request[] }>('/api/access-requests')).body.items.find((x) => x.id === r.id)!.status).toBe('approved');
  });

  it('TO-C1: adding approval authority to someone waits for a second person; narrowing or preparer roles do not', async () => {
    const t = await testApp();
    const [avery, casey] = [await as(t, 'avery'), await as(t, 'casey')];
    const admin = (await avery.get<AdminView>('/api/admin')).body;
    const sam = admin.users.find((u) => u.name === 'Sam Rivera')!;
    const uk = admin.entities.find((e) => e.code === 'BWL-UK')!;
    const ask = await avery.post<{ pending?: { id: string } }>(`/api/admin/users/${sam.id}/roles`, { roles: ['staff_accountant', 'senior_accountant'], reason: 'Covering for Jordan during the October close' });
    expect(ask.status).toBe(200);
    expect(ask.body.pending?.id).toBeTruthy();
    const s = await as(t, 'sam');
    expect((await me(s)).roles).toEqual(['staff_accountant']);
    expect((await casey.post(`/api/access-requests/${ask.body.pending!.id}/approve`, {})).status).toBe(200);
    expect((await me(s)).roles.sort()).toEqual(['senior_accountant', 'staff_accountant']);
    // narrowing access needs nobody else
    const narrow = await avery.post<{ pending?: unknown; entityScope: string[] }>(`/api/admin/users/${sam.id}/roles`, { roles: ['staff_accountant', 'senior_accountant'], entityIds: [uk.id] });
    expect(narrow.body.pending).toBeUndefined();
    expect(narrow.body.entityScope).toEqual(['BWL-UK']);
    // widening it again is new authority (over BWL-US)
    expect((await avery.post<{ pending?: unknown }>(`/api/admin/users/${sam.id}/roles`, { roles: ['staff_accountant', 'senior_accountant'] })).body.pending).toBeTruthy();
    // a preparer role carries no approval authority
    expect((await avery.post<{ pending?: unknown }>(`/api/admin/users/${sam.id}/roles`, { roles: ['staff_accountant', 'ap_specialist'] })).body.pending).toBeUndefined();
  });

  it('TO-C1: switching off a segregation-of-duties control waits for a second person, who is never the requester', async () => {
    const t = await testApp();
    const [avery, casey] = [await as(t, 'avery'), await as(t, 'casey')];
    const ask = await avery.post<{ enabled: boolean; pending: { id: string; ref: string } }>('/api/admin/sod/SOD-01', { enabled: false, reason: 'Single-person cover over the holidays' });
    expect(ask.status).toBe(200);
    const rule = async () => (await avery.get<{ sod: { code: string; enabled: boolean }[] }>('/api/admin')).body.sod.find((r) => r.code === 'SOD-01')!.enabled;
    expect(await rule()).toBe(true);
    expect((await avery.post(`/api/access-requests/${ask.body.pending.id}/approve`, {})).status).toBe(403);
    expect((await casey.post(`/api/access-requests/${ask.body.pending.id}/reject`, { reason: 'Maker-checker stays on; arrange cover instead' })).status).toBe(200);
    expect(await rule()).toBe(true);
    const again = await avery.post<{ pending: { id: string } }>('/api/admin/sod/SOD-01', { enabled: false, reason: 'Single-person cover, approved by the audit committee' });
    expect((await casey.post(`/api/access-requests/${again.body.pending.id}/approve`, {})).status).toBe(200);
    expect(await rule()).toBe(false);
    const log = await casey.get<{ items: { action: string; summary: string }[] }>('/api/audit?limit=50&action=admin.sod');
    expect(log.body.items[0]!.summary).toMatch(/^SOD-01 DISABLED: Single-person cover, approved by the audit committee \(AR-\d{4}, requested by Avery Stone, approved by Casey Morgan\)$/);
  });

  it('TO-C1: links work once, expire, and a newer link replaces an older one', async () => {
    const t = await testApp();
    const avery = await as(t, 'avery');
    const devon = (await avery.get<AdminView>('/api/admin')).body.users.find((u) => u.name === 'Devon Park')!;
    expect((await avery.post(`/api/admin/users/${devon.id}/password-reset`, {})).status).toBe(200);
    const first = (await readMail(t, devon.email)).token!;
    expect((await avery.post(`/api/admin/users/${devon.id}/password-reset`, {})).status).toBe(200);
    const second = (await readMail(t, devon.email)).token!;
    expect(second).not.toBe(first);
    const replaced = await t.client().post<{ error: { message: string } }>('/api/auth/link', { token: first, password: 'devon-tries-the-old-link' });
    expect(replaced.status).toBe(404);
    expect(replaced.body.error.message).toMatch(/newer link replaced this one/);
    // a day past its expiry, the newest link stops working too
    const now = t.ctx.clock.now().getTime();
    await t.fx.db.tx(t.fx.tenantId, async (tx) => {
      const link = (await tx.find('credential_links', { user_id: devon.id, revoked_at: { isNull: true } }))[0]!;
      await tx.update('credential_links', link.id, { created_at: new Date(now - 2 * 86_400_000).toISOString(), expires_at: new Date(now - 86_400_000).toISOString() });
    });
    expect((await t.client().get<{ error: { message: string } }>(`/api/auth/link?token=${second}`)).body.error.message).toMatch(/expired/);
    expect((await t.client().post('/api/auth/link', { token: second, password: 'devon-explains-variances' })).status).toBe(404);
    // the audit log shows who opened which message in the demo mailbox
    const alex = await as(t, 'alex');
    const log = await alex.get<{ items: { action: string; summary: string }[] }>('/api/audit?limit=20&action=outbox');
    expect(log.body.items.filter((i) => i.action === 'outbox.demo_mailbox.open').length).toBeGreaterThanOrEqual(2);
  });

  it('TO-C1: outside the demo, links go to the email relay and there is no mailbox to read them from', async () => {
    const t = await testApp({ demoMode: false });
    const avery = await as(t, 'avery');
    const invite = await avery.post<{ userId: string; sent: { to: string } }>('/api/admin/users', { email: 'quinn.ward@bramblewood.example', name: 'Quinn Ward', role: 'staff_accountant' });
    expect(invite.status).toBe(200);
    expect(invite.body.sent.to).toBe('quinn.ward@bramblewood.example');
    expect((await t.client().get('/api/demo/mailbox')).status).toBe(404);
    const queued = await t.fx.db.tx(t.fx.tenantId, (tx) => tx.find('outbox_messages', { to_address: 'quinn.ward@bramblewood.example' }));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ channel: 'email', status: 'queued', kind: 'enrolment' });
    expect(queued[0]!.body_sealed).not.toContain('tkl_'); // sealed at rest
  });
});

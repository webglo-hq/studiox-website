import { beforeAll, describe, expect, it } from 'vitest';
import type { ApiKernel } from '../../src/api/kernel';
import type { App } from '../../src/app/app';
import { decideAccessRequest } from '../../src/app/usecases/access';
import type { SeedResult } from '../../src/packs/accounting/seed/loader';
import { DbConstraintError } from '../../src/persistence/db';
import { configurePasswordHashing, DEMO_SCRYPT } from '../../src/security/passwords';
import { loadPrincipal } from '../../src/security/principal';
import { Client, errorOf, seededKernel } from './api-client';

configurePasswordHashing({ params: DEMO_SCRYPT });

interface Mailbox {
  messages: Array<{ id: string; kind: string; subject: string; body: string; link: string | null; linkStatus: string | null }>;
}
interface AccessRequestView {
  id: string;
  kind: string;
  summary: string;
  status: string;
  canDecide: boolean;
  blocks: string[];
  target: { enrolled: boolean; enrolmentLinkOpenedAt: string | null } | null;
}
interface Item {
  id: string;
  title: string;
  amount: number;
  canApprove: boolean;
}

const tokenOf = (link: string | null) => /token=([A-Za-z0-9_-]+)/.exec(link ?? '')?.[1] ?? '';
const NEW_PASSWORD = 'quiet-harbour-lantern-42';

/**
 * BH-C1: an administrator could mint an approver. Creating a CFO returned its temporary password, a reset returned
 * a working password, and SoD rules changed on the admin's word alone. Now nobody is handed a credential, links go
 * to their addressee only, and authority or control changes need a second, independent person.
 */
describe('access control: enrolment links and dual control (BH-C1)', () => {
  let app: App;
  let kernel: ApiKernel;
  let seed: SeedResult;
  let email: (key: string) => string;
  let skewMs = 0;
  let accrual: Item;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, kernel, seed, email } = await seededKernel({ clock: { now: () => new Date(Date.now() + skewMs).toISOString() } }));
    for (const u of await app.read((tx) => tx.find('users', { tenant_id: seed.tenantId }))) ids[u.email.split('.')[0]!] = u.id;
    const maya = new Client(kernel, '10.7.0.1');
    await maya.login(email('maya'));
    expect((await maya.call('POST', `/api/closes/${seed.closeId}/run`, {})).status).toBe(202);
    await app.queue.idle();
    const daniel = new Client(kernel, '10.7.0.2');
    await daniel.login(email('daniel'));
    accrual = (await daniel.ok<{ items: Item[] }>('GET', '/api/proposals?view=pending&limit=500')).items.find((i) => /Accrue Nimbus Cloud Services/.test(i.title))!;
    expect(accrual.amount).toBe(3_445_600);
  }, 240_000);

  it('BH-C1: an admin who creates a CFO never receives a credential, and the CFO role waits for an independent approver', async () => {
    const tom = new Client(kernel, '10.7.1.1');
    await tom.login(email('tom'));
    const created = await tom.call('POST', '/api/admin/users', { email: 'shadow.cfo@brambleway.example', name: 'Shadow Approver', roles: ['cfo'] });
    expect(created.status).toBe(200);
    const text = JSON.stringify(created.body);
    expect(text).not.toMatch(/password|token=|#\/enrol/i);
    const body = created.body as { id: string; enrolment: { sentTo: string; expiresAt: string }; applied: number; pending: { id: string; summary: string } | null };
    expect(body.enrolment.sentTo).toBe('shadow.cfo@brambleway.example');
    expect(body.pending?.summary).toMatch(/Grant CFO to Shadow Approver/);
    const shadow = await app.read((tx) => tx.get('users', body.id));
    expect(shadow?.password_hash).toBeNull();
    expect(await app.read((tx) => tx.find('user_roles', { user_id: body.id }))).toHaveLength(0);
    // The link is stored only as a hash; nothing the admin can read contains it.
    const tokens = await app.read((tx) => tx.find('credential_tokens', { user_id: body.id }));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const path of ['/api/admin/users', '/api/admin/access-requests', '/api/audit?limit=50']) expect(JSON.stringify((await tom.call('GET', path)).body)).not.toMatch(/token=/);

    // Signed in, the admin cannot open the invitee's delivery log, approve the request or sign in as the invitee.
    expect((await tom.call('POST', '/api/auth/delivery-log', { to: 'shadow.cfo@brambleway.example' })).status).toBe(403);
    const self = await tom.call('POST', `/api/admin/access-requests/${body.pending!.id}/decide`, { decision: 'approve' });
    expect(self.status).toBe(403);
    expect((await new Client(kernel, '10.7.1.2').login('shadow.cfo@brambleway.example', 'bookhand-demo')).status).toBe(401);

    // Signed out, the addressee's delivery log opens, and the opening is recorded (never silent).
    const invitee = new Client(kernel, '10.7.1.3');
    const mailbox = await invitee.ok<Mailbox>('POST', '/api/auth/delivery-log', { to: 'shadow.cfo@brambleway.example' });
    const message = mailbox.messages.find((m) => m.kind === 'enrolment')!;
    expect(message.linkStatus).toBe('usable');
    const token = tokenOf(message.link);
    expect((await invitee.ok<{ name: string }>('POST', '/api/auth/credential-link/check', { token })).name).toBe('Shadow Approver');
    expect((await invitee.call('POST', '/api/auth/credential-link', { token, password: NEW_PASSWORD })).status).toBe(200);
    expect((await invitee.call('POST', '/api/auth/credential-link', { token, password: `${NEW_PASSWORD}-again` })).status).toBe(400);
    const audit = await app.read((tx) => tx.find('audit_log', { tenant_id: seed.tenantId, action: { in: ['outbox.opened', 'auth.enrolled'] } }));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['outbox.opened', 'auth.enrolled']));

    // Enrolled but not yet approved: the new account holds no role and cannot approve the $34,456 accrual.
    const shadowClient = new Client(kernel, '10.7.1.4');
    expect((await shadowClient.login('shadow.cfo@brambleway.example', NEW_PASSWORD)).status).toBe(200);
    expect((await shadowClient.call('POST', `/api/proposals/${accrual.id}/approve`, {})).status).toBe(403);
    expect((await app.read((tx) => tx.get('proposals', accrual.id)))?.status).toBe('pending');

    // A Controller lacks the CFO's authority, so only the CFO can approve a CFO grant; the approver sees the enrolment.
    const hannah = new Client(kernel, '10.7.1.5');
    await hannah.login(email('hannah'));
    const forHannah = (await hannah.ok<{ requests: AccessRequestView[] }>('GET', '/api/admin/access-requests')).requests.find((r) => r.id === body.pending!.id)!;
    expect(forHannah.canDecide).toBe(false);
    expect(forHannah.blocks.join(' ')).toMatch(/without a limit|authority you do not hold/);
    expect((await hannah.call('POST', `/api/admin/access-requests/${body.pending!.id}/decide`, { decision: 'approve' })).status).toBe(403);
    const marcus = new Client(kernel, '10.7.1.6');
    await marcus.login(email('marcus'));
    const forMarcus = (await marcus.ok<{ requests: AccessRequestView[] }>('GET', '/api/admin/access-requests')).requests.find((r) => r.id === body.pending!.id)!;
    expect(forMarcus).toMatchObject({ canDecide: true, target: { enrolled: true } });
    expect(forMarcus.target?.enrolmentLinkOpenedAt).toBeTruthy();
    expect((await marcus.call('POST', `/api/admin/access-requests/${body.pending!.id}/decide`, { decision: 'approve' })).status).toBe(200);
    const grant = await app.read((tx) => tx.find('user_roles', { user_id: body.id }));
    expect(grant).toHaveLength(1);
    expect(grant[0]!.granted_by).toBe(ids.tom!);
    const decided = await app.read((tx) => tx.get('access_requests', body.pending!.id));
    expect(decided).toMatchObject({ status: 'approved', requested_by: ids.tom!, decided_by: ids.marcus! });
  });

  it('BH-C1: the requester never decides their own request, in the application or in the database', async () => {
    const tom = new Client(kernel, '10.7.2.1');
    await tom.login(email('tom'));
    const daniel = ids.daniel!;
    const res = await tom.ok<{ pending: { id: string } | null }>('PUT', `/api/admin/users/${daniel}/roles`, { roles: ['senior_accountant', 'controller'], reason: 'Covering the Controller during leave' });
    const requestId = res.pending!.id;
    // Even someone holding access.approve is refused for a request they made.
    const tomAsApprover = await app.read((tx) => loadPrincipal(tx, seed.tenantId, ids.tom!));
    tomAsApprover.permissions.add('access.approve');
    tomAsApprover.approvalLimitMinor = null;
    await expect(decideAccessRequest(app, tomAsApprover, requestId, 'approve', undefined)).rejects.toMatchObject({ code: 'SOD_VIOLATION' });
    // The database refuses it too, and refuses the grantee deciding their own grant.
    const err = await app.tx((tx) => tx.update('access_requests', requestId, { status: 'approved', decided_by: ids.tom!, decided_at: app.clock.now() })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbConstraintError);
    const own = await app.tx((tx) => tx.update('access_requests', requestId, { status: 'approved', decided_by: daniel, decided_at: app.clock.now() })).catch((e: unknown) => e);
    expect(own).toBeInstanceOf(DbConstraintError);
    expect((await app.read((tx) => tx.get('access_requests', requestId)))?.status).toBe('pending');
    expect((await app.read((tx) => loadPrincipal(tx, seed.tenantId, daniel))).roleKeys).toEqual(['senior_accountant']);
    // Rejected by an independent approver, nothing changes.
    const marcus = new Client(kernel, '10.7.2.2');
    await marcus.login(email('marcus'));
    expect((await marcus.call('POST', `/api/admin/access-requests/${requestId}/decide`, { decision: 'reject', reason: 'Hannah is not on leave' })).status).toBe(200);
    expect((await app.read((tx) => loadPrincipal(tx, seed.tenantId, daniel))).roleKeys).toEqual(['senior_accountant']);
  });

  it('BH-C1: a password reset gives the admin nothing, ends the old password and sends a single-use, expiring link', async () => {
    const tom = new Client(kernel, '10.7.3.1');
    await tom.login(email('tom'));
    const maya = new Client(kernel, '10.7.3.2');
    await maya.login(email('maya'));
    const reset = await tom.call('POST', `/api/admin/users/${ids.maya!}/reset-password`, {});
    expect(reset.status).toBe(200);
    expect(JSON.stringify(reset.body)).not.toMatch(/temporaryPassword|token=/);
    expect((reset.body as { purpose: string }).purpose).toBe('password_reset');
    expect((await maya.call('GET', '/api/home')).status).toBe(401);
    expect((await new Client(kernel, '10.7.3.3').login(email('maya'))).status).toBe(401);

    // Another signed-in person (the admin) is refused the link, and that is audited.
    const signedOut = new Client(kernel, '10.7.3.4');
    const mail = await signedOut.ok<Mailbox>('POST', '/api/auth/delivery-log', { to: email('maya') });
    const first = tokenOf(mail.messages.find((m) => m.kind === 'password_reset')!.link);
    expect((await tom.call('POST', '/api/auth/credential-link/check', { token: first })).status).toBe(403);
    expect((await tom.call('POST', '/api/auth/credential-link', { token: first, password: NEW_PASSWORD })).status).toBe(403);
    expect(await app.read((tx) => tx.find('audit_log', { tenant_id: seed.tenantId, action: 'auth.credential_link_refused' }))).not.toHaveLength(0);

    // A newer link replaces the older one; an expired link stops working.
    await tom.ok('POST', `/api/admin/users/${ids.maya!}/reset-password`, {});
    const again = await signedOut.ok<Mailbox>('POST', '/api/auth/delivery-log', { to: email('maya') });
    const second = tokenOf(again.messages.find((m) => m.kind === 'password_reset' && m.linkStatus === 'usable')!.link);
    expect(again.messages.find((m) => tokenOf(m.link) === first)?.linkStatus).toBe('replaced');
    expect((await signedOut.call('POST', '/api/auth/credential-link/check', { token: first })).status).toBe(400);
    skewMs += 61 * 60_000;
    try {
      expect(errorOf(await signedOut.call('POST', '/api/auth/credential-link/check', { token: second })).message).toMatch(/expired/);
    } finally {
      skewMs -= 61 * 60_000;
    }
    // Used once, it is spent.
    expect((await signedOut.call('POST', '/api/auth/credential-link', { token: second, password: NEW_PASSWORD })).status).toBe(200);
    expect((await signedOut.call('POST', '/api/auth/credential-link', { token: second, password: NEW_PASSWORD })).status).toBe(400);
    expect((await new Client(kernel, '10.7.3.5').login(email('maya'), NEW_PASSWORD)).status).toBe(200);
  });

  it('BH-C1: an SoD rule change waits for an independent Controller or CFO, and SOD-002 cannot change at all', async () => {
    const tom = new Client(kernel, '10.7.4.1');
    await tom.login(email('tom'));
    const rules = await tom.ok<Array<{ id: string; code: string; enabled: boolean; version: number }>>('GET', '/api/admin/sod-rules');
    const sod1 = rules.find((r) => r.code === 'SOD-001')!;
    const sod2 = rules.find((r) => r.code === 'SOD-002')!;
    const requested = await tom.ok<{ pending: { id: string } }>('PATCH', `/api/admin/sod-rules/${sod1.id}`, { enabled: false, reason: 'Testing an emergency override' });
    const unchanged = await app.read((tx) => tx.get('sod_rules', sod1.id));
    expect(unchanged).toMatchObject({ enabled: true, version: sod1.version });
    expect((await tom.call('PATCH', `/api/admin/sod-rules/${sod2.id}`, { enabled: false, reason: 'Turn off launcher separation' })).status).toBe(400);
    expect((await tom.call('POST', `/api/admin/access-requests/${requested.pending.id}/decide`, { decision: 'approve' })).status).toBe(403);
    const hannah = new Client(kernel, '10.7.4.2');
    await hannah.login(email('hannah'));
    expect((await hannah.call('POST', `/api/admin/access-requests/${requested.pending.id}/decide`, { decision: 'approve' })).status).toBe(200);
    expect(await app.read((tx) => tx.get('sod_rules', sod1.id))).toMatchObject({ enabled: false, version: sod1.version + 1, updated_by: ids.tom! });
    // Put it back the same way.
    const back = await tom.ok<{ pending: { id: string } }>('PATCH', `/api/admin/sod-rules/${sod1.id}`, { enabled: true, reason: 'Override test finished' });
    await hannah.ok('POST', `/api/admin/access-requests/${back.pending.id}/decide`, { decision: 'approve' });
    expect((await app.read((tx) => tx.get('sod_rules', sod1.id)))?.enabled).toBe(true);
  });

  it('SEC-1: a locked account answers exactly like a wrong password, and its holder is told by message', async () => {
    const guesser = new Client(kernel, '10.7.5.1');
    for (let i = 0; i < 5; i++) expect((await guesser.call('POST', '/api/auth/login', { email: email('priya'), password: `wrong-guess-${i}` })).status).toBe(401);
    const locked = await guesser.call('POST', '/api/auth/login', { email: email('priya'), password: 'bookhand-demo' });
    const unknown = await new Client(kernel, '10.7.5.2').call('POST', '/api/auth/login', { email: 'nobody.here@brambleway.example', password: 'bookhand-demo' });
    expect(locked.status).toBe(401);
    expect(errorOf(locked)).toEqual({ ...errorOf(unknown), requestId: expect.any(String) as string });
    expect(errorOf(locked).message).not.toMatch(/lock|attempt|admin/i);
    const mail = await new Client(kernel, '10.7.5.3').ok<Mailbox>('POST', '/api/auth/delivery-log', { to: email('priya') });
    expect(mail.messages.find((m) => m.kind === 'account_locked')?.body).toMatch(/locked/);
  });

  it('SEC-3: a write access token cannot change agent autonomy or policy; a signed-in Controller can', async () => {
    const hannah = new Client(kernel, '10.7.6.1');
    await hannah.login(email('hannah'));
    const { token } = await hannah.ok<{ token: string }>('POST', '/api/me/tokens', { name: 'Automation', scope: 'write', expiresInDays: 7 });
    const viaToken = await kernel.handle({ method: 'PUT', path: '/api/skills/bank-reconciliation/policy', query: {}, headers: { host: 'bookhand.test', authorization: `Bearer ${token}` }, cookies: {}, body: { autonomy: 'L3', reason: 'Let it run on its own' }, ip: '10.7.6.2' });
    expect(viaToken.status).toBe(403);
    const policy = await app.read(async (tx) => (await tx.find('skill_policies', { tenant_id: seed.tenantId })).filter((x) => x.autonomy_level === 'L3'));
    expect(policy).toHaveLength(0);
    expect((await hannah.call('PUT', '/api/skills/bank-reconciliation/policy', { autonomy: 'L1', reason: 'Drafts only this month' })).status).toBe(200);
  });
});

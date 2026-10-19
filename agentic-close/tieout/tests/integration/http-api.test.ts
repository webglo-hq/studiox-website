/**
 * The HTTP API end to end (same Hono app the server and the static demo run): sessions, CSRF and
 * origin checks, rate limits, RBAC, segregation of duties, approval limits, the agent close,
 * API tokens, idempotent imports and the audit chain.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { adapter } from '../../src/integrations/adapters';
import { PEOPLE } from '../../src/packs/accounting/seed/company';
import { SESSION_COOKIE } from '../../src/server/app';
import { testApp, TEST_ORIGIN, TEST_PASSWORD, type HttpClient, type TestApp } from '../support/app';

const P = '2026-09';
interface Item {
  id: string;
  ref: string;
  kind: string;
  status: string;
  amountMinor: number;
  canDecide: boolean;
  blockedBy: string[];
  skillKey: string;
}

let t: TestApp;
let jordan: HttpClient;
let casey: HttpClient;

beforeAll(async () => {
  t = await testApp();
  jordan = t.client();
  casey = t.client();
  expect((await jordan.login('jordan')).status).toBe(200);
  expect((await casey.login('casey')).status).toBe(200);
}, 120_000);

describe('HTTP API: security baseline', () => {
  it('sends strict security headers', async () => {
    const r = await t.client().get('/api/health');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('issues an HttpOnly, SameSite=Strict session cookie and never returns the session token in the body', async () => {
    const p = PEOPLE.find((x) => x.key === 'sam')!;
    const res = await t.app.fetch(new Request(`${TEST_ORIGIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: TEST_ORIGIN }, body: JSON.stringify({ email: p.email, password: TEST_PASSWORD }) }));
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const body = (await res.json()) as Record<string, unknown>;
    const token = cookie.split(';')[0]!.split('=')[1]!;
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it('requires a session for the API', async () => {
    expect((await t.client().get('/api/home')).status).toBe(401);
  });

  it('gives the same generic error for a wrong password and an unknown user, then rate-limits', async () => {
    const c = t.client();
    const bad = await c.post('/api/auth/login', { email: PEOPLE[0]!.email, password: 'definitely-wrong-password' });
    const unknown = await c.post('/api/auth/login', { email: 'nobody@bramblewood.example', password: 'definitely-wrong-password' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((bad.body.error as { message: string }).message).toBe((unknown.body.error as { message: string }).message);
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await c.post('/api/auth/login', { email: 'devon@bramblewood.example', password: 'wrong-password-123' })).status);
    expect(statuses).toContain(429);
  });

  it('rejects mutations without the CSRF token or from another origin', async () => {
    const noCsrf = await jordan.post('/api/runs', { skillKey: 'je-review', entityId: null, periodKey: P }, { 'x-csrf-token': '' });
    expect(noCsrf.status).toBe(403);
    // a cross-site request carries the victim's cookie but the attacker's Origin
    const p = PEOPLE.find((x) => x.key === 'riley')!;
    const login = await t.app.fetch(new Request(`${TEST_ORIGIN}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: TEST_ORIGIN }, body: JSON.stringify({ email: p.email, password: TEST_PASSWORD }) }));
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
    const forged = await t.app.fetch(new Request(`${TEST_ORIGIN}/api/close/${P}/lock`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: '{}' }));
    expect(forged.status).toBe(403);
  });

  it('enforces role permissions server-side', async () => {
    const sam = t.client();
    await sam.login('sam');
    const r = await sam.post('/api/skills/transaction-coding/policy', { thresholds: { autoPostMaxMinor: 100 }, note: 'staff trying to raise limits' });
    expect(r.status).toBe(403);
    const auditor = t.client();
    await auditor.login('alex');
    expect((await auditor.get('/api/audit')).status).toBe(200);
    expect((await auditor.post('/api/runs', { skillKey: 'je-review', entityId: null, periodKey: P })).status).toBe(403);
  });
});

describe('HTTP API: the close with agents and people', () => {
  let items: Item[] = [];

  it('runs every close agent in dependency waves', async () => {
    const r = await jordan.post<{ waves: string[][]; tasks: { key: string; outcome: string }[] }>(`/api/close/${P}/run-agents`, {});
    expect(r.status).toBe(200);
    expect(r.body.waves.length).toBeGreaterThanOrEqual(3);
    expect(r.body.tasks.every((x) => x.outcome === 'succeeded')).toBe(true);
    const list = await casey.get<{ items: Item[] }>(`/api/proposals?status=open&period=${P}`);
    items = list.body.items;
    expect(items.length).toBeGreaterThan(20);
  });

  it('blocks the person who ran the agents from approving their output (SOD-02)', async () => {
    const je = items.find((i) => i.kind === 'journal_entry' && i.amountMinor < 2_500_000)!;
    const r = await jordan.post(`/api/proposals/${je.id}/approve`, {});
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toMatch(/ran the agent/);
  });

  it('lets a different, authorised person approve; the entry posts with a full trail', async () => {
    const je = items.find((i) => i.kind === 'journal_entry' && i.canDecide && i.amountMinor < 2_500_000)!;
    expect(je).toBeTruthy();
    const r = await casey.post<{ status: string; applied_ref_id: string }>(`/api/proposals/${je.id}/approve`, { note: 'Agrees to the bank statement' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('applied');
    const entry = await casey.get<{ entry: { status: string; approved_by: string | null } }>(`/api/journal/${r.body.applied_ref_id}`);
    expect(entry.status).toBe(200);
    expect(JSON.stringify(entry.body)).toContain('posted');
    const again = await casey.post(`/api/proposals/${je.id}/approve`, {});
    expect(again.status).toBeGreaterThanOrEqual(400); // no double-apply
  });

  it('escalates above the approver’s limit (AX-SOD-04)', async () => {
    const big = items.find((i) => i.kind === 'journal_entry' && i.amountMinor > 25_000_000);
    expect(big).toBeTruthy();
    const r = await casey.post(`/api/proposals/${big!.id}/approve`, {});
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).toMatch(/AX-SOD-04|limit/i);
  });

  it('requires a reason to reject', async () => {
    const it2 = items.find((i) => i.canDecide && i.kind === 'flux_explanation')!;
    expect((await casey.post(`/api/proposals/${it2.id}/reject`, { reason: 'no' })).status).toBe(400);
    expect((await casey.post(`/api/proposals/${it2.id}/reject`, { reason: 'Driver labels need the vendor names' })).status).toBe(200);
  });

  it('will not lock the period while work is open (AX-CL-02)', async () => {
    const r = await casey.post(`/api/close/${P}/lock`, {});
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/AX-CL-02/);
  });

  it('caps autonomy at the skill manifest maximum', async () => {
    const r = await casey.post('/api/skills/intercompany-matching/policy', { autonomy: 'L3', note: 'try to go fully autonomous' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/at most L1/);
    const ok = await casey.post<{ version: number }>('/api/skills/schedule-rollforward/policy', { autonomy: 'L3', note: 'three clean months of schedules' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
  });
});

describe('HTTP API: integrations, tokens and audit', () => {
  it('imports a file once; the identical file is recognised and changes nothing', async () => {
    const sample = adapter('bank:camt053').sample();
    const first = await jordan.post<{ batch: { status: string }; created: number }>('/api/imports', { connectorKey: 'thameside-camt053', filename: 'october.xml', content: sample });
    expect(first.status).toBe(200);
    expect(first.body.batch.status).toBe('completed');
    expect(first.body.created).toBe(2);
    const second = await jordan.post<{ batch: { status: string }; created: number }>('/api/imports', { connectorKey: 'thameside-camt053', filename: 'october-again.xml', content: sample });
    expect(second.body.batch.status).toBe('duplicate');
    expect(second.body.created).toBe(0);
  });

  it('issues read-only API tokens (MCP) that can be revoked', async () => {
    const created = await casey.post<{ token: string; id: string }>('/api/auth/tokens', { name: 'CI token', days: 7 });
    expect(created.status).toBe(200);
    const token = created.body.token;
    expect(token).toMatch(/^tko_[0-9a-f]{64}$/);
    const read = await t.app.fetch(new Request(`${TEST_ORIGIN}/api/proposals?status=open`, { headers: { authorization: `Bearer ${token}` } }));
    expect(read.status).toBe(200);
    const write = await t.app.fetch(new Request(`${TEST_ORIGIN}/api/close/${P}/lock`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }));
    expect(write.status).toBe(403);
    expect((await casey.del(`/api/auth/tokens/${created.body.id}`)).status).toBe(200);
    const after = await t.app.fetch(new Request(`${TEST_ORIGIN}/api/proposals?status=open`, { headers: { authorization: `Bearer ${token}` } }));
    expect(after.status).toBe(401);
  });

  it('records every change in a hash chain that verifies', async () => {
    const r = await casey.post<{ ok: boolean; count: number }>('/api/audit/verify', {});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.count).toBeGreaterThan(100);
    const log = await casey.get<{ items: { action: string }[] }>('/api/audit?limit=500');
    const actions = new Set(log.body.items.map((i) => i.action));
    for (const a of ['auth.login', 'auth.login.failed', 'agent.run.create', 'proposal.approve', 'proposal.reject', 'skill.policy.update', 'import.complete', 'import.duplicate', 'auth.token.create', 'auth.token.revoke']) expect(actions, a).toContain(a);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import type { ApiKernel } from '../../src/api/kernel';
import type { App } from '../../src/app/app';
import type { SeedResult } from '../../src/packs/accounting/seed/loader';
import { configurePasswordHashing, DEMO_SCRYPT } from '../../src/security/passwords';
import { Client, errorOf, seededKernel } from './api-client';

configurePasswordHashing({ params: DEMO_SCRYPT });

interface Item {
  id: string;
  kind: string;
  title: string;
  confidence: number;
  amount: number;
  riskFlags: string[];
  canApprove: boolean;
  bulkBlock: string | null;
  blocks: string[];
  checks: { failed: string[]; warnings: string[] };
  status: string;
}

/** Decisions in the inbox after Maya runs the close agents: bulk approval (B-2) and launcher SoD (BH-M2). */
describe('inbox decisions after the close agents run', () => {
  let app: App;
  let kernel: ApiKernel;
  let seed: SeedResult;
  let email: (key: string) => string;
  const pending = async (c: Client) => (await c.ok<{ items: Item[] }>('GET', '/api/proposals?view=pending&limit=500')).items;

  beforeAll(async () => {
    ({ app, kernel, seed, email } = await seededKernel());
    const maya = new Client(kernel, '10.1.0.1');
    await maya.login(email('maya'));
    expect((await maya.call('POST', `/api/closes/${seed.closeId}/run`, {})).status).toBe(202);
    await app.queue.idle();
  }, 240_000);

  it('B-2: select-all eligibility leaves out flagged, failed-check and low-confidence items', async () => {
    const daniel = new Client(kernel, '10.1.0.2');
    await daniel.login(email('daniel'));
    const items = await pending(daniel);
    const halcyon = items.find((i) => /HALCYON/.test(i.title))!;
    const unexplained = items.find((i) => /Investigate unexplained bank debit/.test(i.title))!;
    expect(halcyon.riskFlags).toContain('instruction_like_text');
    expect(halcyon.bulkBlock).toMatch(/Flagged/);
    expect(unexplained.confidence).toBeLessThan(0.7);
    expect(unexplained.bulkBlock).toBeTruthy();
    for (const i of items) {
      const risky = i.riskFlags.length > 0 || i.checks.failed.length > 0 || i.checks.warnings.length > 0 || i.confidence < 0.7;
      expect(i.bulkBlock !== null, `${i.title}: risky=${risky} bulkBlock=${i.bulkBlock}`).toBe(risky);
    }
  });

  it('B-2: a bulk approval refuses flagged and low-confidence items server-side and needs the confirmed count and total', async () => {
    const daniel = new Client(kernel, '10.1.0.3');
    await daniel.login(email('daniel'));
    const items = await pending(daniel);
    const halcyon = items.find((i) => /HALCYON/.test(i.title))!;
    const unexplained = items.find((i) => /Investigate unexplained bank debit/.test(i.title))!;
    const routine = items.find((i) => i.canApprove && !i.bulkBlock)!;
    expect(halcyon.canApprove && unexplained.canApprove).toBe(true);
    const ids = [halcyon.id, unexplained.id, routine.id];
    const totalMinor = halcyon.amount + unexplained.amount + routine.amount;

    const unconfirmed = await daniel.call('POST', '/api/proposals/bulk', { ids, decision: 'approve' });
    expect(unconfirmed.status).toBe(400);
    const stale = await daniel.call('POST', '/api/proposals/bulk', { ids, decision: 'approve', confirm: { count: 3, totalMinor: totalMinor + 1 } });
    expect(stale.status).toBe(409);

    const res = await daniel.call('POST', '/api/proposals/bulk', { ids, decision: 'approve', confirm: { count: 3, totalMinor } });
    expect(res.status).toBe(200);
    const body = res.body as { ok: number; failed: number; results: Array<{ id: string; ok: boolean; error?: string }> };
    expect(body.ok).toBe(1);
    expect(body.results.find((r) => r.id === halcyon.id)).toMatchObject({ ok: false, error: expect.stringMatching(/Flagged/) });
    expect(body.results.find((r) => r.id === unexplained.id)?.ok).toBe(false);
    expect(body.results.find((r) => r.id === routine.id)?.ok).toBe(true);
    const after = await app.read(async (tx) => ({ halcyon: (await tx.get('proposals', halcyon.id))!.status, unexplained: (await tx.get('proposals', unexplained.id))!.status }));
    expect(after).toEqual({ halcyon: 'pending', unexplained: 'pending' });

    // Opened and decided one by one, the flagged match can still be approved by someone entitled to.
    const one = await daniel.call('POST', `/api/proposals/${halcyon.id}/approve`, { note: 'Opened it: the memo text is data; amount and reference agree.' });
    expect(one.status).toBe(200);
  });

  it('BH-M2: whoever started the agent run approves none of its output, whatever the kind or amount', async () => {
    const maya = new Client(kernel, '10.1.0.4');
    await maya.login(email('maya'));
    const items = await pending(maya);
    const mayaId = seed.dataset.ids.users.maya!;
    const fromHerRun = (await app.read((tx) => tx.find('proposals', { tenant_id: seed.tenantId, status: 'pending' }))).filter((p) => p.requested_by === mayaId);
    expect(fromHerRun.length).toBeGreaterThan(5);
    for (const p of fromHerRun) {
      const item = items.find((i) => i.id === p.id)!;
      expect(item.canApprove, item.title).toBe(false);
      expect(item.blocks.join(' ')).toMatch(/you started the agent run/);
    }
    // Small items within her own $5,000 limit, and kinds without an amount limit (a bank-rec match), are refused too.
    const small = fromHerRun.find((p) => p.amount_minor > 0 && p.amount_minor <= 500_000 && p.kind !== 'flux_explanation')!;
    const match = fromHerRun.find((p) => p.kind === 'rec_match' && p.risk_flags.length === 0)!;
    for (const p of [small, match]) {
      const res = await maya.call('POST', `/api/proposals/${p.id}/approve`, {});
      expect(res.status, p.title).toBe(403);
      expect(errorOf(res).code).toBe('SOD_VIOLATION');
    }
    // She can still reject what her run proposed: that applies nothing.
    expect((await maya.call('POST', `/api/proposals/${small.id}/reject`, { reason: 'Coded to the wrong department.' })).status).toBe(200);
  });
});

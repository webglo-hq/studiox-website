/**
 * What the signed close package says (independent review, 2026-10-19): it lists every open item,
 * including reconciling exceptions such as the unexplained bank debit, each in its own currency,
 * and its summary describes the close as it stands when it is signed, never "(draft) Not ready to
 * lock" because of the package's own approval.
 */
import { describe, expect, it } from 'vitest';
import type { ClosePackageContent } from '../../src/packs/accounting/model/types';
import { SCENARIO } from '../../src/packs/accounting/seed/company';
import { testApp, type HttpClient } from '../support/app';
import { closeTheMonth } from '../support/full-close';

const P = SCENARIO.closeKey;

describe('the close package', () => {
  it('T-9: the signed package lists the unexplained bank debit as an open item and says the period can lock', async () => {
    const t = await testApp();
    const { people } = await closeTheMonth(t, { runAgents: true });
    const casey = people.casey as HttpClient;
    const pkg = (await casey.get<{ packages: { id: string; status: string }[] }>(`/api/close/${P}`)).body.packages[0]!;
    expect(pkg.status).toBe('final');
    const content = (await casey.get<{ content: ClosePackageContent }>(`/api/packages/${pkg.id}`)).body.content;

    const debit = content.openItems.find((o) => o.kind === 'reconciling_item' && o.title.includes('ACH DEBIT QXR SETTLEMENT 88231'));
    expect(debit).toMatchObject({ amountMinor: -2_750_00, currency: 'USD', entityCode: 'BWL-US' });
    expect(debit!.title).toMatch(/^Unexplained bank debit: ACH DEBIT QXR SETTLEMENT 88231 \(.+, open since 2026-09-17\)$/);
    expect(content.openItems.every((o) => !!o.currency)).toBe(true);

    expect(content.readiness).toEqual({ ready: true, messages: [] });
    expect(content.summary).toMatch(/^September 2026 close package\. Every other lock condition is met: the period can lock once this package is approved\. /);
    expect(content.summary).not.toMatch(/\(draft\)|Not ready to lock/);
  });

  it('T-9: a package drafted while work is still open says what blocks the lock, and the period cannot lock with it', async () => {
    const t = await testApp();
    const [sam, casey, riley] = [t.client(), t.client(), t.client()];
    expect((await sam.login('sam')).status).toBe(200);
    expect((await casey.login('casey')).status).toBe(200);
    expect((await riley.login('riley')).status).toBe(200);
    // the variances are explained (a package is never signed without that, AX-FLX-01); the reconciliations are not done
    for (const code of ['BWL-US', 'BWL-UK']) {
      const id = t.fx.entityIds.get(code)!;
      for (const l of (await casey.get<{ lines: { code: string; name: string; exceeds: boolean }[] }>(`/api/flux?entity=${id}&period=${P}`)).body.lines.filter((x) => x.exceeds)) {
        const w = await sam.post<{ id: string }>('/api/flux/explanations', { entityId: id, periodKey: P, accountCode: l.code, text: `${l.name}: the September movement is explained by the drivers shown.` });
        expect((await casey.post(`/api/proposals/${w.body.id}/approve`, {})).status).toBe(200);
      }
    }
    expect((await casey.post('/api/runs', { skillKey: 'close-package', entityId: null, periodKey: P })).status).toBe(200);
    const report = (await riley.get<{ items: { id: string }[] }>(`/api/proposals?status=open&period=${P}&kind=report`)).body.items[0]!;
    expect((await riley.post(`/api/proposals/${report.id}/approve`, {})).status).toBe(200);
    const pkg = (await casey.get<{ packages: { id: string }[] }>(`/api/close/${P}`)).body.packages[0]!;
    const content = (await casey.get<{ content: ClosePackageContent }>(`/api/packages/${pkg.id}`)).body.content;
    // the package never names its own approval as a blocker
    expect(content.readiness!.ready).toBe(false);
    expect(content.readiness!.messages.join('; ')).not.toMatch(/generate the close package first/);
    expect(content.summary).toMatch(/^September 2026 close package\. Before the period can lock: .*reconciliations are not reviewed/);
    expect((await riley.post(`/api/packages/${pkg.id}/finalize`, {})).status).toBe(200);
    const readiness = (await casey.get<{ readiness: { stalePackage: boolean; messages: string[] } }>(`/api/close/${P}`)).body.readiness;
    expect(readiness.stalePackage).toBe(true);
    expect(readiness.messages.some((m) => m.startsWith('Package v1: it was drafted while the close still had open work ('))).toBe(true);
  });
});

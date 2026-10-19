import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatMoney } from '../../src/framework/util/money';
import { makeContext } from '../../src/packs/accounting/domain/context';
import { loadActor } from '../../src/packs/accounting/domain/rbac';
import { runFullClose } from '../../src/packs/accounting/evals/close-run';
import { SCENARIO } from '../../src/packs/accounting/seed/scenario';
import { fluxView } from '../../src/packs/accounting/services/flux';
import { fromRoot } from '../../src/server/paths';
import { loadSkillsFromDisk } from '../../src/server/skills-fs';

/** The social ads (scripts/render-ads.ts) quote the demo; these checks keep them true to it. */

const ads = readFileSync(fromRoot('scripts', 'render-ads.ts'), 'utf8');
const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;

describe('ad copy', () => {
  it('E-9: every ad ends with a call to action', () => {
    const footers = ads.match(/\$\{FOOT\(/g) ?? [];
    expect(footers).toHaveLength(3);
    expect(ads).toMatch(/const FOOT = [^\n]*class="cta">Try the demo/);
  });

  it('E-9: what the ads say posted or was held is what the demo does', async () => {
    const r = await runFullClose({ skills: loadSkillsFromDisk(), through: 'proposals' });
    const proposal = (title: string) => r.proposals.find((p) => p.title.startsWith(title))!;
    // Ad 3: a routine office-supplies coding posts on its own; the gift cards wait under the policy rule.
    const supplies = proposal('Paper Lantern Office Supply $167.83');
    expect(supplies.status).toBe('auto_applied');
    expect(ads).toContain('Office supplies $167.83</span><span class="badge b-good">Posted automatically');
    const gifts = proposal('Brightleaf Gift Co. $450.00');
    expect(gifts.status).not.toBe('auto_applied');
    expect(JSON.stringify(gifts.verification)).toMatch(/Never auto-post when memo contains/);
    expect(ads).toContain('Gift cards $450.00</span><span class="badge b-warn">Held: your rule');
    expect(ads).not.toMatch(/\$450\.00<\/span><span class="badge b-good">Posted automatically/);
    // Ad 3 and ad 2: the payroll accrual, held as material, and the cloud-hosting accrual.
    const payroll = proposal('Accrue Kitewell US');
    expect(payroll.materiality).toBe('material');
    expect(ads).toContain(`Payroll accrual · ${formatMoney(payroll.amount!)}`);
    expect(ads).toContain(`(${formatMoney(payroll.amount!, 'USD', { whole: true })})`);
    expect(ads).toContain(`accrued ${formatMoney(proposal('Accrue Nimbus Cloud Services').amount!, 'USD', { whole: true })}`);
    // Ad 2: the US variances against the prior month, once the agents' work is decided.
    const casey = makeContext(r.db, r.info.tenantId, await loadActor(r.db, r.info.tenantId, r.info.users.casey), r.clock);
    const flux = await fluxView(casey, { entityCode: 'US', periodKey: SCENARIO.openPeriod, comparison: 'prior_month' });
    const line = (code: string) => flux.lines.find((l) => l.code === code)!;
    expect(line('6400')).toMatchObject({ material: true, explanation: { status: 'approved' } });
    for (const code of ['5000', '6000', '4000']) expect(line(code).material).toBe(false);
    for (const code of ['6400', '5000', '6000', '4000']) expect(ads).toMatch(new RegExp(`\\['${code} [^\\]]*'${pct(line(code).variancePct!).replace('+', '\\+')}'`));
  }, 120_000);
});

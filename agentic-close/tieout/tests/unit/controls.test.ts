import { describe, expect, it } from 'vitest';
import { decideRoute, type RoutingInput } from '../../src/core/agent/autonomy';
import type { SodRuleRow } from '../../src/schema';
import { compileRule } from '../../src/packs/accounting/agent/rules';
import { approvalLimit } from '../../src/packs/accounting/controls/permissions';
import { DEFAULT_SOD_RULES, evaluateApproval, evaluateAssignment } from '../../src/packs/accounting/controls/sod';
import { roleForAmount } from '../../src/packs/accounting/agent/assess';

const base: RoutingInput = { level: 'L2', amountMinor: 4_500, autoPostMaxMinor: 50_000, confidence: 0.96, minConfidence: 0.9, flags: [], autoEligible: true, materiality: 'trivial', sampleRatePct: 20, sampleKey: 'p-1' };

describe('autonomy routing (L0–L3)', () => {
  it('L0 only suggests and L1 always waits for approval', () => {
    expect(decideRoute({ ...base, level: 'L0' })).toMatchObject({ route: 'suggestion', status: 'suggested' });
    expect(decideRoute({ ...base, level: 'L1' })).toMatchObject({ route: 'human_approval', status: 'pending_approval' });
  });
  it('L2 applies small, confident, clean items by policy', () => {
    const d = decideRoute(base);
    expect(d.route).toBe('auto_post_sampled');
    expect(d.status).toBe('auto_approved');
    expect(d.reasons[0]).toMatch(/within the \$500 ceiling/);
  });
  it.each([
    [{ amountMinor: 60_000 }, /auto-post ceiling/],
    [{ confidence: 0.7 }, /below the 90% auto-post floor/],
    [{ flags: ['injection_suspected'] }, /injection suspected/],
    [{ flags: ['control_account'] }, /control account/],
    [{ materiality: 'material' as const }, /above performance materiality/],
    [{ autoEligible: false }, /always needs a person/],
  ])('L2 sends %o to a person', (patch, reason) => {
    const d = decideRoute({ ...base, ...patch });
    expect(d.route).toBe('human_approval');
    expect(d.reasons.join(' ')).toMatch(reason);
  });
  it('L3 applies clean items and queues every one for post-hoc review, but never flagged ones', () => {
    expect(decideRoute({ ...base, level: 'L3', amountMinor: 10_000_000 })).toMatchObject({ route: 'auto_post', reviewStatus: 'pending' });
    expect(decideRoute({ ...base, level: 'L3', flags: ['injection_suspected'] }).route).toBe('human_approval');
  });
  it('samples deterministically by key at roughly the configured rate', () => {
    const sampled = Array.from({ length: 1000 }, (_, i) => decideRoute({ ...base, sampleKey: `k-${i}` }).reviewStatus === 'pending').filter(Boolean).length;
    expect(sampled).toBeGreaterThan(140);
    expect(sampled).toBeLessThan(260);
    expect(decideRoute({ ...base, sampleKey: 'k-7' }).reviewStatus).toBe(decideRoute({ ...base, sampleKey: 'k-7' }).reviewStatus);
  });
});

describe('segregation of duties', () => {
  const rules = DEFAULT_SOD_RULES.map((r, i) => ({ ...r, id: `sod_${i}`, tenant_id: 't', updated_by: null, updated_at: '2026-01-01T00:00:00Z' })) as SodRuleRow[];
  it('maker-checker: the preparer or an editor cannot approve (SOD-01)', () => {
    expect(evaluateApproval(rules, 'u1', { subjectType: 'journal_entry', preparedBy: 'u1' }).allowed).toBe(false);
    expect(evaluateApproval(rules, 'u2', { subjectType: 'proposal', preparedBy: 'agent:x', editedBy: 'u2' }).allowed).toBe(false);
    expect(evaluateApproval(rules, 'u2', { subjectType: 'journal_entry', preparedBy: 'u1' }).allowed).toBe(true);
  });
  it('whoever ran the agent cannot approve its output (SOD-02)', () => {
    const d = evaluateApproval(rules, 'u1', { subjectType: 'proposal', preparedBy: 'agent:bank-reconciliation', requestedBy: 'u1', agentPrepared: true });
    expect(d.allowed).toBe(false);
    expect(d.violations[0]?.message).toMatch(/ran the agent/);
  });
  it('a disabled rule stops applying (admins can tune controls, with an audit trail)', () => {
    const off = rules.map((r) => ({ ...r, enabled: false }));
    expect(evaluateApproval(off, 'u1', { subjectType: 'journal_entry', preparedBy: 'u1' }).allowed).toBe(true);
  });
  it('refuses conflicting role assignments', () => {
    expect(evaluateAssignment(rules, ['admin', 'controller'], new Set(['admin.users', 'je.approve'])).length).toBeGreaterThan(0);
    expect(evaluateAssignment(rules, ['auditor', 'staff_accountant'], new Set(['je.create'])).length).toBeGreaterThan(0);
    expect(evaluateAssignment(rules, ['controller'], new Set(['je.approve'])).length).toBe(0);
  });
  it('reads a role conflict as "the first role with any of the others", not every pair', () => {
    // SOD-05 lists the auditor first: preparer roles may still be combined with each other
    expect(evaluateAssignment(rules, ['staff_accountant', 'ap_specialist'], new Set(['je.create', 'vendor.manage']))).toEqual([]);
    expect(evaluateAssignment(rules, ['senior_accountant', 'controller'], new Set(['je.approve']))).toEqual([]);
    const clash = evaluateAssignment(rules, ['auditor', 'ap_specialist', 'cfo'], new Set(['je.approve']));
    expect(clash.map((c) => c.code)).toEqual(['SOD-05']);
    expect(clash[0]!.message).toBe('Holds conflicting roles: auditor + cfo, ap_specialist');
  });
  it('approval limits escalate by amount (AX-SOD-04)', () => {
    expect(approvalLimit(['senior_accountant'])).toBe(2_500_000);
    expect(approvalLimit(['controller'])).toBe(25_000_000);
    expect(approvalLimit(['cfo'])).toBeNull();
    expect(approvalLimit(['staff_accountant'])).toBe(0);
    expect(roleForAmount(1_000_000)).toBe('senior_accountant');
    expect(roleForAmount(20_000_000)).toBe('controller');
    expect(roleForAmount(45_900_000)).toBe('cfo');
  });
});

describe('plain-English policy rules', () => {
  const ctx = {
    accounts: [
      { code: '6400', name: 'Travel', postable: true },
      { code: '6500', name: 'Legal fees', postable: true },
      { code: '1000', name: 'Cash', postable: false },
    ],
    departments: [
      { code: 'SALES', name: 'Sales' },
      { code: 'GA', name: 'General & administrative' },
    ],
  };
  it('compiles coding rules with an optional department', () => {
    const r = compileRule('Code Skylark Air to 6400 Travel for Sales', ctx);
    expect(r.status).toBe('active');
    expect(r.compiled).toEqual({ type: 'code', merchantContains: 'Skylark Air', account: '6400', department: 'SALES' });
    expect(r.interpretation).toMatch(/coded to 6400 Travel, department SALES/);
  });
  it('compiles ceilings, never-auto, escalation and capitalization rules', () => {
    expect(compileRule('Never auto-post anything over $2,000', ctx)).toMatchObject({ compiled: { type: 'auto_ceiling', amountMinor: 200_000 }, thresholdChanges: { autoPostMaxMinor: 200_000 } });
    expect(compileRule('Never auto-post entries to 6500 Legal fees', ctx).compiled).toEqual({ type: 'never_auto', match: { accountCode: '6500' } });
    expect(compileRule('Never auto-post anything from Orbitron Ads', ctx).compiled).toEqual({ type: 'never_auto', match: { merchantContains: 'Orbitron Ads' } });
    expect(compileRule('Send anything over $50k to the CFO', ctx).compiled).toEqual({ type: 'escalate', minAmountMinor: 5_000_000, role: 'cfo' });
    expect(compileRule('Capitalize purchases over $2,500', ctx).thresholdChanges).toEqual({ capitalizationMinor: 250_000 });
  });
  it('refuses what it cannot interpret instead of guessing', () => {
    expect(compileRule('Code Skylark Air to 9999', ctx).status).toBe('unrecognized');
    expect(compileRule('Code Skylark Air to 1000 Cash', ctx).status).toBe('unrecognized'); // not postable
    expect(compileRule('Approve everything on Fridays', ctx)).toMatchObject({ status: 'unrecognized', compiled: null });
  });
});

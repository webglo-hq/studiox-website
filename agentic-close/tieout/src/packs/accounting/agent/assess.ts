/**
 * Assessment: amount, materiality, approver role, auto-eligibility and risk flags for a verified
 * proposal. Feeds the domain-agnostic autonomy router (core/agent/autonomy.ts).
 */
import type { Assessment, RunContext } from '../../../core/agent/runtime';
import type { Materiality, ProposalDraft } from '../../../core/agent/types';
import { periodEnd } from '../../../core/util/time';
import { fxRate } from '../fx/rates';
import { convert } from '../ledger/money';
import type { AccountingServices } from '../services';
import { CodingPayloadSchema, FluxPayloadSchema, JePayloadSchema, RecMatchPayloadSchema, ReconcilingItemPayloadSchema } from './payloads';

/** Approver role by USD-equivalent amount (role approval limits from controls/permissions.ts). */
export function roleForAmount(usdMinor: number): 'senior_accountant' | 'controller' | 'cfo' {
  if (usdMinor <= 2_500_000) return 'senior_accountant';
  if (usdMinor <= 25_000_000) return 'controller';
  return 'cfo';
}

export async function usdEquivalent(svc: AccountingServices, amountMinor: number, currency: string, periodKey: string): Promise<number> {
  if (currency === 'USD') return amountMinor;
  return convert(amountMinor, await fxRate(svc.tx, currency, 'USD', periodEnd(periodKey), 'closing'));
}

export async function assessDraft(svc: AccountingServices, draft: ProposalDraft, run: RunContext): Promise<Assessment> {
  const chart = await svc.ctx.chart();
  const entity = draft.entityId ? chart.entity(draft.entityId) : chart.legalEntities()[0]!;
  const mat = entity.materiality;
  const currency = draft.entityId ? entity.functional_currency : 'USD';
  const flags: string[] = [];
  let amount = 0;
  let autoEligible = false;
  let role: string | null = 'senior_accountant';
  const pk = draft.periodKey ?? run.periodKey ?? '';
  const rules = run.policy.rules.map((r) => r.compiled as { type?: string; match?: { accountCode?: string; merchantContains?: string }; minAmountMinor?: number; role?: string } | null).filter(Boolean);

  switch (draft.kind) {
    case 'journal_entry': {
      const p = JePayloadSchema.parse(draft.payload);
      amount = p.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
      const touchesControl = p.lines.some((l) => {
        const a = chart.tryAccount(l.account);
        return a?.control_subledger && ['ap', 'ar', 'card'].includes(a.control_subledger);
      });
      if (touchesControl && p.source !== 'subledger') flags.push('control_account');
      if (p.effects?.fixedAsset) flags.push('requires_capitalization');
      for (const id of p.dependsOnProposalIds ?? []) {
        const dep = await svc.tx.get('proposals', id);
        if (!dep || dep.status !== 'applied') flags.push('depends_on_pending');
      }
      for (const r of rules) if (r?.type === 'never_auto' && r.match?.accountCode && p.lines.some((l) => l.account === r.match!.accountCode)) flags.push('policy_never_auto');
      autoEligible = p.autoEligible === true && !['reclass', 'elimination'].includes(p.entryType) && !touchesControl;
      break;
    }
    case 'coding': {
      const p = CodingPayloadSchema.parse(draft.payload);
      amount = Math.abs(p.amountMinor);
      if (p.neverAuto) flags.push('policy_never_auto');
      autoEligible = true;
      break;
    }
    case 'rec_match': {
      const p = RecMatchPayloadSchema.parse(draft.payload);
      amount = Math.max(Math.abs(p.externalSumMinor), Math.abs(p.ledgerSumMinor));
      autoEligible = p.matchType !== 'fuzzy';
      break;
    }
    case 'reconciling_item': {
      const p = ReconcilingItemPayloadSchema.parse(draft.payload);
      amount = Math.abs(p.amountMinor);
      if (p.kind === 'unexplained') flags.push('unexplained');
      autoEligible = (p.kind === 'deposit_in_transit' && !!p.clearedBy) || p.kind === 'outstanding_check';
      break;
    }
    case 'flux_explanation': {
      const p = FluxPayloadSchema.parse(draft.payload);
      amount = Math.abs(p.varianceMinor);
      role = 'controller';
      break;
    }
    case 'finding':
      role = 'controller';
      break;
    case 'report':
      role = 'controller';
      break;
  }
  const usd = pk ? await usdEquivalent(svc, amount, currency, pk) : amount;
  if (draft.kind === 'journal_entry' || draft.kind === 'coding') role = roleForAmount(usd);
  for (const r of rules) if (r?.type === 'escalate' && r.minAmountMinor !== undefined && usd >= r.minAmountMinor && r.role) role = r.role;
  const materiality: Materiality = amount >= mat.performanceMinor ? 'material' : amount >= mat.clearlyTrivialMinor ? 'below_pm' : 'trivial';
  return { amountMinor: amount, currency, materiality, assignedRole: role, autoEligible, flags: [...new Set(flags)] };
}

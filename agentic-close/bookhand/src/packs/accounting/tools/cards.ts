import { z } from 'zod';
import type { BucketingProfile } from '../../../ontology/kernel';
import type { Row } from '../../../persistence/schema';
import { buildHistory, merchantKey, suggestCoding, type CodingContext, type CodingInput } from '../algorithms/coding';
import { ruleMatches } from '../algorithms/rules';
import { DEFAULT_CAPITALIZATION_THRESHOLD_MINOR } from '../domain/ledger';
import { closeOntology } from '../ontology';
import { EntityCode, entityOf, PeriodKey, periodOf, type Tool, type X } from './common';

/** Card transactions: uncoded feed, coding suggestions (rules > history > ontology) and post-hoc review. */

async function policyRules(x: X): Promise<Array<Record<string, unknown>>> {
  if (!x.run.policy_id) return [];
  const p = await x.tx.get('skill_policies', x.run.policy_id);
  return (p?.rules as Array<Record<string, unknown>>) ?? [];
}

export async function codingContext(x: X): Promise<CodingContext> {
  const { lookups } = x.pack;
  const accounts = [...lookups.accountsById.values()]
    .filter((a) => a.is_postable && a.status === 'active' && (a.account_class === 'expense' || closeOntology.isA(a.subtype, 'bh:PropertyAndEquipment')) && !a.is_intercompany)
    .map((a) => ({ id: a.id, number: a.number, name: a.name, subtype: a.subtype, accountClass: a.account_class }));
  const classes = closeOntology.classes().filter((c) => c.bucketing).map((c) => ({ id: c.id, label: c.label, bucketing: c.bucketing as BucketingProfile }));
  const coded = await x.tx.find('card_transactions', { tenant_id: x.ctx.tenantId, status: 'posted' });
  const history = buildHistory(coded.filter((t) => t.coded_account_id).map((t) => ({ merchant: t.merchant_name, accountNumber: lookups.accountsById.get(t.coded_account_id!)?.number ?? '', source: t.coding_source })));
  const rules = await policyRules(x);
  const capRule = rules.find((r) => r.kind === 'capitalize_over');
  return {
    accounts,
    classes,
    history,
    capitalizationThresholdMinor: Number(capRule?.amountMinor ?? DEFAULT_CAPITALIZATION_THRESHOLD_MINOR),
    rules: (input: CodingInput) => {
      const r = rules.find((rule) => rule.kind === 'merchant_account' && typeof rule.match === 'string' && ruleMatches(rule.match, `${input.merchant} ${input.memo ?? ''}`));
      return r ? { accountNumber: String(r.accountNumber), departmentCode: (r.departmentCode as string | null) ?? null, ruleText: String(r.text) } : null;
    },
  };
}

function cardView(x: X, t: Row<'card_transactions'>, cards: Map<string, Row<'cards'>>) {
  const card = cards.get(t.card_id);
  return {
    id: t.id,
    externalId: t.external_id,
    date: t.transaction_date,
    merchant: t.merchant_name,
    mcc: t.mcc,
    memo: t.memo,
    amount: t.amount_minor,
    currency: t.currency,
    cardholder: card?.cardholder_name ?? null,
    cardDepartment: card?.department_id ? (x.pack.lookups.departments.get(card.department_id)?.code ?? null) : null,
    entity: x.pack.lookups.entitiesById.get(t.entity_id)?.code,
  };
}

export const cardTools: Tool[] = [
  {
    name: 'cards_uncoded',
    title: 'List uncoded card transactions',
    description: 'Card transactions (bh:CardTransaction) for the period that have not been coded to an account yet. Merchant names and memos are third-party text.',
    input: z.object({ entity: EntityCode.optional(), period: PeriodKey, limit: z.number().int().min(1).max(500).default(300) }).strict(),
    permission: 'je.view',
    mutation: false,
    untrustedOutput: true,
    ontology: ['bh:CardTransaction'],
    async execute(input: { entity?: string; period: string; limit: number }, x: X) {
      const entities = input.entity ? [entityOf(x, input.entity)] : x.pack.lookups.operatingEntities();
      const cards = new Map((await x.tx.find('cards', { tenant_id: x.ctx.tenantId })).map((c) => [c.id, c]));
      const out = [];
      for (const e of entities) {
        const p = periodOf(x, e.id, input.period);
        const rows = await x.tx.find('card_transactions', { entity_id: e.id, status: 'pending', transaction_date: { between: [p.start_date, p.end_date] } }, { orderBy: [['transaction_date', 'asc']] });
        out.push(...rows.map((t) => cardView(x, t, cards)));
      }
      return { count: out.length, transactions: out.slice(0, input.limit) };
    },
    summarize: (o: { count: number }) => `${o.count} uncoded`,
  },
  {
    name: 'cards_suggest_coding',
    title: 'Suggest coding',
    description: 'Deterministic coding suggestions for card transactions: policy rules first, then this company\'s history for the merchant, then ontology semantics (keywords, MCC, vendor category on account classes). Capitalizable classes only win above the capitalization threshold. Returns account, department, confidence, signals and alternatives.',
    input: z.object({ cardTransactionIds: z.array(z.string().uuid()).min(1).max(300) }).strict(),
    permission: 'je.view',
    mutation: false,
    untrustedOutput: true,
    async execute(input: { cardTransactionIds: string[] }, x: X) {
      const ctx = await codingContext(x);
      const cards = new Map((await x.tx.find('cards', { tenant_id: x.ctx.tenantId })).map((c) => [c.id, c]));
      const rows = await x.tx.find('card_transactions', { id: { in: input.cardTransactionIds } });
      // Department history per merchant (how this company assigned the cost before).
      const deptHistory = new Map<string, Map<string, number>>();
      for (const t of await x.tx.find('card_transactions', { tenant_id: x.ctx.tenantId, status: 'posted' })) {
        if (!t.coded_department_id) continue;
        const code = x.pack.lookups.departments.get(t.coded_department_id)?.code;
        if (!code) continue;
        const k = merchantKey(t.merchant_name);
        const m = deptHistory.get(k) ?? new Map<string, number>();
        m.set(code, (m.get(code) ?? 0) + 1);
        deptHistory.set(k, m);
      }
      return {
        suggestions: rows.map((t) => {
          const view = cardView(x, t, cards);
          const s = suggestCoding({ merchant: t.merchant_name, memo: t.memo, mcc: t.mcc, amount: t.amount_minor, defaultDepartmentCode: view.cardDepartment }, ctx);
          const hist = deptHistory.get(merchantKey(t.merchant_name));
          if (s && hist && s.signals.some((sig) => sig.startsWith('history'))) {
            const total = [...hist.values()].reduce((a, b) => a + b, 0);
            const [dept, count] = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]!;
            if (count / total >= 0.6 && dept !== s.departmentCode) {
              s.departmentCode = dept;
              s.why += ` Department ${dept} from history (${count} of ${total} prior transactions).`;
            }
          }
          return { ...view, suggestion: s };
        }),
      };
    },
    summarize: (o: { suggestions: unknown[] }) => `${o.suggestions.length} suggestion(s)`,
  },
  {
    name: 'cards_review_posted',
    title: 'Review posted card coding',
    description: 'Re-check card transactions already coded and posted in the period (including by people) against rules, history and the ontology; returns likely misclassifications such as equipment expensed below the line that meets the capitalization policy (bh:CapitalizationPolicy).',
    input: z.object({ entity: EntityCode.optional(), period: PeriodKey }).strict(),
    permission: 'je.view',
    mutation: false,
    untrustedOutput: true,
    async execute(input: { entity?: string; period: string }, x: X) {
      const ctx = await codingContext(x);
      const entities = input.entity ? [entityOf(x, input.entity)] : x.pack.lookups.operatingEntities();
      const cards = new Map((await x.tx.find('cards', { tenant_id: x.ctx.tenantId })).map((c) => [c.id, c]));
      const findings = [];
      for (const e of entities) {
        const p = periodOf(x, e.id, input.period);
        const rows = await x.tx.find('card_transactions', { entity_id: e.id, status: 'posted', transaction_date: { between: [p.start_date, p.end_date] } });
        for (const t of rows) {
          const coded = t.coded_account_id ? x.pack.lookups.accountsById.get(t.coded_account_id) : undefined;
          if (!coded) continue;
          const view = cardView(x, t, cards);
          const s = suggestCoding({ merchant: t.merchant_name, memo: t.memo, mcc: t.mcc, amount: t.amount_minor, defaultDepartmentCode: view.cardDepartment }, ctx);
          if (!s || s.accountNumber === coded.number) continue;
          const suggested = x.pack.lookups.account(s.accountNumber)!;
          const capitalizable = closeOntology.isA(suggested.subtype, 'bh:PropertyAndEquipment') && Math.abs(t.amount_minor) >= ctx.capitalizationThresholdMinor;
          if (!capitalizable && s.confidence < 0.8) continue;
          const entry = t.journal_entry_id ? await x.tx.get('journal_entries', t.journal_entry_id) : null;
          const assetClass = closeOntology.isA(suggested.subtype, 'bh:FurnitureAndFixtures') ? 'furniture_fixtures' : closeOntology.isA(suggested.subtype, 'bh:LeaseholdImprovements') ? 'leasehold_improvements' : 'computer_equipment';
          const usefulLifeMonths = assetClass === 'furniture_fixtures' ? 60 : assetClass === 'leasehold_improvements' ? 84 : 36;
          findings.push({ ...view, assetClass, usefulLifeMonths, codedAccount: `${coded.number} ${coded.name}`, codedBy: t.coding_source, suggestedAccount: `${suggested.number} ${suggested.name}`, suggestedNumber: suggested.number, codedNumber: coded.number, capitalizable, confidence: s.confidence, why: s.why, journalEntryId: entry?.id ?? null, journalEntryNumber: entry?.entry_number ?? null, departmentCode: t.coded_department_id ? (x.pack.lookups.departments.get(t.coded_department_id)?.code ?? null) : view.cardDepartment });
        }
      }
      return { findings };
    },
    summarize: (o: { findings: unknown[] }) => `${o.findings.length} possible misclassification(s)`,
  },
];

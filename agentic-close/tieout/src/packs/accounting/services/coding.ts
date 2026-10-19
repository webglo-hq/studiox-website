/**
 * Transaction coding ("bucketing"): assign an account and department to card charges and bill
 * lines. Evidence is combined in a fixed precedence that a reviewer can follow:
 *
 *   1. human mapping   the Controller's policy mappings (merchant/vendor/MCC → account, dept)
 *   2. rule            plain-English rules compiled to conditions (see agent/rules.ts)
 *   3. history         how this merchant was coded before (mode + consistency)
 *   4. vendor master   the vendor's default account
 *   5. ontology        ISO 18245 MCC and keyword signals on account classes (tie:*Expense)
 *
 * Sources 3–5 are independent signals; agreement raises confidence (noisy-OR). A purchase at or
 * above the capitalization threshold with PP&E signals is routed to an asset account and flagged
 * `requires_capitalization` (AX-SCH-03), which always needs a person.
 */
import type { EffectivePolicy } from '../../../core/agent/types';
import type { PolicyMapping } from '../../../core/skills/policy-types';
import { periodEnd, periodStart, shiftPeriod } from '../../../core/util/time';
import type { AccountRow, BillLineRow, CardTransactionRow } from '../../../schema';
import { closeOntology } from '../ontology';
import type { AcctContext } from './context';

export interface CodingSignal {
  source: 'human' | 'rule' | 'history' | 'vendor_default' | 'ontology';
  accountCode: string;
  weight: number;
  detail: string;
}

export interface CodingSuggestion {
  accountCode: string;
  accountName: string;
  department: string | null;
  confidence: number;
  source: CodingSignal['source'];
  signals: CodingSignal[];
  alternatives: { accountCode: string; confidence: number }[];
  capitalization: { required: boolean; thresholdMinor: number; reason: string } | null;
  neverAuto: boolean;
}

export interface CodingSubject {
  kind: 'card_transaction' | 'bill_line';
  id: string;
  entityId: string;
  date: string;
  merchant: string;
  mcc: string | null;
  description: string;
  amountMinor: number;
  defaultDepartment: string | null;
  vendorId: string | null;
}

export interface CompiledCodingRule {
  type: 'code';
  merchantContains?: string;
  mcc?: string;
  account: string;
  department?: string;
  ruleId: string;
  text: string;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const noisyOr = (ws: number[]) => 1 - ws.reduce((p, w) => p * (1 - w), 1);

/** Expense accounts by PP&E category keyword (for routing capital purchases). */
const ASSET_BY_KEYWORD: [RegExp, string][] = [
  [/spectromet|oscillo|analy[sz]er|instrument|calibration|test (rig|bench)|lab/i, '1520'],
  [/laptop|workstation|server|computer|monitor|rack|network/i, '1510'],
  [/furniture|desk|chair|cabinet|fixture/i, '1530'],
];

export class CodingService {
  constructor(private readonly c: AcctContext) {}

  async uncodedCards(entityId: string, periodKey: string): Promise<(CardTransactionRow & { cardholder: string; cardDepartment: string | null })[]> {
    const rows = await this.c.tx.find('card_transactions', { entity_id: entityId, status: 'pending_coding', txn_date: { lte: periodEnd(periodKey) } }, { orderBy: [['txn_date', 'asc'], ['external_id', 'asc']] });
    const cards = new Map((await this.c.tx.find('cards', { entity_id: entityId })).map((c) => [c.id, c]));
    return rows.map((r) => ({ ...r, cardholder: cards.get(r.card_id)?.cardholder_name ?? '', cardDepartment: cards.get(r.card_id)?.department ?? null }));
  }

  /** Posted items in the period whose coding deserves a second look. */
  async postedForReview(entityId: string, periodKey: string): Promise<CodingSubject[]> {
    const from = periodStart(periodKey);
    const to = periodEnd(periodKey);
    const cards = new Map((await this.c.tx.find('cards', { entity_id: entityId })).map((c) => [c.id, c]));
    const chart = await this.c.chart();
    const out: (CodingSubject & { codedAccount: string; codedDepartment: string | null })[] = [];
    for (const t of await this.c.tx.find('card_transactions', { entity_id: entityId, status: 'posted', txn_date: { gte: from, lte: to } })) {
      if (!t.account_id) continue;
      out.push({ kind: 'card_transaction', id: t.id, entityId, date: t.txn_date, merchant: t.merchant_name, mcc: t.mcc, description: t.memo ?? '', amountMinor: t.amount_minor, defaultDepartment: cards.get(t.card_id)?.department ?? null, vendorId: null, codedAccount: chart.account(t.account_id).code, codedDepartment: t.department });
    }
    const bills = await this.c.tx.find('bills', { entity_id: entityId, bill_date: { gte: from, lte: to } });
    const vendors = new Map((await this.c.tx.find('vendors', {})).map((v) => [v.id, v]));
    for (const b of bills) {
      if (!['posted', 'partially_paid', 'paid'].includes(b.status)) continue;
      const v = vendors.get(b.vendor_id);
      for (const l of await this.c.tx.find('bill_lines', { bill_id: b.id })) {
        if (!l.account_id) continue;
        out.push({ kind: 'bill_line', id: l.id, entityId, date: b.bill_date, merchant: v?.name ?? '', mcc: null, description: l.description, amountMinor: l.amount_minor, defaultDepartment: l.department ?? v?.default_department ?? null, vendorId: b.vendor_id, codedAccount: chart.account(l.account_id).code, codedDepartment: l.department });
      }
    }
    return out;
  }

  subjectFromCard(t: CardTransactionRow, cardDepartment: string | null): CodingSubject {
    return { kind: 'card_transaction', id: t.id, entityId: t.entity_id, date: t.txn_date, merchant: t.merchant_name, mcc: t.mcc, description: t.memo ?? '', amountMinor: t.amount_minor, defaultDepartment: cardDepartment, vendorId: null };
  }

  subjectFromBillLine(l: BillLineRow, bill: { entity_id: string; bill_date: string; vendor_id: string }, vendorName: string): CodingSubject {
    return { kind: 'bill_line', id: l.id, entityId: bill.entity_id, date: bill.bill_date, merchant: vendorName, mcc: null, description: l.description, amountMinor: l.amount_minor, defaultDepartment: l.department, vendorId: bill.vendor_id };
  }

  /** Classify one item. `excludeId` keeps an item's own coding out of the history signal. */
  async classify(s: CodingSubject, policy: Pick<EffectivePolicy, 'mappings' | 'rules' | 'thresholds'>, opts: { excludeId?: string } = {}): Promise<CodingSuggestion> {
    const chart = await this.c.chart();
    const signals: CodingSignal[] = [];
    const merchantN = norm(s.merchant);
    let neverAuto = false;
    // 1. human mappings
    const mapping = policy.mappings.find((m) => mappingMatches(m, s));
    if (mapping?.set.account) signals.push({ source: 'human', accountCode: mapping.set.account, weight: 0.99, detail: `Policy mapping${mapping.note ? ` (${mapping.note})` : ''}: ${Object.entries(mapping.match).map(([k, v]) => `${k} = ${v}`).join(', ')}` });
    // 2. compiled plain-English rules
    for (const r of policy.rules) {
      const c = r.compiled as unknown as CompiledCodingRule | { type: string; match?: { merchantContains?: string; accountCode?: string } } | null;
      if (!c) continue;
      if (c.type === 'code') {
        const cr = c as CompiledCodingRule;
        if ((cr.merchantContains && merchantN.includes(norm(cr.merchantContains))) || (cr.mcc && s.mcc === cr.mcc)) signals.push({ source: 'rule', accountCode: cr.account, weight: 0.97, detail: `Rule: “${r.text}”` });
      }
      if (c.type === 'never_auto' && 'match' in c && c.match?.merchantContains && merchantN.includes(norm(c.match.merchantContains))) neverAuto = true;
    }
    // 3. history (same merchant, previously coded)
    const hist = (await this.c.tx.find('card_transactions', { entity_id: s.entityId, merchant_name: s.merchant, status: 'posted' })).filter((h) => h.id !== opts.excludeId && h.account_id);
    if (hist.length) {
      const counts = new Map<string, number>();
      for (const h of hist) counts.set(h.account_id!, (counts.get(h.account_id!) ?? 0) + 1);
      const [topId, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
      const consistency = n / hist.length;
      const w = Math.min(0.97, 0.6 + 0.3 * consistency * Math.min(1, hist.length / 5));
      signals.push({ source: 'history', accountCode: chart.account(topId).code, weight: w, detail: `${n} of ${hist.length} earlier ${s.merchant} charges were coded here` });
    }
    // 4. vendor master
    const vendors = await this.c.tx.find('vendors', {});
    const vendor = s.vendorId ? vendors.find((v) => v.id === s.vendorId) : vendors.find((v) => norm(v.name) === merchantN || (merchantN.length > 6 && norm(v.name).startsWith(merchantN.split(' ').slice(0, 2).join(' '))));
    if (vendor?.default_account_id) signals.push({ source: 'vendor_default', accountCode: chart.account(vendor.default_account_id).code, weight: 0.9, detail: `${vendor.name} is in the vendor master with default account ${chart.account(vendor.default_account_id).code}` });
    // 5. ontology signals (MCC, keywords)
    const onto = closeOntology();
    const text = `${s.merchant} ${s.description}`.toLowerCase();
    for (const cls of onto.allClasses()) {
      if (!cls.signals) continue;
      const accts = chart.accounts.filter((a) => a.ontology_class === cls.id && a.is_postable && a.status === 'active');
      if (!accts.length) continue;
      const mccHit = !!s.mcc && (cls.signals.mcc ?? []).includes(s.mcc);
      const kw = (cls.signals.keywords ?? []).filter((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text));
      if (!mccHit && !kw.length) continue;
      const w = mccHit && kw.length ? 0.85 : mccHit ? 0.78 : Math.min(0.7, 0.45 + 0.1 * kw.length);
      const target = pickAccount(accts, s);
      signals.push({ source: 'ontology', accountCode: target.code, weight: w, detail: `${cls.label} (${cls.id})${mccHit ? `: MCC ${s.mcc}` : ''}${kw.length ? `${mccHit ? ',' : ':'} keyword${kw.length > 1 ? 's' : ''} ${kw.map((k) => `“${k}”`).join(', ')}` : ''}` });
    }
    // ---- decide
    const capThreshold = policy.thresholds.capitalizationMinor ?? 500_000;
    let best: { code: string; conf: number; source: CodingSignal['source'] };
    const human = signals.find((x) => x.source === 'human');
    const rule = signals.find((x) => x.source === 'rule');
    const scores = new Map<string, number[]>();
    for (const sig of signals) if (sig.source !== 'human' && sig.source !== 'rule') scores.set(sig.accountCode, [...(scores.get(sig.accountCode) ?? []), sig.weight]);
    const ranked = [...scores.entries()].map(([code, ws]) => ({ code, conf: Math.min(0.99, noisyOr(ws)) })).sort((a, b) => b.conf - a.conf || a.code.localeCompare(b.code));
    if (human) best = { code: human.accountCode, conf: 0.99, source: 'human' };
    else if (rule) best = { code: rule.accountCode, conf: 0.97, source: 'rule' };
    else if (ranked.length) {
      const top = ranked[0]!;
      const runnerUp = ranked[1];
      // conflicting evidence lowers confidence in proportion to how close the runner-up is
      const conf = runnerUp ? top.conf - 0.2 * runnerUp.conf * (runnerUp.conf / top.conf) : top.conf;
      const src = signals.filter((x) => x.accountCode === top.code).sort((a, b) => b.weight - a.weight)[0]!.source;
      best = { code: top.code, conf: Math.max(0.3, Math.round(conf * 1000) / 1000), source: src };
    } else best = { code: '1999', conf: 0.2, source: 'ontology' };
    // capitalization (AX-SCH-03)
    let capitalization: CodingSuggestion['capitalization'] = null;
    const ppeSignal = signals.find((x) => x.source === 'ontology' && chart.account(x.accountCode).ontology_class === 'tie:PropertyPlantEquipment') || ASSET_BY_KEYWORD.some(([re]) => re.test(text));
    const vendorAsset = vendor?.default_account_id && chart.account(vendor.default_account_id).ontology_class === 'tie:PropertyPlantEquipment';
    if (s.amountMinor >= capThreshold && (ppeSignal || vendorAsset)) {
      const kwAsset = ASSET_BY_KEYWORD.find(([re]) => re.test(text))?.[1];
      const assetCode = (vendorAsset ? chart.account(vendor!.default_account_id!).code : null) ?? kwAsset ?? '1510';
      const check = onto.check('AX-SCH-03', { amountMinor: s.amountMinor, thresholdMinor: capThreshold, capitalized: false, usefulLifeMonths: 60 });
      capitalization = { required: !check.passed, thresholdMinor: capThreshold, reason: `${(s.amountMinor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} is at or above the ${(capThreshold / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} capitalization threshold and looks like equipment with a multi-year life.` };
      if (best.source !== 'human') best = { code: assetCode, conf: Math.max(best.conf, 0.9), source: vendorAsset ? 'vendor_default' : 'ontology' };
    }
    const acct = chart.account(best.code);
    let dept: string | null = null;
    if (acct.required_dimensions.includes('department')) {
      const ruleDept = rule ? policy.rules.map((r) => r.compiled as unknown as CompiledCodingRule | null).find((c) => c?.type === 'code' && c.account === best.code)?.department : undefined;
      dept = mapping?.set.department ?? ruleDept ?? s.defaultDepartment ?? vendor?.default_department ?? 'GA';
    }
    return {
      accountCode: acct.code,
      accountName: acct.name,
      department: dept,
      confidence: best.conf,
      source: best.source,
      signals,
      alternatives: ranked.filter((r) => r.code !== acct.code).slice(0, 3).map((r) => ({ accountCode: r.code, confidence: Math.round(r.conf * 1000) / 1000 })),
      capitalization,
      neverAuto,
    };
  }

  /** History window used for coding statistics (trailing 12 months). */
  historyRange(periodKey: string) {
    return { from: periodStart(shiftPeriod(periodKey, -12)), to: periodEnd(periodKey) };
  }
}

function mappingMatches(m: PolicyMapping, s: CodingSubject): boolean {
  return Object.entries(m.match).every(([k, v]) => {
    if (k === 'merchant' || k === 'vendor') return norm(s.merchant) === norm(v) || norm(s.merchant).includes(norm(v));
    if (k === 'mcc') return s.mcc === v;
    if (k === 'entity') return s.entityId === v;
    return false;
  });
}

function pickAccount(accts: AccountRow[], s: CodingSubject): AccountRow {
  if (accts.length === 1) return accts[0]!;
  // prefer an account whose name shares a word with the merchant/description
  const text = `${s.merchant} ${s.description}`.toLowerCase();
  return accts.find((a) => a.name.toLowerCase().split(/\W+/).some((w) => w.length > 4 && text.includes(w))) ?? accts[0]!;
}

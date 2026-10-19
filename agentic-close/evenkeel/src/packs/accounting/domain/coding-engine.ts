import type { OntologyModel } from '../../../framework/ontology/model';
import { formatMoney } from '../../../framework/util/money';
import { normalize, sanitizeUntrusted, tokens } from '../../../framework/util/text';
import type { SpendAnnotations } from '../ontology/classes-spend';
import type { CodingDecision } from '../ontology/shapes';
import { conditionsMatch, type CompiledRule, type RuleFacts } from './policy-rules';

/**
 * Ontology-powered bucketing. A transaction is scored against four independent signals —
 * policy rules (plain English, compiled), vendor history, ontology spend concepts (keywords
 * + ISO 18245 merchant category codes) and accounting policies (capitalisation, prepaid) —
 * then dimensions are inferred and a confidence plus plain-English rationale is produced.
 */

export interface CodingTxn {
  id: string;
  merchant: string;
  mcc: string | null;
  memo: string | null;
  amount: number;
  cardholder: string;
  cardholderDepartmentId: string | null;
}

export interface CodingAccount {
  id: string;
  code: string;
  name: string;
  concept: string | null;
  accountType: string;
  accountClass: string;
  isPostable: boolean;
  requiresDepartment: boolean;
}

export interface HistoryEntry {
  total: number;
  byAccount: Map<string, number>;
  byDepartment: Map<string, number>;
}

export interface CodingEnv {
  ontology: OntologyModel;
  accounts: CodingAccount[];
  history: Map<string, HistoryEntry>;
  rules: CompiledRule[];
  capitalizationThreshold: number;
  prepaidThreshold: number;
  /** concept → prepaid account id (e.g. ek:SoftwareExpense → 1210) with fallback "*" */
  prepaidAccounts: Record<string, string>;
  fixedAssetAccountId: string | null;
  departmentNames: Map<string, string>;
}

export interface CodingResult extends CodingDecision {
  conceptId: string | null;
  explanation: string;
  flags: string[];
  blockAuto: boolean;
  quantity: number;
  servicePeriodMonths: number | null;
}

export function merchantKey(merchant: string): string {
  return tokens(merchant).join(' ') || normalize(merchant);
}

export function quantityHint(memo: string | null): number {
  if (!memo) return 1;
  const m = /\b(?:qty|quantity|x)\s*[:#]?\s*(\d{1,4})\b/i.exec(memo) ?? /\b(\d{1,4})\s*(?:x|units?|pcs|seats)\b/i.exec(memo) ?? /\((\d{1,4})\s*(?:units?|laptops?|monitors?)\)/i.exec(memo);
  const n = m ? Number(m[1]) : 1;
  return n >= 1 && n <= 5000 ? n : 1;
}

const ANNUAL = /\b(annual|yearly|12[- ]?months?|twelve months|1[- ]year|per year)\b/i;

interface ConceptScore {
  conceptId: string;
  score: number;
  mccHit: boolean;
  keyword: string | null;
}

export function scoreConcepts(txn: CodingTxn, ontology: OntologyModel): ConceptScore[] {
  const text = ` ${normalize(`${txn.merchant} ${txn.memo ?? ''}`)} `;
  const toks = new Set(tokens(`${txn.merchant} ${txn.memo ?? ''}`, false));
  const out: ConceptScore[] = [];
  for (const cls of ontology.annotated('keywords')) {
    const ann = cls.annotations as unknown as SpendAnnotations;
    let score = 0;
    const mccHit = !!txn.mcc && (ann.mcc ?? []).includes(txn.mcc);
    if (mccHit) score += 0.55;
    let keyword: string | null = null;
    for (const kw of ann.keywords) {
      const k = normalize(kw);
      if (!k) continue;
      const hit = k.includes(' ') ? text.includes(` ${k} `) : toks.has(k);
      if (hit) {
        keyword = kw;
        score += k.includes(' ') ? 0.5 : 0.4;
        break;
      }
    }
    if (score > 0) out.push({ conceptId: cls.id, score: Math.min(1, score), mccHit, keyword });
  }
  return out.sort((a, b) => b.score - a.score || a.conceptId.localeCompare(b.conceptId));
}

function accountForConcept(env: CodingEnv, conceptId: string): CodingAccount | undefined {
  const exact = env.accounts.filter((a) => a.concept === conceptId && a.isPostable);
  if (exact.length) return exact.sort((a, b) => a.code.localeCompare(b.code))[0];
  // Walk up the concept hierarchy (e.g. HostingExpense → CostOfRevenue)
  for (const anc of env.ontology.ancestors(conceptId)) {
    const a = env.accounts.find((x) => x.concept === anc && x.isPostable);
    if (a) return a;
  }
  return undefined;
}

export function codeTransaction(txn: CodingTxn, env: CodingEnv): CodingResult {
  const facts: RuleFacts = { merchant: txn.merchant, memo: txn.memo ?? '', mcc: txn.mcc, cardholder: txn.cardholder, amount: txn.amount };
  const flags: string[] = [];
  const basis = new Set<CodingDecision['basis'][number]>();
  const reasons: string[] = [];
  const safeMerchant = sanitizeUntrusted(txn.merchant, 80);
  let blockAuto = false;
  let treatmentOverride: { treatment: 'prepaid' | 'capitalize'; months: number | null } | null = null;
  let accountId: string | null = null;
  let departmentId: string | null = null;
  let confidence = 0;
  let conceptId: string | null = null;
  const alternatives = new Map<string, number>();

  // 1. Policy rules
  for (const r of env.rules) {
    if (r.kind === 'threshold') continue;
    if (!conditionsMatch(r.when, facts)) continue;
    if (r.kind === 'block_auto') {
      blockAuto = true;
      flags.push(`Policy: ${r.explanation}`);
    } else if (r.kind === 'flag') {
      blockAuto = true;
      flags.push(`Policy: ${r.explanation}`);
    } else if (r.kind === 'treatment' && !treatmentOverride) {
      treatmentOverride = { treatment: r.treatment, months: r.months };
      basis.add('policy_rule');
      reasons.push(`your policy says ${r.explanation.charAt(0).toLowerCase()}${r.explanation.slice(1)}`);
    } else if (r.kind === 'map' && !accountId) {
      accountId = r.accountId;
      departmentId = r.departmentId;
      confidence = 0.97;
      basis.add('policy_rule');
      reasons.push(`your policy rule “${r.source}” applies`);
    }
  }

  // 2. Vendor history
  const hist = env.history.get(merchantKey(txn.merchant));
  let histAccount: string | null = null;
  let histConf = 0;
  if (hist && hist.total >= 3) {
    const [topAcc, topCount] = [...hist.byAccount.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const share = topCount / hist.total;
    if (share >= 0.75) {
      histAccount = topAcc;
      histConf = Math.min(0.96, 0.78 + 0.15 * share + 0.03 * Math.min(1, hist.total / 10));
      alternatives.set(topAcc, Math.max(alternatives.get(topAcc) ?? 0, histConf));
    }
  }

  // 3. Ontology concepts
  const concepts = scoreConcepts(txn, env.ontology);
  const topConcept = concepts[0];
  let ontoAccount: CodingAccount | undefined;
  let ontoConf = 0;
  if (topConcept) {
    conceptId = topConcept.conceptId;
    ontoAccount = accountForConcept(env, topConcept.conceptId);
    if (ontoAccount) {
      ontoConf = 0.52 + 0.36 * topConcept.score - (concepts[1] && concepts[1].score >= topConcept.score ? 0.12 : 0);
      alternatives.set(ontoAccount.id, Math.max(alternatives.get(ontoAccount.id) ?? 0, ontoConf));
    }
    for (const c of concepts.slice(1, 3)) {
      const a = accountForConcept(env, c.conceptId);
      if (a && !alternatives.has(a.id)) alternatives.set(a.id, 0.4 + 0.3 * c.score);
    }
  }

  if (!accountId) {
    if (histAccount && ontoAccount && histAccount === ontoAccount.id) {
      accountId = histAccount;
      confidence = Math.min(0.98, Math.max(histConf, ontoConf) + 0.04);
      basis.add('vendor_history');
      basis.add('ontology_concept');
      if (topConcept?.mccHit) basis.add('merchant_category');
      reasons.push(`${safeMerchant} has been coded here ${hist!.byAccount.get(histAccount)}/${hist!.total} times and it matches the concept “${env.ontology.cls(topConcept!.conceptId).label}”`);
    } else if (histAccount && histConf >= ontoConf) {
      accountId = histAccount;
      confidence = histConf - (ontoAccount ? 0.04 : 0);
      basis.add('vendor_history');
      reasons.push(`${safeMerchant} has been coded here ${hist!.byAccount.get(histAccount)}/${hist!.total} times`);
    } else if (ontoAccount) {
      accountId = ontoAccount.id;
      confidence = ontoConf;
      basis.add('ontology_concept');
      if (topConcept!.mccHit) basis.add('merchant_category');
      const why = [topConcept!.mccHit ? `merchant category ${txn.mcc}` : null, topConcept!.keyword ? `the word “${topConcept!.keyword}”` : null].filter(Boolean).join(' and ');
      reasons.push(`${why || 'the description'} points to “${env.ontology.cls(topConcept!.conceptId).label}”`);
    }
  }

  // 4. Accounting policies: capitalisation and prepaid deferral
  const qty = quantityHint(txn.memo);
  const unit = Math.round(Math.abs(txn.amount) / qty);
  let treatment: CodingDecision['treatment'] = 'expense';
  let servicePeriodMonths: number | null = ANNUAL.test(`${txn.memo ?? ''} ${txn.merchant}`) ? 12 : null;
  if (treatmentOverride) {
    treatment = treatmentOverride.treatment;
    if (treatmentOverride.months) servicePeriodMonths = treatmentOverride.months;
  } else if (conceptId === 'ek:ComputerEquipment' && unit >= env.capitalizationThreshold && env.fixedAssetAccountId) {
    treatment = 'capitalize';
    basis.add('capitalization_policy');
    reasons.push(`each unit costs ${formatMoney(unit)}, at or above the ${formatMoney(env.capitalizationThreshold)} capitalisation threshold (ASC 360)`);
  } else if (servicePeriodMonths && servicePeriodMonths > 1 && Math.abs(txn.amount) >= env.prepaidThreshold) {
    treatment = 'prepaid';
    basis.add('prepaid_policy');
    reasons.push(`it covers ${servicePeriodMonths} months of service, so it is deferred as a prepaid (ASC 340-10)`);
  }
  const expenseAccountId = accountId;
  if (treatment === 'capitalize' && env.fixedAssetAccountId) {
    accountId = env.fixedAssetAccountId;
    confidence = Math.max(confidence, 0.88);
  } else if (treatment === 'prepaid') {
    accountId = (conceptId && env.prepaidAccounts[conceptId]) || env.prepaidAccounts['*'] || accountId;
    confidence = Math.max(confidence, 0.86);
  }

  if (!accountId) {
    // No signal: route to suspense-like default with low confidence, flagged for judgement
    const fallback = env.accounts.find((a) => a.concept === 'ek:OfficeExpense') ?? env.accounts.find((a) => a.accountClass === 'expense' && a.isPostable)!;
    accountId = fallback.id;
    confidence = 0.3;
    basis.add('ontology_concept');
    flags.push('No rule, history or concept matched — needs a person to choose the account.');
    reasons.push('nothing in policy, history or the ontology matched, so this is a placeholder guess');
  }

  // 5. Dimensions
  const account = env.accounts.find((a) => a.id === accountId);
  const expenseAccount = env.accounts.find((a) => a.id === expenseAccountId);
  const needsDept = account?.requiresDepartment || expenseAccount?.requiresDepartment || treatment !== 'expense';
  if (!departmentId && needsDept) {
    if (hist) {
      const [topDept, n] = [...hist.byDepartment.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      if (topDept && n / hist.total >= 0.8) departmentId = topDept;
    }
    departmentId = departmentId ?? txn.cardholderDepartmentId;
  }
  if (needsDept && !departmentId) {
    flags.push('No department could be inferred.');
    confidence = Math.min(confidence, 0.5);
  }

  const acc = account ? `${account.code} ${account.name}` : 'an account';
  const dept = departmentId ? ` · ${env.departmentNames.get(departmentId) ?? 'department'}` : '';
  const explanation = `Coded to ${acc}${dept} because ${reasons.join('; ')}.`;
  const alts = [...alternatives.entries()]
    .filter(([id]) => id !== accountId)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, score]) => ({ accountId: id, score: Math.round(Math.min(1, score) * 100) / 100 }));

  return {
    subjectType: 'card_transaction',
    subjectId: txn.id,
    accountId,
    departmentId,
    treatment,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100,
    basis: [...basis],
    alternatives: alts,
    conceptId,
    explanation,
    flags,
    blockAuto,
    quantity: qty,
    servicePeriodMonths,
    previousAccountId: null,
  };
}

/** Build vendor history from previously coded transactions. */
export function buildHistory(rows: { merchant: string; accountId: string | null; departmentId: string | null }[]): Map<string, HistoryEntry> {
  const out = new Map<string, HistoryEntry>();
  for (const r of rows) {
    if (!r.accountId) continue;
    const k = merchantKey(r.merchant);
    const h = out.get(k) ?? { total: 0, byAccount: new Map(), byDepartment: new Map() };
    h.total++;
    h.byAccount.set(r.accountId, (h.byAccount.get(r.accountId) ?? 0) + 1);
    if (r.departmentId) h.byDepartment.set(r.departmentId, (h.byDepartment.get(r.departmentId) ?? 0) + 1);
    out.set(k, h);
  }
  return out;
}

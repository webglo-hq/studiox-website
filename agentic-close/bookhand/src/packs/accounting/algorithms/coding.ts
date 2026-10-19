import type { BucketingProfile } from '../../../ontology/kernel';
import { normalizeText } from './text';

/**
 * Transaction coding ("bucketing"): choose the GL account and department for a card or bank transaction.
 * Signals, strongest first:
 *   1. policy rules written in plain English by the accountant (compiled by rules.ts)
 *   2. this company's history for the merchant (how it was coded before, including human corrections)
 *   3. ontology semantics: keywords, MCC codes and vendor categories on account-type classes
 * Capitalizable classes only win above the capitalization threshold (ASC 360 policy).
 */

export interface CodingAccount {
  id: string;
  number: string;
  name: string;
  subtype: string;
  accountClass: string;
}

export interface SemanticClass {
  id: string;
  label: string;
  bucketing: BucketingProfile;
}

export interface CodingRuleMatch {
  accountNumber: string;
  departmentCode?: string | null;
  ruleText: string;
}

export interface CodingInput {
  merchant: string;
  memo?: string | null;
  mcc?: string | null;
  amount: number;
  /** Department of the cardholder or the vendor default. */
  defaultDepartmentCode?: string | null;
  vendorCategory?: string | null;
}

export interface CodingContext {
  accounts: CodingAccount[];
  classes: SemanticClass[];
  /** normalized merchant key -> account number -> count */
  history: Map<string, Map<string, number>>;
  rules: (input: CodingInput) => CodingRuleMatch | null;
  capitalizationThresholdMinor: number;
}

export interface CodingSuggestion {
  accountNumber: string;
  accountName: string;
  departmentCode: string | null;
  confidence: number;
  why: string;
  signals: string[];
  alternatives: Array<{ accountNumber: string; accountName: string; score: number }>;
}

export function merchantKey(merchant: string): string {
  return normalizeText(merchant)
    .replace(/\b(inc|llc|ltd|corp|co|com|the|www|limited|plc|gmbh)\b/g, '')
    .replace(/\d{3,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');
}

function semanticScore(profile: BucketingProfile, text: string, input: CodingInput): { score: number; reasons: string[] } {
  const t = ` ${normalizeText(text)} `;
  const reasons: string[] = [];
  let score = 0;
  const hits = profile.keywords.filter((k) => t.includes(` ${normalizeText(k)} `));
  if (hits.length) {
    score += Math.min(0.75, 0.42 + 0.12 * (hits.length - 1) + (hits.some((h) => h.includes(' ')) ? 0.08 : 0));
    reasons.push(`keyword "${hits[0]}"`);
  }
  if (input.mcc && profile.mcc?.includes(input.mcc)) {
    score += 0.35;
    reasons.push(`MCC ${input.mcc}`);
  }
  if (input.vendorCategory && profile.vendorCategories?.includes(input.vendorCategory)) {
    score += 0.4;
    reasons.push(`vendor category ${input.vendorCategory}`);
  }
  if (profile.negativeKeywords?.some((k) => t.includes(` ${normalizeText(k)} `))) score -= 0.5;
  return { score: Math.max(0, Math.min(1, score)), reasons };
}

export function suggestCoding(input: CodingInput, ctx: CodingContext): CodingSuggestion | null {
  const text = `${input.merchant} ${input.memo ?? ''}`;
  const signals: string[] = [];

  const rule = ctx.rules(input);
  if (rule) {
    const acct = ctx.accounts.find((a) => a.number === rule.accountNumber);
    if (acct) {
      return {
        accountNumber: acct.number,
        accountName: acct.name,
        departmentCode: rule.departmentCode ?? input.defaultDepartmentCode ?? null,
        confidence: 0.98,
        why: `Policy rule: "${rule.ruleText}".`,
        signals: ['policy rule'],
        alternatives: [],
      };
    }
  }

  const key = merchantKey(input.merchant);
  const hist = ctx.history.get(key);
  const histTotal = hist ? Array.from(hist.values()).reduce((s, n) => s + n, 0) : 0;
  const histWeight = histTotal / (histTotal + 2);

  const scores = ctx.accounts.map((a) => {
    const cls = ctx.classes.find((c) => c.id === a.subtype);
    const sem = cls ? semanticScore(cls.bucketing, text, input) : { score: 0, reasons: [] };
    let semantic = sem.score;
    if (cls?.bucketing.capitalizable && Math.abs(input.amount) < ctx.capitalizationThresholdMinor) semantic *= 0.35;
    const histCount = hist?.get(a.number) ?? 0;
    const historical = histTotal ? histCount / histTotal : 0;
    const score = histWeight * historical + (1 - histWeight) * semantic + (histCount > 0 && semantic > 0 ? 0.05 : 0);
    return { a, score: Math.min(1, score), semantic, sem, histCount, cls };
  });
  scores.sort((x, y) => y.score - x.score || x.a.number.localeCompare(y.a.number));
  // Capitalization policy (ASC 360) outranks history: equipment above the threshold is an asset no matter how
  // cheaper purchases from the same merchant were coded.
  if (Math.abs(input.amount) >= ctx.capitalizationThresholdMinor) {
    const cap = scores.filter((x) => x.cls?.bucketing.capitalizable && x.semantic >= 0.6).sort((x, y) => y.semantic - x.semantic)[0];
    if (cap && cap !== scores[0]) {
      const threshold = (ctx.capitalizationThresholdMinor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
      return {
        accountNumber: cap.a.number,
        accountName: cap.a.name,
        departmentCode: input.defaultDepartmentCode ?? null,
        confidence: Number(Math.min(0.95, 0.6 + cap.semantic * 0.35).toFixed(3)),
        why: `Coded to ${cap.a.number} ${cap.a.name} because the purchase is above the ${threshold} capitalization threshold and ontology class ${cap.cls?.label} matches (${cap.sem.reasons.join(', ')}); the capitalization policy overrides how smaller purchases from this merchant were coded.`,
        signals: [`capitalization policy: above ${threshold}`, `ontology: ${cap.cls?.label} via ${cap.sem.reasons.join(', ')}`],
        alternatives: scores.slice(0, 3).filter((s) => s !== cap).map((s) => ({ accountNumber: s.a.number, accountName: s.a.name, score: Number(s.score.toFixed(3)) })),
      };
    }
  }
  const best = scores[0];
  if (!best || best.score <= 0.05) return null;
  const second = scores[1]?.score ?? 0;
  const margin = best.score - second;
  const confidence = Number(Math.max(0.3, Math.min(0.97, best.score * 0.75 + margin * 0.5 + (histTotal >= 5 && best.histCount / histTotal >= 0.9 ? 0.15 : 0))).toFixed(3));

  if (best.histCount) signals.push(`history: ${best.histCount} of ${histTotal} prior "${input.merchant}" transactions coded to ${best.a.number}`);
  if (best.sem.reasons.length) signals.push(`ontology: ${best.cls?.label} via ${best.sem.reasons.join(', ')}`);
  if (best.cls?.bucketing.capitalizable) signals.push(`capitalizable above ${(ctx.capitalizationThresholdMinor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`);
  const why = signals.length
    ? `Coded to ${best.a.number} ${best.a.name} because ${signals.join('; ')}.`
    : `Best available match is ${best.a.number} ${best.a.name}, but signals are weak.`;
  return {
    accountNumber: best.a.number,
    accountName: best.a.name,
    departmentCode: input.defaultDepartmentCode ?? null,
    confidence,
    why,
    signals,
    alternatives: scores.slice(1, 4).filter((s) => s.score > 0.05).map((s) => ({ accountNumber: s.a.number, accountName: s.a.name, score: Number(s.score.toFixed(3)) })),
  };
}

/** Build the merchant history map from already-coded transactions (human corrections count double). */
export function buildHistory(rows: Array<{ merchant: string; accountNumber: string; source: string | null }>): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = merchantKey(r.merchant);
    const inner = map.get(key) ?? new Map<string, number>();
    inner.set(r.accountNumber, (inner.get(r.accountNumber) ?? 0) + (r.source === 'human' ? 2 : 1));
    map.set(key, inner);
  }
  return map;
}

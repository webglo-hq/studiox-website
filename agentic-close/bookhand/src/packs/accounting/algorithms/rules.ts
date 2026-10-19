import { parseDecimalToMinor } from '../../../shared/money';
import { normalizeText } from './text';

/**
 * Plain-English policy rules, compiled deterministically (offline). Accountants type rules like
 *   "Always code Figma to 6420"
 *   "Never auto-post anything over $5,000"
 *   "Code Uber to 6200 for Sales"
 * and the compiler turns them into structured rules the skills enforce. Sentences it cannot parse are kept
 * as `unparsed` with a hint, and a policy containing one cannot be saved: every rule that is in force is
 * one the deterministic compiler understood, in both offline and live modes.
 */

export type CompiledRule =
  | { kind: 'merchant_account'; match: string; accountNumber: string; departmentCode: string | null; text: string }
  | { kind: 'max_auto_amount'; amountMinor: number; text: string }
  | { kind: 'auto_post_under'; amountMinor: number; text: string }
  | { kind: 'min_confidence'; value: number; text: string }
  | { kind: 'require_review'; match: string; text: string }
  | { kind: 'capitalize_over'; amountMinor: number; text: string }
  | { kind: 'tolerance'; amountMinor: number; text: string }
  | { kind: 'flux_threshold'; pct: number | null; amountMinor: number | null; text: string }
  | { kind: 'sample_rate'; value: number; text: string }
  | { kind: 'exclude'; match: string; text: string }
  | { kind: 'unparsed'; text: string; hint: string };

const AMOUNT = String.raw`\$?\s?([\d,]+(?:\.\d{1,2})?)\s?(k|m)?`;

function amountMinor(num: string, suffix?: string): number {
  const base = parseDecimalToMinor(num) ?? 0;
  if (suffix?.toLowerCase() === 'k') return base * 1000;
  if (suffix?.toLowerCase() === 'm') return base * 1_000_000;
  return base;
}

function clean(s: string): string {
  return s.trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+(transactions?|charges?|purchases?|payments?|spend)$/i, '').trim();
}

export function compileRule(text: string): CompiledRule {
  const t = text.trim().replace(/\.$/, '');
  // Bounded input keeps every pattern below linear-time territory (rules are short sentences anyway).
  if (t.length > 300) return { kind: 'unparsed', text: text.slice(0, 300), hint: 'Keep each rule under 300 characters.' };
  let m: RegExpMatchArray | null;

  if ((m = t.match(/^(?:always\s+)?(?:code|map|book|post|categorize)\s+(.+?)\s+(?:to|as|under|into)\s+(?:account\s+)?(\d{4})((?:\s+(?!for\b|in\b|with\b)[a-z&]+)*)(?:\s+(?:for|in|with)\s+(?:the\s+)?([a-z&\- ]+?)(?:\s+department)?)?$/i))) {
    return { kind: 'merchant_account', match: clean(m[1]!), accountNumber: m[2]!, departmentCode: m[4] ? m[4].trim() : null, text };
  }
  if ((m = t.match(new RegExp(String.raw`^never\s+auto[- ]?(?:post|apply|approve)\s+(?:anything|entries|items|transactions|proposals)?\s*(?:over|above|greater than|more than)\s+${AMOUNT}$`, 'i')))) {
    return { kind: 'max_auto_amount', amountMinor: amountMinor(m[1]!, m[2]), text };
  }
  if ((m = t.match(new RegExp(String.raw`^auto[- ]?(?:post|apply|approve)\s+(?:anything|entries|items|transactions|matches|proposals)?\s*(?:under|below|less than|up to)\s+${AMOUNT}$`, 'i')))) {
    return { kind: 'auto_post_under', amountMinor: amountMinor(m[1]!, m[2]), text };
  }
  if ((m = t.match(/^(?:only auto[- ]?post|require)\s+(?:when\s+)?confidence\s+(?:is\s+)?(?:at least|above|over|>=?)\s+(\d{1,3})\s?%?$/i))) {
    const n = Number(m[1]);
    return { kind: 'min_confidence', value: n > 1 ? n / 100 : n, text };
  }
  if ((m = t.match(/^(?:always\s+)?(?:require|need)\s+(?:human\s+)?(?:approval|review)\s+(?:for|of|on)\s+(.+)$/i))) {
    return { kind: 'require_review', match: clean(m[1]!), text };
  }
  if ((m = t.match(new RegExp(String.raw`^capitali[sz]e\s+(?:purchases|anything|items|equipment|hardware)?\s*(?:over|above|of more than)\s+${AMOUNT}$`, 'i')))) {
    return { kind: 'capitalize_over', amountMinor: amountMinor(m[1]!, m[2]), text };
  }
  if ((m = t.match(new RegExp(String.raw`^(?:ignore|tolerate|clear)\s+(?:differences|bank fees|fees|items|amounts)?\s*(?:under|below|less than|up to)\s+${AMOUNT}$`, 'i')))) {
    return { kind: 'tolerance', amountMinor: amountMinor(m[1]!, m[2]), text };
  }
  if ((m = t.match(new RegExp(String.raw`^explain\s+(?:variances|changes|movements|flux)\s+(?:over|above)\s+(?:(\d{1,3})\s?%)?\s*(?:and|or)?\s*(?:${AMOUNT})?$`, 'i')))) {
    const pct = m[1] ? Number(m[1]) / 100 : null;
    const amt = m[2] ? amountMinor(m[2], m[3]) : null;
    if (pct !== null || amt !== null) return { kind: 'flux_threshold', pct, amountMinor: amt, text };
  }
  if ((m = t.match(/^(?:sample|review)\s+(\d{1,3})\s?%\s+(?:of\s+)?(?:auto[- ]?posted|automatic)?.*$/i))) {
    return { kind: 'sample_rate', value: Number(m[1]) / 100, text };
  }
  if ((m = t.match(/^(?:skip|exclude|ignore)\s+(?:transactions\s+from\s+|anything\s+from\s+)?(.+)$/i))) {
    return { kind: 'exclude', match: clean(m[1]!), text };
  }
  return {
    kind: 'unparsed',
    text,
    hint: 'Rephrase as e.g. "Always code Figma to 6420", "Never auto-post anything over $5,000", "Require approval for Copperline Legal", "Explain variances over 10% and $25,000".',
  };
}

export function compileRules(lines: string[]): CompiledRule[] {
  return lines.map((l) => l.trim()).filter(Boolean).map(compileRule);
}

/** Does a free-text pattern from a rule match this merchant/description? */
export function ruleMatches(pattern: string, text: string): boolean {
  const p = normalizeText(pattern);
  const t = ` ${normalizeText(text)} `;
  return p.length > 0 && t.includes(` ${p} `);
}

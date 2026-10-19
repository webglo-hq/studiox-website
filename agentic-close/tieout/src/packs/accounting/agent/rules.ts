/**
 * Plain-English policy rules → a small controlled language compiled deterministically (no model in
 * the loop), so what the Controller types is exactly what the runtime enforces. Each rule is shown
 * back as an interpretation before it takes effect; anything not understood is stored as
 * `unrecognized` and has no effect.
 *
 * Grammar (case-insensitive, optional trailing period):
 *   code <merchant> to <account> [for <department>]
 *   never auto-post [anything] [from|at|to] <merchant | account>
 *   never auto-post [anything] over <amount>
 *   send [anything] over <amount> to <role>
 *   capitalize [purchases] over <amount>
 */
import type { JsonValue } from '../../../core/util/json';

export interface RuleContext {
  accounts: { code: string; name: string; postable: boolean }[];
  departments: { code: string; name: string }[];
}

export interface CompiledRule {
  status: 'active' | 'unrecognized';
  compiled: Record<string, JsonValue> | null;
  interpretation: string;
  thresholdChanges: Record<string, number>;
}

export const RULE_EXAMPLES = [
  'Code Skylark Air to 6400 Travel for Sales',
  'Never auto-post anything from Orbitron Ads',
  'Never auto-post entries to 6500 Legal fees',
  'Never auto-post anything over $2,000',
  'Send anything over $50,000 to the CFO',
  'Capitalize purchases over $2,500',
];

const ROLE_ALIASES: Record<string, string> = { controller: 'controller', cfo: 'cfo', 'senior accountant': 'senior_accountant', senior: 'senior_accountant' };

function amount(raw: string): number | null {
  const m = /^\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(k|m)?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = m[2]?.toLowerCase() === 'k' ? 1_000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
  return Math.round(n * mult * 100);
}

function account(raw: string, ctx: RuleContext): { code: string; name: string } | null {
  const s = raw.trim().replace(/^account\s+/i, '');
  const code = /^(\d{4})\b/.exec(s)?.[1];
  if (code) return ctx.accounts.find((a) => a.code === code && a.postable) ?? null;
  const lower = s.toLowerCase();
  return ctx.accounts.find((a) => a.postable && a.name.toLowerCase() === lower) ?? ctx.accounts.find((a) => a.postable && a.name.toLowerCase().includes(lower) && lower.length >= 4) ?? null;
}

function department(raw: string, ctx: RuleContext): string | null {
  const s = raw.trim().toLowerCase();
  return ctx.departments.find((d) => d.code.toLowerCase() === s || d.name.toLowerCase() === s || d.name.toLowerCase().startsWith(s))?.code ?? null;
}

const usd = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export function compileRule(text: string, ctx: RuleContext): CompiledRule {
  const t = text.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
  const none = (why: string): CompiledRule => ({ status: 'unrecognized', compiled: null, interpretation: `${why} Try, for example: “${RULE_EXAMPLES.slice(0, 3).join('”, “')}”.`, thresholdChanges: {} });
  if (t.length < 6 || t.length > 200) return none('Rules must be between 6 and 200 characters.');

  let m = /^(?:code|categori[sz]e|book)\s+(?:all\s+|any\s+)?(?:charges?\s+(?:from|at)\s+)?(.+?)\s+(?:to|as|under)\s+(.+?)(?:\s+for\s+(?:the\s+)?(.+?)(?:\s+department)?)?$/i.exec(t);
  if (m) {
    const a = account(m[2]!, ctx);
    if (!a) return none(`“${m[2]}” is not an active account code or name.`);
    const dept = m[3] ? department(m[3], ctx) : null;
    if (m[3] && !dept) return none(`“${m[3]}” is not a department.`);
    const merchant = m[1]!.trim();
    return { status: 'active', compiled: { type: 'code', merchantContains: merchant, account: a.code, ...(dept ? { department: dept } : {}) }, interpretation: `Card charges whose merchant contains “${merchant}” are coded to ${a.code} ${a.name}${dept ? `, department ${dept}` : ''}. This overrides coding history (precedence: mapping > rule > history).`, thresholdChanges: {} };
  }

  m = /^never\s+auto[- ]?post\s+(?:anything|entries|items|charges)?\s*(?:over|above)\s+(.+)$/i.exec(t);
  if (m) {
    const amt = amount(m[1]!);
    if (amt === null) return none(`“${m[1]}” is not an amount.`);
    return { status: 'active', compiled: { type: 'auto_ceiling', amountMinor: amt }, interpretation: `Nothing above ${usd(amt)} is applied automatically by this skill; larger items always wait for a person. (Sets the auto-post ceiling to ${usd(amt)}.)`, thresholdChanges: { autoPostMaxMinor: amt } };
  }

  m = /^never\s+auto[- ]?post\s+(?:anything|entries|items|charges)?\s*(?:from|at|to|for)?\s*(.+)$/i.exec(t);
  if (m) {
    const target = m[1]!.trim();
    const a = /^\d{4}\b/.test(target) || /^account\s/i.test(target) ? account(target, ctx) : null;
    if (a) return { status: 'active', compiled: { type: 'never_auto', match: { accountCode: a.code } }, interpretation: `Proposals that post to ${a.code} ${a.name} always wait for a person, whatever the autonomy level.`, thresholdChanges: {} };
    return { status: 'active', compiled: { type: 'never_auto', match: { merchantContains: target } }, interpretation: `Card charges whose merchant contains “${target}” always wait for a person, whatever the autonomy level.`, thresholdChanges: {} };
  }

  m = /^(?:send|escalate|route)\s+(?:anything|entries|items|proposals)?\s*(?:over|above)\s+(.+?)\s+to\s+(?:the\s+)?(controller|cfo|senior accountant|senior)$/i.exec(t);
  if (m) {
    const amt = amount(m[1]!);
    if (amt === null) return none(`“${m[1]}” is not an amount.`);
    const role = ROLE_ALIASES[m[2]!.toLowerCase()]!;
    return { status: 'active', compiled: { type: 'escalate', minAmountMinor: amt, role }, interpretation: `Items of ${usd(amt)} or more are assigned to the ${role.replace('_', ' ')} for approval (approval limits still apply).`, thresholdChanges: {} };
  }

  m = /^capitali[sz]e\s+(?:anything|purchases|items|equipment)?\s*(?:over|above|at or above|from)\s+(.+)$/i.exec(t);
  if (m) {
    const amt = amount(m[1]!);
    if (amt === null) return none(`“${m[1]}” is not an amount.`);
    return { status: 'active', compiled: { type: 'cap_threshold', amountMinor: amt }, interpretation: `Equipment purchases of ${usd(amt)} or more are capitalized and depreciated instead of expensed (AX-SCH-03). (Sets the capitalization threshold to ${usd(amt)}.)`, thresholdChanges: { capitalizationMinor: amt } };
  }

  return none('Not understood.');
}

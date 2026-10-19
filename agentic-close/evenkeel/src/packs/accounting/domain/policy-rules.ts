import { formatMoney } from '../../../framework/util/money';
import { jaroWinkler, normalize } from '../../../framework/util/text';

/**
 * Plain-English policy rules → executable conditions. Accountants write rules like
 *   When merchant contains "Quillsoft" code to 6200 Software Subscriptions, department Engineering
 *   Never auto-post anything over $5,000
 *   Treat memo containing "annual" as prepaid over 12 months
 *   Auto-post only when amount is under $2,500
 * The compiler restates each rule in canonical form so the author can confirm the meaning,
 * and returns precise, friendly errors (with suggestions) instead of guessing.
 */

export type RuleField = 'merchant' | 'memo' | 'mcc' | 'cardholder';
export type Condition =
  | { field: RuleField; op: 'contains' | 'is' | 'starts_with'; value: string }
  | { field: 'amount'; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number }
  | { field: 'any' };

interface RuleBase {
  id: string;
  line: number;
  source: string;
  explanation: string;
}

export type CompiledRule =
  | (RuleBase & { kind: 'map'; when: Condition[]; accountId: string; accountCode: string; departmentId: string | null; departmentName: string | null })
  | (RuleBase & { kind: 'block_auto'; when: Condition[] })
  | (RuleBase & { kind: 'flag'; when: Condition[] })
  | (RuleBase & { kind: 'treatment'; when: Condition[]; treatment: 'prepaid' | 'capitalize'; months: number | null })
  | (RuleBase & { kind: 'threshold'; key: 'autoPostBelow' | 'minConfidence'; value: number });

export interface RuleError {
  line: number;
  text: string;
  message: string;
  suggestion?: string;
}

export interface RuleRefs {
  accounts: { id: string; code: string; name: string; isPostable: boolean }[];
  departments: { id: string; code: string; name: string }[];
}

export interface CompileResult {
  rules: CompiledRule[];
  errors: RuleError[];
}

const FIELD_SYNONYMS: Record<string, RuleField> = {
  merchant: 'merchant',
  vendor: 'merchant',
  supplier: 'merchant',
  payee: 'merchant',
  memo: 'memo',
  description: 'memo',
  note: 'memo',
  mcc: 'mcc',
  'merchant category': 'mcc',
  'merchant category code': 'mcc',
  cardholder: 'cardholder',
  employee: 'cardholder',
  spender: 'cardholder',
};

const FIELD_RE = '(merchant category code|merchant category|merchant|vendor|supplier|payee|memo|description|note|mcc|cardholder|employee|spender)';

export function parseAmount(s: string): number | null {
  const m = /^\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m)?$/i.exec(s.trim());
  if (!m) return null;
  let v = Number(m[1]!.replace(/,/g, ''));
  if (m[2]?.toLowerCase() === 'k') v *= 1_000;
  if (m[2]?.toLowerCase() === 'm') v *= 1_000_000;
  return Math.round(v * 100);
}

function normQuotes(s: string): string {
  return s.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'");
}

function parseConditions(text: string): { conds: Condition[]; error?: string } {
  const t = text.trim().replace(/^(when|if)\s+/i, '').replace(/^(the|a|an)\s+/i, '');
  if (/^(anything|everything|any transaction|all transactions|all|any)\b/i.test(t)) {
    const rest = t.replace(/^(anything|everything|any transaction|all transactions|all|any)\s*/i, '');
    if (!rest) return { conds: [{ field: 'any' }] };
    const sub = parseConditions(rest.replace(/^(that is|that's|which is)\s+/i, 'amount '));
    return sub;
  }
  const parts = t.split(/\s+and\s+/i);
  const conds: Condition[] = [];
  for (const raw of parts) {
    const p = raw.trim().replace(/^(the|its)\s+/i, '');
    let m = new RegExp(`^${FIELD_RE}\\s+(contains|containing|includes|including|mentions|is|equals|=|starts with|starting with|begins with)\\s+"([^"]+)"$`, 'i').exec(p);
    if (!m) m = new RegExp(`^${FIELD_RE}\\s+(contains|containing|includes|including|mentions|is|equals|=|starts with|starting with|begins with)\\s+'([^']+)'$`, 'i').exec(p);
    if (m) {
      const field = FIELD_SYNONYMS[m[1]!.toLowerCase()]!;
      const opWord = m[2]!.toLowerCase();
      const op = /start|begin/.test(opWord) ? 'starts_with' : /^(is|equals|=)$/.test(opWord) ? 'is' : 'contains';
      conds.push({ field, op, value: m[3]!.trim() });
      continue;
    }
    const mcc = /^(?:mcc|merchant category(?: code)?)\s+(?:is\s+)?(\d{4})$/i.exec(p);
    if (mcc) {
      conds.push({ field: 'mcc', op: 'is', value: mcc[1]! });
      continue;
    }
    const amt = /^(?:amount\s+)?(?:is\s+)?(over|above|more than|greater than|at least|under|below|less than|at most)\s+(\$?[\d,]+(?:\.\d+)?\s*[km]?)$/i.exec(p);
    if (amt) {
      const v = parseAmount(amt[2]!);
      if (v === null) return { conds, error: `I couldn't read the amount "${amt[2]}".` };
      const w = amt[1]!.toLowerCase();
      const op = w === 'at least' ? 'gte' : w === 'at most' ? 'lte' : /over|above|more|greater/.test(w) ? 'gt' : 'lt';
      conds.push({ field: 'amount', op, value: v });
      continue;
    }
    return { conds, error: `I couldn't understand the condition "${p}". Try: merchant contains "Acme", or amount over $5,000.` };
  }
  return { conds };
}

function describeConds(conds: Condition[]): string {
  return conds
    .map((c) => {
      if (c.field === 'any') return 'any transaction';
      if (c.field === 'amount') return `amount ${({ gt: 'over', gte: 'at least', lt: 'under', lte: 'at most' } as const)[c.op]} ${formatMoney(c.value)}`;
      return `${c.field} ${c.op === 'starts_with' ? 'starts with' : c.op} “${c.value}”`;
    })
    .join(' and ');
}

function resolveAccount(ref: string, refs: RuleRefs): { account?: RuleRefs['accounts'][number]; suggestion?: string } {
  const r = ref.trim().replace(/^account\s+/i, '');
  const code = /^(\d{3,5})\b/.exec(r)?.[1];
  if (code) {
    const a = refs.accounts.find((x) => x.code === code);
    return a ? { account: a } : { suggestion: undefined };
  }
  const n = normalize(r);
  const exact = refs.accounts.find((a) => normalize(a.name) === n);
  if (exact) return { account: exact };
  const contains = refs.accounts.filter((a) => normalize(a.name).includes(n) || n.includes(normalize(a.name)));
  if (contains.length === 1) return { account: contains[0] };
  const best = refs.accounts.map((a) => ({ a, s: jaroWinkler(normalize(a.name), n) })).sort((x, y) => y.s - x.s)[0];
  if (best && best.s >= 0.92) return { account: best.a };
  return { suggestion: best ? `${best.a.code} ${best.a.name}` : undefined };
}

function resolveDepartment(ref: string, refs: RuleRefs): RuleRefs['departments'][number] | undefined {
  const n = normalize(ref);
  return refs.departments.find((d) => normalize(d.name) === n || normalize(d.code) === n) ?? refs.departments.find((d) => normalize(d.name).startsWith(n));
}

export function compileRules(text: string, refs: RuleRefs): CompileResult {
  const rules: CompiledRule[] = [];
  const errors: RuleError[] = [];
  const lines = normQuotes(text).split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const src = rawLine.trim().replace(/[.;]+$/, '');
    if (!src || src.startsWith('#') || src.startsWith('//')) return;
    const id = `r${line}`;
    const err = (message: string, suggestion?: string) => errors.push({ line, text: src.slice(0, 300), message, suggestion });
    // Bounded input keeps every pattern below linear-time worst cases.
    if (src.length > 300) return err('Keep each rule under 300 characters; split long rules into several lines.');
    if (line > 200) return err('A policy can contain at most 200 rules.');

    // Thresholds
    let m = /^auto-?post\s+(?:only\s+)?(?:when|if)\s+(?:the\s+)?amount\s+is\s+(?:under|below|less than)\s+(\$?[\d,]+(?:\.\d+)?\s*[km]?)$/i.exec(src);
    if (m) {
      const v = parseAmount(m[1]!);
      if (v === null) return err(`I couldn't read the amount "${m[1]}".`);
      rules.push({ id, line, source: src, kind: 'threshold', key: 'autoPostBelow', value: v, explanation: `Auto-post only items under ${formatMoney(v)}.` });
      return;
    }
    m = /^require\s+(?:at\s+least\s+)?(\d{1,3})\s*%\s+confidence(?:\s+to\s+auto-?post)?$/i.exec(src);
    if (m) {
      const v = Number(m[1]) / 100;
      if (v <= 0 || v > 1) return err('Confidence must be between 1% and 100%.');
      rules.push({ id, line, source: src, kind: 'threshold', key: 'minConfidence', value: v, explanation: `Auto-post only when the agent is at least ${Math.round(v * 100)}% confident.` });
      return;
    }
    // Never auto-post
    m = /^never\s+auto-?post\s+(.+)$/i.exec(src);
    if (m) {
      const { conds, error } = parseConditions(m[1]!.replace(/^(transactions|items)\s+(where|with|whose)\s+/i, ''));
      if (error) return err(error);
      rules.push({ id, line, source: src, kind: 'block_auto', when: conds, explanation: `Never auto-post when ${describeConds(conds)}; always ask a person.` });
      return;
    }
    // Flag
    m = /^(?:always\s+)?flag\s+(.+?)(?:\s+for\s+review)?$/i.exec(src);
    if (m) {
      const { conds, error } = parseConditions(m[1]!);
      if (error) return err(error);
      rules.push({ id, line, source: src, kind: 'flag', when: conds, explanation: `Flag for review when ${describeConds(conds)}.` });
      return;
    }
    // Treatment
    m = /^treat\s+(.+?)\s+as\s+(?:a\s+|an\s+)?(prepaid|prepayment|capital(?:ized)?|fixed asset|capex)(?:\s+over\s+(\d+)\s+months)?$/i.exec(src);
    if (m) {
      const { conds, error } = parseConditions(m[1]!.replace(/\bcontaining\b/i, 'contains'));
      if (error) return err(error);
      const treatment = /prepa/i.test(m[2]!) ? 'prepaid' : 'capitalize';
      const months = m[3] ? Number(m[3]) : null;
      rules.push({
        id,
        line,
        source: src,
        kind: 'treatment',
        when: conds,
        treatment,
        months,
        explanation: `When ${describeConds(conds)}, record it as ${treatment === 'prepaid' ? `a prepaid${months ? ` spread over ${months} months` : ''}` : 'a fixed asset (capitalise)'}.`,
      });
      return;
    }
    // Map
    m = /^(?:when|if)?\s*(.+?)\s*,?\s*(?:then\s+)?(?:code|book|send|map|post|categori[sz]e|put)\s+(?:it\s+|them\s+)?(?:to|as|under|into|in)\s+(.+)$/i.exec(src);
    if (m) {
      const { conds, error } = parseConditions(m[1]!);
      if (error) return err(error);
      const target = m[2]!;
      const dm = /^(.+?)(?:\s*,\s*|\s+and\s+|\s+)(?:department|dept|team)\s+(.+)$/i.exec(target);
      const accountRef = dm ? dm[1]! : target;
      const res = resolveAccount(accountRef, refs);
      if (!res.account) return err(`I couldn't find the account "${accountRef.trim()}".`, res.suggestion ? `Did you mean ${res.suggestion}?` : undefined);
      if (!res.account.isPostable) return err(`${res.account.code} ${res.account.name} is a summary account; pick a postable account.`);
      let dept: RuleRefs['departments'][number] | undefined;
      if (dm) {
        dept = resolveDepartment(dm[2]!, refs);
        if (!dept) return err(`I couldn't find the department "${dm[2]!.trim()}".`, `Departments: ${refs.departments.map((d) => d.name).join(', ')}`);
      }
      rules.push({
        id,
        line,
        source: src,
        kind: 'map',
        when: conds,
        accountId: res.account.id,
        accountCode: res.account.code,
        departmentId: dept?.id ?? null,
        departmentName: dept?.name ?? null,
        explanation: `When ${describeConds(conds)}, code to ${res.account.code} ${res.account.name}${dept ? ` · ${dept.name}` : ''}.`,
      });
      return;
    }
    err('I couldn’t understand this rule. Start with “When …”, “Never auto-post …”, “Flag …”, “Treat … as prepaid” or “Auto-post only when amount is under …”.');
  });
  return { rules, errors };
}

export interface RuleFacts {
  merchant: string;
  memo: string;
  mcc: string | null;
  cardholder: string;
  amount: number;
}

export function conditionsMatch(conds: Condition[], f: RuleFacts): boolean {
  return conds.every((c) => {
    if (c.field === 'any') return true;
    if (c.field === 'amount') {
      const a = Math.abs(f.amount);
      return c.op === 'gt' ? a > c.value : c.op === 'gte' ? a >= c.value : c.op === 'lt' ? a < c.value : a <= c.value;
    }
    const v = normalize(c.field === 'merchant' ? f.merchant : c.field === 'memo' ? f.memo : c.field === 'mcc' ? (f.mcc ?? '') : f.cardholder);
    const want = normalize(c.value);
    if (c.op === 'is') return v === want;
    if (c.op === 'starts_with') return v.startsWith(want);
    return v.includes(want);
  });
}

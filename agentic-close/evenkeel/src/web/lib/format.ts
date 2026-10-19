import { formatDate, formatPeriod, formatTimestamp } from '../../framework/util/dates';
import { formatMoney, formatPct } from '../../framework/util/money';

/** Display formatting shared by every screen (money is integer minor units). */

export function money(cents: number | null | undefined, currency = 'USD', opts: { compact?: boolean; whole?: boolean; signed?: boolean; accounting?: boolean } = {}): string {
  if (cents === null || cents === undefined) return '—';
  return formatMoney(cents, currency, opts);
}

export function pct(ratio: number | null | undefined, digits = 1, signed = true): string {
  return formatPct(ratio, digits, signed);
}

export function period(key: string | null | undefined, style: 'long' | 'short' = 'long'): string {
  return key ? formatPeriod(key, style) : '—';
}

export function date(d: string | null | undefined, style: 'short' | 'medium' | 'long' = 'medium'): string {
  return d ? formatDate(d.slice(0, 10), style) : '—';
}

export function when(iso: string | null | undefined): string {
  return iso ? formatTimestamp(iso) : '—';
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function humanize(s: string | null | undefined): string {
  if (!s) return '';
  const t = s.replace(/[_.-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const ACTION_EXACT: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.mfa.verified': 'Two-step code accepted',
  'seed.loaded': 'Demo data loaded',
};

/** Audit action codes in plain words: "je.posted" → "Journal entry posted". */
const ACTION_SUBJECTS: [string, string][] = [
  ['agent.proposal.', 'Proposal'],
  ['agent.run.', 'Agent run'],
  ['je.', 'Journal entry'],
  ['rec.item.', 'Reconciling item'],
  ['rec.', 'Reconciliation'],
  ['flux.', 'Flux explanation'],
  ['package.', 'Close package'],
  ['period.', 'Period'],
  ['task.', 'Task'],
  ['issue.', 'Exception'],
  ['admin.user.', 'User'],
  ['admin.roles.', 'Roles'],
  ['admin.sod.', 'Segregation-of-duties rules'],
  ['auth.mfa.', 'Two-step sign-in'],
  ['auth.password.', 'Password'],
  ['integration.', 'File'],
  ['settings.', 'Settings'],
  ['skill.policy.', 'Skill policy'],
  ['skill.', 'Skill'],
];

export function actionLabel(action: string): string {
  if (ACTION_EXACT[action]) return ACTION_EXACT[action];
  for (const [prefix, subject] of ACTION_SUBJECTS) {
    if (action.startsWith(prefix)) return `${subject} ${action.slice(prefix.length).replace(/[_.-]+/g, ' ').trim()}`;
  }
  return humanize(action);
}

export function confidenceLabel(c: number): string {
  if (c >= 0.95) return 'Very high';
  if (c >= 0.85) return 'High';
  if (c >= 0.7) return 'Medium';
  return 'Low';
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export const ROLE_LABEL: Record<string, string> = {
  staff_accountant: 'Staff Accountant',
  ap_clerk: 'AP Specialist',
  fpa_analyst: 'FP&A Analyst',
  senior_accountant: 'Senior Accountant',
  controller: 'Controller',
  cfo: 'CFO',
  auditor: 'Auditor (read-only)',
  admin: 'Admin',
};

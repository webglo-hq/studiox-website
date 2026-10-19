/** Display formatting: accounting money, percentages, dates — all locale-stable for screenshots. */
const SYMBOL: Record<string, string> = { USD: '$', GBP: '£', EUR: '€' };

export function money(minor: number | null | undefined, currency: string | null = 'USD', opts: { signed?: boolean; compact?: boolean; decimals?: 0 | 2 } = {}): string {
  if (minor === null || minor === undefined) return '—';
  const sym = SYMBOL[currency ?? 'USD'] ?? `${currency} `;
  const abs = Math.abs(minor) / 100;
  let body: string;
  if (opts.compact && abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  else if (opts.compact && abs >= 10_000) body = `${(abs / 1000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  else body = abs.toLocaleString('en-US', { minimumFractionDigits: opts.decimals ?? 2, maximumFractionDigits: opts.decimals ?? 2 });
  if (minor < 0) return opts.signed ? `−${sym}${body}` : `(${sym}${body})`;
  return opts.signed && minor > 0 ? `+${sym}${body}` : `${sym}${body}`;
}

export function pct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(digits)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function date(iso: string | null | undefined, withYear = false): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return `${date(iso)} ${iso.slice(11, 16)} UTC`;
}

export function periodName(pk: string): string {
  const [y, m] = pk.split('-').map(Number) as [number, number];
  return `${LONG[m - 1]} ${y}`;
}

/** "Sep 2026" for tight spaces (the phone top bar). */
export function periodShort(pk: string): string {
  const [y, m] = pk.split('-').map(Number) as [number, number];
  return `${LONG[m - 1]!.slice(0, 3)} ${y}`;
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export const KIND_LABEL: Record<string, string> = {
  journal_entry: 'Journal entry',
  coding: 'Coding',
  rec_match: 'Match',
  reconciling_item: 'Reconciling item',
  flux_explanation: 'Variance explanation',
  finding: 'Finding',
  report: 'Close package',
  schedule_update: 'Schedule update',
};

export const STATUS_LABEL: Record<string, string> = {
  suggested: 'Suggestion',
  pending_approval: 'Needs approval',
  approved: 'Approved',
  auto_approved: 'Approved by policy',
  applied: 'Applied',
  rejected: 'Rejected',
  superseded: 'Superseded',
  failed: 'Failed',
};

export const ROUTE_LABEL: Record<string, string> = {
  suggestion: 'Suggestion only (L0)',
  human_approval: 'Waits for a person',
  auto_post_sampled: 'Auto-applied, sampled for review',
  auto_post: 'Auto-applied, post-hoc review',
};

export const ROLE_LABEL: Record<string, string> = {
  staff_accountant: 'Staff Accountant',
  ap_specialist: 'AP Specialist',
  senior_accountant: 'Senior Accountant',
  controller: 'Controller',
  cfo: 'CFO',
  fpa_analyst: 'FP&A Analyst',
  auditor: 'Auditor',
  admin: 'Admin',
};

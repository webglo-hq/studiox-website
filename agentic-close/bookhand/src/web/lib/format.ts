/** Display formatting for money (minor units), percentages and dates. */

export function money(minor: number | null | undefined, currency = 'USD', opts: { signed?: boolean; cents?: boolean; compact?: boolean } = {}): string {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return '—';
  const digits = opts.compact ? 1 : opts.cents === false ? 0 : 2;
  // An amount that rounds to zero at the shown precision is zero: never "-$0" or "-$0.00".
  const value = Math.abs(minor / 100) < 0.5 / 10 ** digits ? 0 : minor / 100;
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: opts.compact ? 0 : digits,
    maximumFractionDigits: digits,
    notation: opts.compact ? 'compact' : 'standard',
    signDisplay: opts.signed ? 'exceptZero' : 'auto',
  });
  return fmt.format(value);
}

export function pct(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return `${ratio > 0 ? '+' : ''}${(ratio * 100).toFixed(digits)}%`;
}

export function date(iso: string | null | undefined, style: 'short' | 'long' | 'time' = 'short'): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (style === 'time') return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(style === 'long' ? { year: 'numeric', weekday: 'short' } : {}), timeZone: 'UTC' });
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 0) return date(iso, 'time');
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return date(iso);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export const KIND_LABELS: Record<string, string> = {
  journal_entry: 'Journal entry',
  transaction_coding: 'Card coding',
  rec_match: 'Rec match',
  reconciling_item: 'Reconciling item',
  flux_explanation: 'Flux explanation',
  anomaly: 'Review finding',
  schedule: 'Schedule',
  task_update: 'Close package',
};

export const STATUS_TONE: Record<string, string> = {
  pending: 'attention',
  blocked: 'danger',
  suggested: 'info',
  approved: 'success',
  auto_applied: 'violet',
  rejected: 'danger',
  superseded: '',
  failed: 'danger',
  done: 'success',
  ready_for_review: 'info',
  in_progress: 'attention',
  not_started: '',
  completed: 'success',
  running: 'info',
  queued: 'info',
  budget_exceeded: 'danger',
  cancelled: '',
  reviewed: 'success',
  prepared: 'info',
  reopened: 'attention',
  locked: 'success',
  open: 'attention',
  draft: '',
  final: 'success',
  missing: 'attention',
  drafted: 'info',
  accepted: 'success',
  not_required: '',
  partial: 'attention',
  soft_closed: 'info',
};

export const REC_TYPE_LABELS: Record<string, string> = {
  bank: 'Bank',
  credit_card: 'Credit card',
  subledger_ap: 'AP subledger',
  subledger_ar: 'AR subledger',
  intercompany: 'Intercompany',
  prepaid: 'Prepaid',
  fixed_assets: 'Fixed assets',
  accrued_liabilities: 'Accrued liabilities',
  payroll_liabilities: 'Payroll liabilities',
  deferred_revenue: 'Deferred revenue',
  balance_sheet: 'Balance sheet',
};

export function recTypeLabel(type: string): string {
  return REC_TYPE_LABELS[type] ?? label(type);
}

export function label(s: string): string {
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

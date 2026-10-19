import { c, check, table } from '../dsl';

const AREA = 'Flux & variance';

export interface FluxDriver {
  kind: 'vendor' | 'department' | 'customer' | 'new_item' | 'one_time' | 'volume' | 'price' | 'timing' | 'fx' | 'reclass' | 'other';
  label: string;
  amount_minor: number;
  evidence?: Array<{ type: string; id: string; label: string }>;
}

export const fluxAnalyses = table(
  'flux_analyses',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    close_id: c.uuid().references('closes'),
    /** null = consolidated */
    entity_id: c.uuid().nullable().references('entities'),
    comparison: c.enum(['prior_month', 'prior_year', 'budget'] as const),
    threshold_pct: c.numeric(8, 6),
    threshold_minor: c.money(),
    status: c.enum(['draft', 'in_review', 'approved'] as const).default('draft'),
    generated_by_run_id: c.uuid().nullable().references('agent_runs'),
    prepared_by: c.uuid().nullable().references('users', 'set null'),
    approved_by: c.uuid().nullable().references('users', 'set null'),
    approved_at: c.timestamp().nullable(),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'Flux (variance) analysis for a close: current vs. comparison with materiality thresholds.',
    ontologyClass: 'bh:FluxAnalysis',
    checks: [
      check('flux_sod', 'approved_by IS NULL OR approved_by IS DISTINCT FROM prepared_by', (r) => r.approved_by == null || r.approved_by !== r.prepared_by, 'flux approval requires a different person than the preparer'),
    ],
  },
);

export const fluxLines = table(
  'flux_lines',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    analysis_id: c.uuid().references('flux_analyses', 'cascade'),
    account_id: c.uuid().references('accounts'),
    fs_line: c.text(),
    /** Presented in natural sign (normal balance positive). */
    current_minor: c.money(),
    comparison_minor: c.money(),
    variance_minor: c.money(),
    variance_pct: c.numeric(12, 6).nullable(),
    is_material: c.bool().default(false),
    drivers: c.json<FluxDriver[]>().default([]),
    explanation: c.text().nullable(),
    explanation_status: c.enum(['not_required', 'missing', 'drafted', 'accepted', 'rejected'] as const).default('not_required'),
    explained_by: c.uuid().nullable().references('users', 'set null'),
    explained_by_run_id: c.uuid().nullable().references('agent_runs'),
    confidence: c.numeric(4, 3).nullable(),
    proposal_id: c.uuid().nullable().references('proposals'),
    reviewed_by: c.uuid().nullable().references('users', 'set null'),
    reviewed_at: c.timestamp().nullable(),
  },
  {
    area: AREA,
    description: 'Variance on one account with drivers and an explanation.',
    ontologyClass: 'bh:FluxLine',
    uniques: [['analysis_id', 'account_id']],
    checks: [
      check('flux_line_math', 'variance_minor = current_minor - comparison_minor', (r) => Number(r.variance_minor) === Number(r.current_minor) - Number(r.comparison_minor), 'variance = current - comparison'),
    ],
  },
);

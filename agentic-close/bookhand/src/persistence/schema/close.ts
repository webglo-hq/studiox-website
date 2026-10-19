import { c, check, nnd, table } from '../dsl';

const AREA = 'Close management';

export const TASK_CATEGORIES = [
  'cash',
  'cards',
  'ap',
  'ar',
  'accruals',
  'prepaids',
  'fixed_assets',
  'payroll',
  'intercompany',
  'fx',
  'review',
  'reporting',
  'lock',
] as const;

export const closes = table(
  'closes',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    fiscal_year: c.int(),
    period_number: c.int(),
    name: c.text(),
    period_end: c.date(),
    target_workday: c.int().default(5),
    status: c.enum(['planned', 'in_progress', 'in_review', 'closed'] as const).default('planned'),
    started_at: c.timestamp().nullable(),
    closed_at: c.timestamp().nullable(),
    closed_by: c.uuid().nullable().references('users', 'set null'),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'A month-end close across all entities for one fiscal period.',
    ontologyClass: 'bh:Close',
    uniques: [['tenant_id', 'fiscal_year', 'period_number']],
  },
);

export const checklistTemplates = table(
  'checklist_templates',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    name: c.text(),
    version: c.int().default(1),
    status: c.enum(['active', 'retired'] as const).default('active'),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'Versioned close checklist template.', ontologyClass: 'bh:CloseChecklist', uniques: [['tenant_id', 'name', 'version']] },
);

export const checklistTemplateTasks = table(
  'checklist_template_tasks',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    template_id: c.uuid().references('checklist_templates', 'cascade'),
    key: c.text(),
    title: c.text(),
    description: c.text(),
    category: c.enum(TASK_CATEGORIES),
    /** Due workday relative to period end (WD-2 .. WD+10; no WD0). */
    workday: c.int().check('<> 0', (v) => v !== 0),
    scope: c.enum(['each_entity', 'parent', 'consolidated'] as const),
    owner_role: c.text(),
    reviewer_role: c.text().nullable(),
    skill_key: c.text().nullable(),
    depends_on: c.json<string[]>().default([]),
    evidence_required: c.bool().default(false),
    sort_order: c.int().default(0),
  },
  { area: AREA, description: 'Task definition in a checklist template.', uniques: [['template_id', 'key']] },
);

export const closeTasks = table(
  'close_tasks',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    close_id: c.uuid().references('closes', 'cascade'),
    key: c.text(),
    entity_id: c.uuid().nullable().references('entities'),
    title: c.text(),
    description: c.text(),
    category: c.enum(TASK_CATEGORIES),
    due_workday: c.int(),
    due_date: c.date(),
    owner_id: c.uuid().nullable().references('users', 'set null'),
    reviewer_id: c.uuid().nullable().references('users', 'set null'),
    status: c.enum(['not_started', 'in_progress', 'blocked', 'ready_for_review', 'done', 'skipped'] as const).default('not_started'),
    skill_key: c.text().nullable(),
    last_run_id: c.uuid().nullable().references('agent_runs'),
    blocked_reason: c.text().nullable(),
    started_at: c.timestamp().nullable(),
    completed_at: c.timestamp().nullable(),
    completed_by: c.uuid().nullable().references('users', 'set null'),
    completed_by_run_id: c.uuid().nullable().references('agent_runs'),
    reviewed_at: c.timestamp().nullable(),
    reviewed_by: c.uuid().nullable().references('users', 'set null'),
    evidence_required: c.bool().default(false),
    sort_order: c.int().default(0),
  },
  {
    area: AREA,
    description: 'A task in a specific close, assigned to an owner and reviewer, due on a workday.',
    ontologyClass: 'bh:CloseTask',
    uniques: [nnd('close_id', 'key', 'entity_id')],
    indexes: [['close_id', 'status'], ['owner_id']],
    checks: [
      check(
        'task_review_sod',
        'reviewed_by IS NULL OR reviewed_by IS DISTINCT FROM completed_by',
        (r) => r.reviewed_by == null || r.reviewed_by !== r.completed_by,
        'the reviewer of a close task must be a different person than the one who completed it',
      ),
    ],
  },
);

export const closeTaskDependencies = table(
  'close_task_dependencies',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    task_id: c.uuid().references('close_tasks', 'cascade'),
    depends_on_task_id: c.uuid().references('close_tasks', 'cascade'),
  },
  {
    area: AREA,
    description: 'Directed dependency between close tasks (must be acyclic).',
    uniques: [['task_id', 'depends_on_task_id']],
    checks: [check('dep_not_self', 'task_id <> depends_on_task_id', (r) => r.task_id !== r.depends_on_task_id, 'a task cannot depend on itself')],
  },
);

export const signoffs = table(
  'signoffs',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    object_type: c.enum(['close_task', 'reconciliation', 'flux_analysis', 'flux_line', 'close_package', 'period'] as const),
    object_id: c.uuid(),
    role: c.enum(['preparer', 'reviewer', 'approver'] as const),
    action: c.enum(['sign', 'revoke'] as const).default('sign'),
    user_id: c.uuid().references('users'),
    signed_at: c.timestamp().defaultNow(),
    comment: c.text().nullable(),
    evidence_hash: c.text().nullable(),
  },
  {
    area: AREA,
    description: 'Append-only sign-off ledger (preparer/reviewer/approver) for any closeable object.',
    ontologyClass: 'bh:SignOff',
    appendOnly: true,
    indexes: [['object_type', 'object_id']],
  },
);

export const closePackages = table(
  'close_packages',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    close_id: c.uuid().references('closes'),
    version: c.int(),
    status: c.enum(['draft', 'final'] as const).default('draft'),
    generated_at: c.timestamp().defaultNow(),
    generated_by: c.uuid().nullable().references('users', 'set null'),
    generated_by_run_id: c.uuid().nullable().references('agent_runs'),
    content: c.json<Record<string, unknown>>(),
    content_hash: c.text(),
    source_document_id: c.uuid().nullable().references('source_documents'),
    approved_by: c.uuid().nullable().references('users', 'set null'),
    approved_at: c.timestamp().nullable(),
  },
  {
    area: AREA,
    description: 'Generated close package (TB, statements, commentary, rec and exception status).',
    ontologyClass: 'bh:ClosePackage',
    uniques: [['close_id', 'version']],
    checks: [
      check('pkg_sod', 'approved_by IS NULL OR approved_by IS DISTINCT FROM generated_by', (r) => r.approved_by == null || r.approved_by !== r.generated_by, 'the approver of a close package must differ from the person who generated it'),
    ],
  },
);

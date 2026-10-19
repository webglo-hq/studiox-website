/**
 * RBAC model: permission codes, system roles (with approval limits) and default segregation-of-duties rules.
 * Admins administer the system but hold no financial approval rights (IT/finance SoD).
 */

export const PERMISSIONS = {
  'close.view': 'See the close calendar, tasks and progress',
  'close.task.work': 'Start and complete close tasks you own',
  'close.task.review': 'Review (sign off) close tasks completed by others',
  'close.manage': 'Create closes, assign owners and reviewers',
  'je.view': 'See journal entries and the ledger',
  'je.prepare': 'Prepare manual journal entries',
  'je.approve': 'Approve journal entries prepared by others',
  'je.reverse': 'Reverse posted journal entries',
  'proposal.view': 'See agent proposals',
  'proposal.decide': 'Approve or reject agent proposals within your approval limit',
  'proposal.review_posthoc': 'Post-hoc review of auto-applied agent work',
  'rec.view': 'See reconciliations',
  'rec.prepare': 'Prepare (certify as preparer) reconciliations',
  'rec.review': 'Review (certify as reviewer) reconciliations',
  'flux.view': 'See flux analyses',
  'flux.explain': 'Write or accept variance explanations',
  'flux.approve': 'Approve a flux review',
  'reports.view': 'See trial balance and financial statements',
  'package.generate': 'Generate the close package',
  'package.approve': 'Approve the close package',
  'period.soft_close': 'Soft-close a period',
  'period.lock': 'Lock (hard-close) a period',
  'period.reopen': 'Reopen a locked period',
  'skill.view': 'See the skill catalog',
  'skill.run': 'Run agent skills',
  'policy.edit': 'Edit skill policies (thresholds, rules)',
  'autonomy.set': 'Change a skill\'s autonomy level',
  'ontology.view': 'Browse the ontology',
  'audit.view': 'Read the audit log',
  'audit.verify': 'Verify the audit hash chain',
  'import.run': 'Import source files',
  'connector.manage': 'Configure connectors',
  'materiality.set': 'Set materiality thresholds',
  'admin.users': 'Manage users',
  'admin.roles': 'Assign roles',
  'admin.sod': 'Edit segregation-of-duties rules',
  'admin.sessions': 'See and revoke sessions',
} as const;

export type Permission = keyof typeof PERMISSIONS;

const VIEW: Permission[] = ['close.view', 'je.view', 'proposal.view', 'rec.view', 'flux.view', 'reports.view', 'skill.view', 'ontology.view'];

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  /** Max approvable amount in reporting-currency minor units; null = unlimited. */
  approvalLimitMinor: number | null;
  readOnly?: boolean;
}

export const ROLES: RoleDefinition[] = [
  {
    key: 'staff_accountant',
    name: 'Staff Accountant',
    description: 'Runs agents, works close tasks, prepares reconciliations; approves low-risk items up to $5,000.',
    permissions: [...VIEW, 'close.task.work', 'je.prepare', 'proposal.decide', 'rec.prepare', 'flux.explain', 'skill.run', 'import.run'],
    approvalLimitMinor: 500_000,
  },
  {
    key: 'ap_clerk',
    name: 'AP Clerk',
    description: 'Captures bills and codes spend; approves coding up to $2,500.',
    permissions: [...VIEW, 'close.task.work', 'je.prepare', 'proposal.decide', 'skill.run', 'import.run'],
    approvalLimitMinor: 250_000,
  },
  {
    key: 'fpa_analyst',
    name: 'FP&A Analyst',
    description: 'Explains variances and owns budget-vs-actual commentary.',
    permissions: [...VIEW, 'close.task.work', 'flux.explain', 'proposal.decide', 'skill.run'],
    approvalLimitMinor: 0,
  },
  {
    key: 'senior_accountant',
    name: 'Senior Accountant',
    description: 'Reviews and approves entries and reconciliations up to $50,000; generates the close package.',
    permissions: [...VIEW, 'close.task.work', 'close.task.review', 'je.prepare', 'je.approve', 'je.reverse', 'proposal.decide', 'proposal.review_posthoc', 'rec.prepare', 'rec.review', 'flux.explain', 'package.generate', 'skill.run', 'import.run'],
    approvalLimitMinor: 5_000_000,
  },
  {
    key: 'controller',
    name: 'Controller',
    description: 'Owns the close: approves up to $500,000, sets agent autonomy and policies, approves flux, locks periods.',
    permissions: [
      ...VIEW,
      'close.task.work',
      'close.task.review',
      'close.manage',
      'je.prepare',
      'je.approve',
      'je.reverse',
      'proposal.decide',
      'proposal.review_posthoc',
      'rec.prepare',
      'rec.review',
      'flux.explain',
      'flux.approve',
      'package.generate',
      'package.approve',
      'period.soft_close',
      'period.lock',
      'skill.run',
      'policy.edit',
      'autonomy.set',
      'audit.view',
      'audit.verify',
      'import.run',
      'connector.manage',
    ],
    approvalLimitMinor: 50_000_000,
  },
  {
    key: 'cfo',
    name: 'CFO',
    description: 'Unlimited approval, materiality, period reopen.',
    permissions: [
      ...VIEW,
      'close.task.review',
      'close.manage',
      'je.approve',
      'je.reverse',
      'proposal.decide',
      'proposal.review_posthoc',
      'rec.review',
      'flux.approve',
      'package.approve',
      'period.soft_close',
      'period.lock',
      'period.reopen',
      'policy.edit',
      'autonomy.set',
      'audit.view',
      'audit.verify',
      'materiality.set',
    ],
    approvalLimitMinor: null,
  },
  {
    key: 'auditor',
    name: 'Auditor (read-only)',
    description: 'Read-only access to everything including the audit log and its verification.',
    permissions: [...VIEW, 'audit.view', 'audit.verify'],
    approvalLimitMinor: 0,
    readOnly: true,
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Manages users, roles, SoD rules, sessions and connectors. No financial approvals.',
    permissions: ['close.view', 'skill.view', 'ontology.view', 'audit.view', 'admin.users', 'admin.roles', 'admin.sod', 'admin.sessions', 'connector.manage'],
    approvalLimitMinor: 0,
  },
];

export interface SodRuleDefinition {
  code: string;
  name: string;
  description: string;
  kind: 'maker_checker' | 'requester_limit' | 'policy_author' | 'vendor_master_payment' | 'role_conflict';
  params: Record<string, unknown>;
}

export const DEFAULT_SOD_RULES: SodRuleDefinition[] = [
  { code: 'SOD-001', name: 'Maker-checker', description: 'Nobody approves an entry, reconciliation, explanation or package they prepared.', kind: 'maker_checker', params: {} },
  {
    // Kind keeps its original code ("requester_limit") so existing rule rows stay valid; it no longer has a limit.
    code: 'SOD-002',
    name: 'Agent run requester cannot approve its output',
    description: 'The person who started an agent run approves none of its output, whatever the kind or amount: someone independent must. Enforced by the database as well.',
    kind: 'requester_limit',
    params: {},
  },
  {
    code: 'SOD-003',
    name: 'Policy author cannot check the outcome',
    description: 'Whoever last changed a skill\'s policy (thresholds, autonomy, rules) cannot approve proposals generated under that policy version.',
    kind: 'policy_author',
    params: {},
  },
  {
    code: 'SOD-004',
    name: 'Vendor master vs. payment approval',
    description: 'A user who created or edited a vendor cannot approve bills or payments for that vendor.',
    kind: 'vendor_master_payment',
    params: {},
  },
  {
    code: 'SOD-005',
    name: 'Administrators hold no approval roles',
    description: 'The Admin role cannot be combined with Senior Accountant, Controller or CFO.',
    kind: 'role_conflict',
    params: { role: 'admin', conflicts: ['senior_accountant', 'controller', 'cfo'] },
  },
];

export function roleDefinition(key: string): RoleDefinition | undefined {
  return ROLES.find((r) => r.key === key);
}

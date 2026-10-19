/**
 * RBAC catalog for the accounting pack. Roles are bundles of permissions with an approval limit;
 * SoD rules (sod.ts) are evaluated across roles and across actions.
 */

export const PERMISSIONS = {
  'close.view': ['close', 'View the close calendar, tasks and progress'],
  'close.manage': ['close', 'Assign, start and complete close tasks'],
  'close.signoff': ['close', 'Sign off close tasks as reviewer'],
  'close.lock': ['close', 'Soft-close, lock and unlock periods'],
  'close.package': ['close', 'Generate and finalize the close package'],
  'ledger.read': ['ledger', 'Read journal entries and balances'],
  'report.view': ['ledger', 'View trial balance and financial statements'],
  'je.create': ['ledger', 'Prepare manual journal entries'],
  'je.approve': ['ledger', 'Approve journal entries (within approval limit)'],
  'je.reverse': ['ledger', 'Request reversal of posted journal entries'],
  'subledger.read': ['subledgers', 'Read bills, invoices, bank, card, assets, payroll'],
  'vendor.manage': ['subledgers', 'Maintain the vendor master'],
  'payment.approve': ['subledgers', 'Approve vendor payments'],
  'coding.approve': ['agents', 'Accept transaction coding suggestions'],
  'proposal.view': ['agents', 'View agent proposals and evidence'],
  'recon.prepare': ['reconciliation', 'Prepare and certify reconciliations as preparer'],
  'recon.review': ['reconciliation', 'Review and sign off reconciliations'],
  'flux.explain': ['flux', 'Write and submit variance explanations'],
  'flux.approve': ['flux', 'Approve variance explanations'],
  'agent.run': ['agents', 'Run skills and the close orchestrator'],
  'agent.view': ['agents', 'View agent run traces'],
  'skill.view': ['agents', 'View the skill catalog'],
  'skill.policy.edit': ['agents', 'Edit skill thresholds, mappings and plain-English rules'],
  'skill.autonomy.set': ['agents', 'Set skill autonomy levels'],
  'skill.eval.run': ['agents', 'Run skill evaluation suites'],
  'ontology.view': ['knowledge', 'Browse the close ontology'],
  'audit.view': ['audit', 'View the audit log'],
  'audit.verify': ['audit', 'Verify the audit hash chain'],
  'import.run': ['integrations', 'Upload and import source files'],
  'import.view': ['integrations', 'View connectors and import history'],
  'admin.users': ['admin', 'Invite users, assign roles, disable accounts'],
  'access.approve': ['admin', 'Approve access grants and control changes another person requested'],
  'admin.sod': ['admin', 'Configure segregation-of-duties rules'],
  'admin.settings': ['admin', 'Edit tenant settings, materiality and approval limits'],
  'mcp.token': ['admin', 'Create personal API tokens for the MCP server'],
} as const satisfies Record<string, readonly [string, string]>;

export type Permission = keyof typeof PERMISSIONS;

const READ_ALL: Permission[] = ['close.view', 'ledger.read', 'report.view', 'subledger.read', 'proposal.view', 'agent.view', 'skill.view', 'ontology.view', 'import.view'];

export interface RoleDef {
  key: string;
  name: string;
  description: string;
  approvalLimitMinor: number | null;
  permissions: Permission[];
}

/**
 * Permissions added after the demo scenario was fixed. The seed gives their role grants explicit
 * ids: drawing those ids from the scenario's seeded random stream would shift every amount it
 * generates afterwards.
 */
export const LATE_PERMISSIONS: ReadonlySet<Permission> = new Set(['access.approve']);

export const ROLES: RoleDef[] = [
  {
    key: 'staff_accountant',
    name: 'Staff Accountant',
    description: 'Runs agents, reviews coding, prepares reconciliations and drafts explanations.',
    approvalLimitMinor: 0,
    permissions: [...READ_ALL, 'je.create', 'coding.approve', 'recon.prepare', 'flux.explain', 'agent.run', 'close.manage', 'import.run', 'audit.view'],
  },
  {
    key: 'ap_specialist',
    name: 'AP Specialist',
    description: 'Owns vendor bills and the AP subledger; codes spend and runs AP agents.',
    approvalLimitMinor: 0,
    permissions: [...READ_ALL, 'je.create', 'coding.approve', 'vendor.manage', 'agent.run', 'close.manage', 'import.run'],
  },
  {
    key: 'senior_accountant',
    name: 'Senior Accountant',
    description: 'Approves entries up to $25,000, reviews reconciliations, manages the checklist.',
    approvalLimitMinor: 2_500_000,
    permissions: [...READ_ALL, 'je.create', 'je.approve', 'coding.approve', 'recon.prepare', 'recon.review', 'flux.explain', 'agent.run', 'close.manage', 'close.signoff', 'import.run', 'audit.view'],
  },
  {
    key: 'controller',
    name: 'Controller',
    description: 'Owns the close: approves up to $250,000, sets agent autonomy, locks periods.',
    approvalLimitMinor: 25_000_000,
    permissions: [...READ_ALL, 'je.create', 'je.approve', 'je.reverse', 'coding.approve', 'recon.prepare', 'recon.review', 'flux.explain', 'flux.approve', 'agent.run', 'close.manage', 'close.signoff', 'close.lock', 'close.package', 'skill.policy.edit', 'skill.autonomy.set', 'skill.eval.run', 'payment.approve', 'audit.view', 'audit.verify', 'import.run', 'mcp.token', 'access.approve'],
  },
  {
    key: 'cfo',
    name: 'CFO',
    description: 'Final approver with no limit; signs the close package.',
    approvalLimitMinor: null,
    permissions: [...READ_ALL, 'je.approve', 'je.reverse', 'recon.review', 'flux.approve', 'close.signoff', 'close.lock', 'close.package', 'skill.autonomy.set', 'skill.policy.edit', 'payment.approve', 'audit.view', 'audit.verify', 'agent.run', 'mcp.token', 'access.approve'],
  },
  {
    key: 'fpa_analyst',
    name: 'FP&A Analyst',
    description: 'Explains variances against budget and prior periods.',
    approvalLimitMinor: 0,
    permissions: ['close.view', 'ledger.read', 'report.view', 'proposal.view', 'agent.view', 'skill.view', 'ontology.view', 'flux.explain', 'agent.run'],
  },
  {
    key: 'auditor',
    name: 'Auditor (read-only)',
    description: 'External auditor: read-only access to everything, including the audit log.',
    approvalLimitMinor: 0,
    permissions: [...READ_ALL, 'audit.view', 'audit.verify'],
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'IT administrator: users, roles, SoD rules and settings. No financial approvals.',
    approvalLimitMinor: 0,
    permissions: ['close.view', 'skill.view', 'ontology.view', 'audit.view', 'admin.users', 'admin.sod', 'admin.settings', 'import.view'],
  },
];

export function roleDef(key: string): RoleDef | undefined {
  return ROLES.find((r) => r.key === key);
}

/** The roles that hold a permission, by name. */
export function rolesWith(permission: string): string[] {
  return ROLES.filter((r) => (r.permissions as readonly string[]).includes(permission)).map((r) => r.name);
}

const and = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * Why someone cannot do a thing, in words they can act on — what it is and which roles can —
 * never a permission code: "Your role can’t approve variance explanations; the Controller and
 * CFO roles can."
 */
export function permissionNeeded(permission: string): string {
  const what = (PERMISSIONS as Record<string, readonly [string, string]>)[permission]?.[1].replace(/\s*\(.*\)$/, '');
  const who = rolesWith(permission);
  const can = who.length ? `; the ${and(who)} role${who.length === 1 ? '' : 's'} can` : '';
  return what ? `Your role can’t ${what[0]!.toLowerCase()}${what.slice(1)}${can}.` : `Your role doesn’t allow this${can}.`;
}

/** Highest approval limit among a user's roles (null = unlimited). */
export function approvalLimit(roleKeys: readonly string[]): number | null {
  let best: number | null = 0;
  for (const k of roleKeys) {
    const r = roleDef(k);
    if (!r) continue;
    if (r.approvalLimitMinor === null) return null;
    if (best !== null && r.approvalLimitMinor > best) best = r.approvalLimitMinor;
  }
  return best;
}

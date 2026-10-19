import { AppError } from '../../../framework/util/errors';
import type { EkDb } from '../store';
import type { Actor, ServiceContext } from './context';

/** Permission catalogue (stable codes; descriptions shown in the admin console). */
export const PERMISSIONS = {
  'close.view': 'See the close calendar, tasks and status',
  'close.task.update': 'Update tasks you own',
  'close.task.review': 'Review and complete tasks prepared by others',
  'close.task.assign': 'Assign owners and reviewers',
  'period.soft_close': 'Soft-close a period (subledgers closed)',
  'period.lock': 'Hard-close (lock) a period',
  'period.reopen': 'Reopen a locked period (with reason)',
  'agent.run': 'Start agent runs for close tasks',
  'agent.orchestrate': 'Run all close agents across the calendar',
  'proposal.approve': 'Approve or reject agent proposals below performance materiality',
  'proposal.approve.material': 'Approve proposals at or above performance materiality',
  'proposal.review': 'Complete post-hoc reviews of auto-posted items',
  'je.create': 'Prepare manual journal entries',
  'je.approve': 'Approve journal entries prepared by others',
  'je.reverse': 'Reverse posted journal entries',
  'rec.prepare': 'Prepare and certify reconciliations',
  'rec.review': 'Review (sign off) reconciliations prepared by others',
  'flux.explain': 'Write or edit variance explanations',
  'flux.approve': 'Approve variance explanations written by others',
  'issue.resolve': 'Resolve or dismiss exceptions',
  'report.view': 'View trial balance, statements and close packages',
  'package.generate': 'Generate the close package',
  'package.approve': 'Approve (sign) the close package',
  'skill.policy.edit': 'Edit skill thresholds, mappings and rules',
  'skill.autonomy.set': 'Set agent autonomy levels',
  'audit.view': 'View the audit log',
  'admin.users': 'Manage users and role assignments',
  'admin.sod': 'Manage segregation-of-duties rules',
  'integration.import': 'Import files from source systems',
  'vendor.edit': 'Create or edit vendors (incl. remittance details)',
  'payment.approve': 'Approve vendor payments',
  'ontology.view': 'Browse the close ontology',
} as const;
export type Permission = keyof typeof PERMISSIONS;

const STAFF: Permission[] = ['close.view', 'close.task.update', 'agent.run', 'je.create', 'rec.prepare', 'flux.explain', 'report.view', 'integration.import', 'ontology.view', 'issue.resolve'];
const SENIOR: Permission[] = [...STAFF, 'close.task.review', 'proposal.approve', 'proposal.review', 'je.approve', 'je.reverse', 'rec.review', 'flux.approve', 'skill.policy.edit', 'period.soft_close', 'agent.orchestrate', 'package.generate', 'audit.view'];

export interface RoleDef {
  code: string;
  name: string;
  description: string;
  rank: number;
  permissions: Permission[];
}

export const ROLE_DEFS: RoleDef[] = [
  { code: 'staff_accountant', name: 'Staff Accountant', description: 'Prepares reconciliations, accruals and explanations; runs agents for owned tasks.', rank: 10, permissions: STAFF },
  { code: 'ap_clerk', name: 'AP Clerk', description: 'Processes vendor bills and payments; prepares AP tasks.', rank: 8, permissions: ['close.view', 'close.task.update', 'agent.run', 'je.create', 'rec.prepare', 'integration.import', 'vendor.edit', 'report.view', 'ontology.view'] },
  { code: 'fpa_analyst', name: 'FP&A Analyst', description: 'Explains variances against budget and prior periods.', rank: 9, permissions: ['close.view', 'close.task.update', 'agent.run', 'flux.explain', 'report.view', 'ontology.view'] },
  { code: 'senior_accountant', name: 'Senior Accountant', description: 'Reviews and approves routine close work; tunes skill policies.', rank: 20, permissions: SENIOR },
  { code: 'controller', name: 'Controller', description: 'Owns the close: approves material items, sets agent autonomy, locks the period.', rank: 30, permissions: [...SENIOR, 'proposal.approve.material', 'period.lock', 'skill.autonomy.set', 'package.approve', 'close.task.assign', 'payment.approve'] },
  { code: 'cfo', name: 'CFO', description: 'Final sign-off on the close package; reopens locked periods.', rank: 40, permissions: ['close.view', 'report.view', 'proposal.approve', 'proposal.approve.material', 'package.approve', 'period.lock', 'period.reopen', 'audit.view', 'flux.approve', 'ontology.view', 'close.task.review', 'issue.resolve'] },
  { code: 'auditor', name: 'Auditor (read-only)', description: 'Read-only access to the ledger, evidence, traces and audit log.', rank: 5, permissions: ['close.view', 'report.view', 'audit.view', 'ontology.view'] },
  { code: 'admin', name: 'Administrator', description: 'Manages users, roles and SoD rules. Cannot approve accounting work.', rank: 15, permissions: ['admin.users', 'admin.sod', 'audit.view', 'close.view', 'ontology.view', 'report.view'] },
];

export const DEFAULT_SOD_RULES = [
  { code: 'SOD-01', name: 'Preparer is not approver', kind: 'same_actor' as const, description: 'The person who prepares an item (entry, reconciliation, explanation) cannot approve it.', permission_a: null, permission_b: null },
  { code: 'SOD-02', name: 'Agent requester is not approver', kind: 'same_actor' as const, description: 'Whoever started an agent run cannot approve the proposals that run produced.', permission_a: null, permission_b: null },
  { code: 'SOD-03', name: 'Vendor master vs payment approval', kind: 'permission_pair' as const, description: 'Editing vendor master data and approving payments to vendors are incompatible duties.', permission_a: 'vendor.edit', permission_b: 'payment.approve' },
  { code: 'SOD-04', name: 'User administration vs journal approval', kind: 'permission_pair' as const, description: 'Administrators who grant access cannot also approve journal entries.', permission_a: 'admin.users', permission_b: 'je.approve' },
  { code: 'SOD-05', name: 'Reconciliation preparer is not reviewer', kind: 'same_actor' as const, description: 'A reconciliation is reviewed by someone other than its preparer.', permission_a: null, permission_b: null },
];

/** Resolve a user's roles, effective permissions and entity scope. */
export async function loadActor(db: EkDb, tenantId: string, userId: string, extra: Partial<Actor> = {}): Promise<Actor> {
  const user = await db.get('app_user', userId);
  if (!user || user.tenant_id !== tenantId) throw new AppError('UNAUTHENTICATED', 'Unknown user');
  if (user.status !== 'active') throw new AppError('FORBIDDEN', 'This account is disabled.');
  const grants = await db.find('user_role', { user_id: userId });
  const roles = await db.find('role', { id: { in: grants.map((g) => g.role_id) } });
  const perms = await db.find('role_permission', { role_id: { in: roles.map((r) => r.id) } });
  const scoped = grants.filter((g) => g.entity_id !== null).map((g) => g.entity_id!);
  const tenantWide = grants.some((g) => g.entity_id === null);
  return {
    type: 'user',
    userId,
    label: user.display_name,
    roles: roles.sort((a, b) => b.rank - a.rank).map((r) => r.code),
    permissions: new Set(perms.map((p) => p.permission)),
    entityScope: tenantWide ? 'all' : scoped,
    ...extra,
  };
}

export interface SodSubject {
  preparedBy?: string | null;
  requestedBy?: string | null;
  /** Vendors touched by the item (for vendor-master conflicts) */
  vendorIds?: string[];
  kind: 'approve_proposal' | 'approve_entry' | 'review_rec' | 'approve_flux' | 'review_task';
}

export interface SodFinding {
  rule: string;
  name: string;
  message: string;
  severity: 'block' | 'warn';
}

/**
 * Evaluate the tenant's SoD rules for an approval-type action. Blocking findings must stop
 * the action; warnings are recorded in the audit trail.
 */
export async function evaluateSod(ctx: ServiceContext, subject: SodSubject): Promise<SodFinding[]> {
  const rules = await ctx.db.find('sod_rule', { tenant_id: ctx.tenantId, enabled: true });
  const me = ctx.actor.userId;
  const out: SodFinding[] = [];
  for (const r of rules) {
    if (r.code === 'SOD-01' && me && subject.preparedBy && subject.preparedBy === me) {
      out.push({ rule: r.code, name: r.name, severity: r.severity, message: 'You prepared this item, so someone else must approve it.' });
    }
    if (r.code === 'SOD-02' && me && subject.requestedBy && subject.requestedBy === me) {
      out.push({ rule: r.code, name: r.name, severity: r.severity, message: 'You started the agent run that produced this, so someone else must approve it.' });
    }
    if (r.code === 'SOD-05' && subject.kind === 'review_rec' && me && subject.preparedBy === me) {
      out.push({ rule: r.code, name: r.name, severity: r.severity, message: 'You prepared this reconciliation, so someone else must review it.' });
    }
    if (r.code === 'SOD-03' && me && subject.vendorIds?.length) {
      const vendors = await ctx.db.find('vendor', { id: { in: subject.vendorIds } });
      if (vendors.some((v) => v.updated_by === me || v.created_by === me)) {
        out.push({ rule: r.code, name: r.name, severity: r.severity, message: 'You edited this vendor’s master data, so you cannot approve payments or entries for it.' });
      }
    }
  }
  return out;
}

export async function assertSod(ctx: ServiceContext, subject: SodSubject): Promise<SodFinding[]> {
  const findings = await evaluateSod(ctx, subject);
  const blocking = findings.filter((f) => f.severity === 'block');
  if (blocking.length) throw new AppError('SOD_VIOLATION', blocking.map((b) => `${b.rule}: ${b.message}`).join(' '), { findings });
  return findings;
}

/** Permission-pair conflicts held by a single user (shown in admin; warned at grant time). */
export async function roleConflicts(db: EkDb, tenantId: string, userId: string): Promise<SodFinding[]> {
  const actor = await loadActor(db, tenantId, userId);
  const rules = await db.find('sod_rule', { tenant_id: tenantId, enabled: true, kind: 'permission_pair' });
  return rules
    .filter((r) => r.permission_a && r.permission_b && actor.permissions.has(r.permission_a) && actor.permissions.has(r.permission_b))
    .map((r) => ({ rule: r.code, name: r.name, severity: r.severity, message: `${actor.label} holds both ${r.permission_a} and ${r.permission_b}.` }));
}

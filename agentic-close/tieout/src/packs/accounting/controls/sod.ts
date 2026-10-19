/**
 * Segregation-of-duties engine (tie:SegregationOfDuties). Rules are data (sod_rules table) so
 * admins can enable, disable and tune them; every evaluation is explained in plain English.
 *
 *  maker_checker      approver ≠ preparer ≠ editor             (AX-SOD-01)
 *  requester_checker  approver ≠ person who ran the agent       (AX-SOD-02)
 *  role_conflict      the first listed role is never held with any of the others (assignment-time)
 *  permission_conflict nobody holds two conflicting permissions (assignment-time)
 */
import type { SodRuleRow } from '../../../schema';

export interface SodSubject {
  subjectType: 'journal_entry' | 'proposal' | 'reconciliation' | 'flux_explanation' | 'close_task' | 'payment';
  preparedBy: string | null;
  editedBy?: string | null;
  requestedBy?: string | null;
  /** true when an AI agent prepared the item */
  agentPrepared?: boolean;
}

export interface SodDecision {
  allowed: boolean;
  violations: { code: string; name: string; message: string; severity: 'block' | 'warn' }[];
}

export function evaluateApproval(rules: readonly SodRuleRow[], approverId: string, s: SodSubject): SodDecision {
  const violations: SodDecision['violations'] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const subjects = r.config.subjects ?? [];
    if (subjects.length && !subjects.includes(s.subjectType)) continue;
    if (r.kind === 'maker_checker') {
      if (s.preparedBy && s.preparedBy === approverId) violations.push({ code: r.code, name: r.name, severity: r.severity, message: 'You prepared this item, so someone else has to approve it.' });
      else if (s.editedBy && s.editedBy === approverId) violations.push({ code: r.code, name: r.name, severity: r.severity, message: 'You edited this item, which makes you a preparer; someone else has to approve it.' });
    }
    if (r.kind === 'requester_checker' && s.agentPrepared && s.requestedBy && s.requestedBy === approverId) {
      violations.push({ code: r.code, name: r.name, severity: r.severity, message: 'You ran the agent that prepared this, so a different person has to approve it.' });
    }
  }
  return { allowed: !violations.some((v) => v.severity === 'block'), violations };
}

export interface AssignmentConflict {
  code: string;
  name: string;
  message: string;
}

/** Conflicts created by holding these roles/permissions together (checked when assigning roles). */
export function evaluateAssignment(rules: readonly SodRuleRow[], roleKeys: readonly string[], permissions: ReadonlySet<string>): AssignmentConflict[] {
  const out: AssignmentConflict[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.kind === 'role_conflict') {
      // e.g. auditor vs every preparer/approver role; the others may be combined with each other
      const [anchor, ...others] = r.config.roles ?? [];
      const clash = anchor && roleKeys.includes(anchor) ? others.filter((x) => roleKeys.includes(x)) : [];
      if (clash.length) out.push({ code: r.code, name: r.name, message: `Holds conflicting roles: ${anchor} + ${clash.join(', ')}` });
    }
    if (r.kind === 'permission_conflict') {
      const perms = r.config.permissions ?? [];
      const held = perms.filter((p) => permissions.has(p));
      if (held.length >= 2 && held.length === perms.length) out.push({ code: r.code, name: r.name, message: `Holds conflicting permissions: ${held.join(' + ')}` });
    }
  }
  return out;
}

export const DEFAULT_SOD_RULES: Omit<SodRuleRow, 'id' | 'tenant_id' | 'updated_by' | 'updated_at'>[] = [
  { code: 'SOD-01', name: 'Maker-checker', description: 'The person who prepared or edited an item cannot approve it. Applies to journal entries, proposals, reconciliations, explanations and close tasks.', kind: 'maker_checker', config: { subjects: [] }, severity: 'block', enabled: true },
  { code: 'SOD-02', name: 'Agent requester is not the approver', description: 'Whoever runs an agent is accountable for its drafts and cannot also approve the journal entries it prepares.', kind: 'requester_checker', config: { subjects: ['journal_entry', 'proposal'] }, severity: 'block', enabled: true },
  { code: 'SOD-03', name: 'Admins do not approve', description: 'System administrators may not hold financial approval roles.', kind: 'role_conflict', config: { roles: ['admin', 'senior_accountant', 'controller', 'cfo'] }, severity: 'block', enabled: true },
  { code: 'SOD-04', name: 'Vendor master vs payments', description: 'Nobody may both maintain vendors (bank details) and approve payments.', kind: 'permission_conflict', config: { permissions: ['vendor.manage', 'payment.approve'] }, severity: 'block', enabled: true },
  { code: 'SOD-05', name: 'Auditors stay read-only', description: 'The auditor role may not be combined with any preparer or approver role.', kind: 'role_conflict', config: { roles: ['auditor', 'staff_accountant', 'senior_accountant', 'controller', 'cfo', 'ap_specialist'] }, severity: 'block', enabled: true },
];

import { KeyRound, Lock, Plus, ShieldCheck, UserX, Users } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { ago, date, money } from '../lib/format';
import { useAction, useApi, useCan, useMe } from '../lib/hooks';
import { Avatar, Badge, Empty, ErrorBox, Modal, ReasonDialog, Skeleton, Tabs, Term } from '../components/ui';

interface Grant {
  key: string | undefined;
  name: string | undefined;
  entityId: string | null;
  entity: string | null;
}

interface AdminUser {
  id: string;
  name: string;
  email: string;
  title: string | null;
  hue: number;
  status: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  provider: string | null;
  enrolled: boolean;
  roles: Grant[];
  pendingGrant: { id: string; summary: string } | null;
  activeSessions: number;
}

interface RoleInfo {
  key: string;
  name: string;
  description: string;
  approvalLimit: number | null;
  readOnly: boolean;
  permissions: string[];
  needsApproval: boolean;
  entityScopable: boolean;
}

interface UsersData {
  users: AdminUser[];
  roles: RoleInfo[];
  entities: Array<{ id: string; code: string; name: string }>;
  permissions: Array<{ key: string; description: string }>;
  canManage: boolean;
  canApproveAccess: boolean;
  pendingRequests: number;
}

interface SodRule {
  id: string;
  code: string;
  name: string;
  description: string;
  kind: string;
  params: Record<string, unknown>;
  severity: 'block' | 'warn';
  enabled: boolean;
  version: number;
  updatedAt: string;
  pendingChange: { id: string; summary: string } | null;
}

interface SessionRow {
  id: string;
  user: string;
  method: string;
  mfaVerified: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

interface AccessRequest {
  id: string;
  kind: 'role_grant' | 'sod_rule_change';
  summary: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  requestedBy: string;
  requestedAt: string;
  target: { id: string; name: string; email: string; enrolled: boolean; enrolmentLinkOpenedAt: string | null } | null;
  rule: { code: string; name: string } | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  canDecide: boolean;
  blocks: string[];
}

type Tab = 'people' | 'access' | 'roles' | 'sod' | 'sessions';

export function AdminScreen({ initialTab }: { initialTab?: string | null }) {
  const can = useCan();
  const tabs: Array<{ id: Tab; label: string }> = [
    ...(can('admin.users') || can('audit.view') ? [{ id: 'people' as Tab, label: 'People' }] : []),
    ...(can('admin.users') || can('access.approve') ? [{ id: 'access' as Tab, label: 'Access requests' }] : []),
    { id: 'roles', label: 'Roles and permissions' },
    { id: 'sod', label: 'Segregation of duties' },
    ...(can('admin.sessions') ? [{ id: 'sessions' as Tab, label: 'Sessions' }] : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs.find((t) => t.id === initialTab)?.id ?? tabs[0]!.id);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Administration</h1>
          <div className="sub">People, roles, controls and sessions. Admins manage access but hold no financial approval rights, and nobody grants approval authority or changes a control alone.</div>
        </div>
      </div>
      <Tabs<Tab> label="Administration sections" value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'people' && <People />}
      {tab === 'access' && <AccessRequests />}
      {tab === 'roles' && <Roles />}
      {tab === 'sod' && <SodRules />}
      {tab === 'sessions' && <Sessions />}
    </div>
  );
}

/** Role and entity choices for one person: each chosen role covers every entity or just one. */
function GrantPicker({ data, value, onChange }: { data: UsersData; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  return (
    <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="small text-2" style={{ marginBottom: 8 }}>
        Roles marked <Badge tone="attention">needs approval</Badge> carry approval authority: they take effect only when a Controller or CFO other than you approves them. Conflicting combinations (SOD-005) are refused.
      </legend>
      {data.roles.map((r) => {
        const on = r.key in value;
        return (
          <div key={r.key} className="row-wrap" style={{ alignItems: 'flex-start' }}>
            <label className="chip-check grow">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => {
                  const next = { ...value };
                  if (e.target.checked) next[r.key] = '';
                  else delete next[r.key];
                  onChange(next);
                }}
              />
              <span>
                <strong>{r.name}</strong> {r.needsApproval && <Badge tone="attention">needs approval</Badge>}
                <span className="tiny muted" style={{ display: 'block' }}>
                  {r.description}
                </span>
              </span>
            </label>
            {on && r.entityScopable && (
              <select className="select" style={{ width: 'auto' }} aria-label={`${r.name}: which entities`} value={value[r.key]} onChange={(e) => onChange({ ...value, [r.key]: e.target.value })}>
                <option value="">All entities</option>
                {data.entities.map((e) => (
                  <option key={e.id} value={e.code}>
                    {e.code} only
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

const grantsOf = (v: Record<string, string>) => Object.entries(v).map(([role, entity]) => (entity ? { role, entity } : role));

interface RolesResult {
  applied: number;
  pending: { id: string; summary: string } | null;
}

function rolesToast(name: string, r: RolesResult): string {
  return r.pending ? `${r.pending.summary}: waiting for a Controller or CFO to approve.${r.applied ? ` Other changes applied; ${name} was signed out.` : ''}` : `Roles updated; ${name} was signed out everywhere.`;
}

function People() {
  const me = useMe();
  const can = useCan();
  const { data, error, reload } = useApi<UsersData>('/api/admin/users');
  const { run, busy } = useAction();
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [grants, setGrants] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', title: '' });
  const [newGrants, setNewGrants] = useState<Record<string, string>>({ staff_accountant: '' });
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={8} />;
  return (
    <section className="card" aria-label="People">
      <div className="card-head">
        <h2>
          <Users size={15} aria-hidden="true" /> {data.users.length} people
        </h2>
        {data.canManage && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
            <Plus size={14} aria-hidden="true" /> Add person
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Roles</th>
              <th className="hide-sm">Sign-in</th>
              <th>Status</th>
              {data.canManage && <th className="right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div className="row">
                    <Avatar name={u.name} hue={u.hue} />
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {u.name}
                        {u.id === me.user.id && <span className="tiny muted"> (you)</span>}
                      </div>
                      <div className="tiny muted">
                        {u.email}
                        {u.title ? ` · ${u.title}` : ''}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="row-wrap">
                    {u.roles.map((r, i) => (
                      <Badge key={i}>
                        {r.name ?? r.key}
                        {r.entity ? ` · ${r.entity} only` : ''}
                      </Badge>
                    ))}
                    {u.roles.length === 0 && <span className="muted small">No roles</span>}
                    {u.pendingGrant && (
                      <Badge tone="attention" title={u.pendingGrant.summary}>
                        Pending approval
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="hide-sm small">
                  <div>{!u.enrolled ? 'Invited, not enrolled yet' : u.lastLoginAt ? ago(u.lastLoginAt) : 'Never'}</div>
                  <div className="tiny muted">
                    {u.mfaEnabled ? 'Authenticator on' : 'Password only'} · {u.activeSessions} active session{u.activeSessions === 1 ? '' : 's'}
                    {u.provider ? ` · ${u.provider}` : ''}
                  </div>
                </td>
                <td>
                  {u.lockedUntil ? <Badge tone="danger">Locked until {date(u.lockedUntil, 'time')}</Badge> : <Badge tone={u.status === 'active' ? 'success' : ''}>{u.status === 'active' ? 'Active' : 'Disabled'}</Badge>}
                </td>
                {data.canManage && (
                  <td className="right">
                    <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                      {can('admin.roles') && u.id !== me.user.id && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            setEditing(u);
                            setReason('');
                            setGrants(Object.fromEntries(u.roles.filter((r) => r.key).map((r) => [r.key!, r.entity ?? ''])));
                          }}
                        >
                          Roles
                        </button>
                      )}
                      {u.id !== me.user.id && (
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => api.put(`/api/admin/users/${u.id}/status`, { status: u.status === 'active' && !u.lockedUntil ? 'disabled' : 'active' }), u.status === 'active' && !u.lockedUntil ? `${u.name} disabled and signed out.` : `${u.name} enabled.`)}>
                          {u.status === 'active' && !u.lockedUntil ? (
                            <>
                              <UserX size={14} aria-hidden="true" /> Disable
                            </>
                          ) : (
                            'Enable'
                          )}
                        </button>
                      )}
                      {u.provider === 'password' && u.status === 'active' && (
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setResetting(u)}>
                          <KeyRound size={14} aria-hidden="true" /> {u.enrolled ? 'Reset password' : 'Resend enrolment link'}
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <Modal
          title={`Roles for ${editing.name}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  const r = await run(() => api.put<RolesResult>(`/api/admin/users/${editing.id}/roles`, { roles: grantsOf(grants), reason: reason.trim() || undefined }), (x) => rolesToast(editing.name, x));
                  if (r) setEditing(null);
                }}
              >
                Save roles
              </button>
            </>
          }
        >
          <p className="small text-2">Removing a role, or adding one without approval authority, applies at once and signs the person out everywhere.</p>
          <GrantPicker data={data} value={grants} onChange={setGrants} />
          <div className="field">
            <label htmlFor="roles-reason">Why does {editing.name.split(' ')[0]} need this? (shown to the approver)</label>
            <textarea id="roles-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </Modal>
      )}
      {creating && (
        <Modal
          title="Add a person"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || form.name.trim().length < 2 || !form.email.includes('@') || Object.keys(newGrants).length === 0}
                onClick={async () => {
                  const r = await run(
                    () => api.post<{ id: string; enrolment: { sentTo: string; expiresAt: string }; applied: number; pending: { summary: string } | null }>('/api/admin/users', { name: form.name, email: form.email, title: form.title || undefined, roles: grantsOf(newGrants) }),
                    (x) => `${form.name} added. A single-use enrolment link went to ${x.enrolment.sentTo} (valid until ${date(x.enrolment.expiresAt, 'time')}).${x.pending ? ` ${x.pending.summary}: waiting for a Controller or CFO to approve.` : ''}`,
                  );
                  if (r) {
                    setCreating(false);
                    setForm({ name: '', email: '', title: '' });
                    setNewGrants({ staff_accountant: '' });
                  }
                }}
              >
                Add person and send link
              </button>
            </>
          }
        >
          <p className="small text-2">Nobody is given a password: the person receives a single-use enrolment link at this address and chooses their own. You never see it.</p>
          <div className="field">
            <label htmlFor="nu-name">Name</label>
            <input id="nu-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="nu-email">Work email</label>
            <input id="nu-email" type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="nu-title">Title (optional)</label>
            <input id="nu-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <GrantPicker data={data} value={newGrants} onChange={setNewGrants} />
        </Modal>
      )}
      {resetting && (
        <Modal
          title={resetting.enrolled ? `Reset the password of ${resetting.name}?` : `Send ${resetting.name} a new enrolment link?`}
          onClose={() => setResetting(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setResetting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  const r = await run(() => api.post<{ purpose: string; sentTo: string; expiresAt: string }>(`/api/admin/users/${resetting.id}/reset-password`), (x) => `A single-use ${x.purpose === 'password_reset' ? 'reset' : 'enrolment'} link went to ${x.sentTo} (valid until ${date(x.expiresAt, 'time')}).`);
                  if (r) setResetting(null);
                }}
              >
                {resetting.enrolled ? 'Reset and send link' : 'Send link'}
              </button>
            </>
          }
        >
          <p className="small text-2">
            {resetting.enrolled ? `Their current password stops working and they are signed out everywhere. ` : ''}A single-use link goes to {resetting.email}; earlier links stop working. You will not see the link or the new password.
          </p>
        </Modal>
      )}
    </section>
  );
}

function AccessRequests() {
  const { data, error, reload } = useApi<{ requests: AccessRequest[]; canApprove: boolean }>('/api/admin/access-requests', { pollMs: 20_000 });
  const { run, busy } = useAction();
  const [rejecting, setRejecting] = useState<AccessRequest | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={5} />;
  const pending = data.requests.filter((r) => r.status === 'pending');
  const decided = data.requests.filter((r) => r.status !== 'pending');
  return (
    <section className="card" aria-label="Access requests">
      <div className="card-head">
        <h2>
          <ShieldCheck size={15} aria-hidden="true" /> {pending.length} access request{pending.length === 1 ? '' : 's'} waiting
        </h2>
        <span className="small muted">Dual control: requested by one person, approved by another</span>
      </div>
      <p className="card-pad small text-2" style={{ borderBottom: '1px solid var(--border)' }}>
        A role that carries approval authority, and any change to a <Term id="bh:SegregationOfDutiesRule">segregation-of-duties</Term> rule, takes effect only when a Controller or CFO approves it who neither asked for it nor receives it, and who holds at least that authority. Approve a grant only if you know the person and they need the access.
      </p>
      {pending.length === 0 ? (
        <Empty title="Nothing waiting">Requests appear here when an administrator grants a role with approval authority or changes a control.</Empty>
      ) : (
        <ul className="list">
          {pending.map((r) => (
            <li key={r.id} className="stack" style={{ gap: 6 }}>
              <div className="row-wrap">
                <strong className="grow">{r.summary}</strong>
                <span className="tiny muted">
                  asked by {r.requestedBy} · {ago(r.requestedAt)}
                </span>
              </div>
              <p className="small text-2">Reason: {r.reason}</p>
              {r.target && (
                <p className="tiny muted">
                  {r.target.name} ({r.target.email}): {r.target.enrolled ? 'has chosen a password' : 'has not enrolled yet'}
                  {r.target.enrolmentLinkOpenedAt ? `; their enrolment message was opened ${date(r.target.enrolmentLinkOpenedAt, 'time')}` : ''}. Their sessions end when this is decided.
                </p>
              )}
              {r.blocks.length > 0 && (
                <div className="callout small" role="note">
                  You cannot decide this: {r.blocks.join(' ')}
                </div>
              )}
              {r.canDecide && (
                <div className="row-wrap">
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(() => api.post(`/api/admin/access-requests/${r.id}/decide`, { decision: 'approve' }), `Approved: ${r.summary}.`)}>
                    Approve
                  </button>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setRejecting(r)}>
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <details className="card-pad" style={{ borderTop: '1px solid var(--border)' }}>
          <summary className="small">Decided recently ({decided.length})</summary>
          <ul className="list">
            {decided.map((r) => (
              <li key={r.id} className="row-wrap small">
                <Badge tone={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'danger' : ''}>{r.status}</Badge>
                <span className="grow">{r.summary}</span>
                <span className="tiny muted">
                  asked by {r.requestedBy}
                  {r.decidedBy ? `, ${r.status} by ${r.decidedBy}` : ''} {r.decidedAt ? ago(r.decidedAt) : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {rejecting && <ReasonDialog title={`Reject: ${rejecting.summary}`} prompt="Why are you rejecting it?" confirmLabel="Reject" danger onClose={() => setRejecting(null)} onSubmit={(reason) => run(() => api.post(`/api/admin/access-requests/${rejecting.id}/decide`, { decision: 'reject', reason }), 'Rejected; nothing changed.')} />}
    </section>
  );
}

function Roles() {
  const { data, error, reload } = useApi<UsersData>('/api/admin/users');
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={8} />;
  const perms = data.permissions;
  return (
    <section className="card" aria-label="Roles and permissions">
      <div className="card-head">
        <h2>
          <Term id="bh:Role">Roles</Term> and permissions
        </h2>
        <span className="small muted">
          Approval limits are <Term id="bh:ApprovalLimit">per item</Term>, in USD
        </span>
      </div>
      <div className="table-wrap matrix-wrap">
        <table className="table matrix">
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {data.roles.map((r) => (
                <th key={r.key} scope="col" className="center" title={r.description}>
                  {r.name}
                  <div className="tiny muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    {r.readOnly ? 'read-only' : r.approvalLimit === null ? 'unlimited' : r.approvalLimit === 0 ? 'no approvals' : `≤ ${money(r.approvalLimit, 'USD', { cents: false })}`}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p.key}>
                <th scope="row" className="perm-cell">
                  <code className="tiny">{p.key}</code>
                  <div className="small" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--text-2)' }}>
                    {p.description}
                  </div>
                </th>
                {data.roles.map((r) => (
                  <td key={r.key} className="center">
                    {r.permissions.includes(p.key) ? (
                      <span className="pos" aria-label="granted">
                        ●
                      </span>
                    ) : (
                      <span className="muted" aria-label="not granted">
                        ·
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SodRules() {
  const can = useCan();
  const { data, error, reload } = useApi<SodRule[]>('/api/admin/sod-rules');
  const { run, busy } = useAction();
  const [editing, setEditing] = useState<{ rule: SodRule; enabled: boolean; severity: 'block' | 'warn' } | null>(null);
  const [reason, setReason] = useState('');
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={6} />;
  const editable = can('admin.sod');
  return (
    <section className="card" aria-label="Segregation of duties rules">
      <div className="card-head">
        <h2>
          <Term id="bh:SegregationOfDutiesRule">Segregation of duties</Term> rules
        </h2>
        <span className="small muted">Checked on every proposal decision</span>
      </div>
      {data.length === 0 ? (
        <Empty title="No rules" />
      ) : (
        <ul className="list">
          {data.map((r) => (
            <li key={r.id}>
              <div className="row-wrap">
                <span className="mono tiny muted">{r.code}</span>
                <strong className="grow">{r.name}</strong>
                <Badge tone={!r.enabled ? '' : r.severity === 'block' ? 'success' : 'attention'}>{!r.enabled ? 'Off' : r.severity === 'block' ? 'Blocks' : 'Warns'}</Badge>
                <span className="tiny muted">v{r.version}</span>
                {r.pendingChange && (
                  <Badge tone="attention" title={r.pendingChange.summary}>
                    Change waiting for approval
                  </Badge>
                )}
                {editable && r.kind === 'requester_limit' && <span className="tiny muted">Always on (enforced by the database)</span>}
                {editable && r.kind !== 'requester_limit' && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setReason('');
                      setEditing({ rule: r, enabled: r.enabled, severity: r.severity });
                    }}
                  >
                    Change
                  </button>
                )}
              </div>
              <p className="small text-2" style={{ marginTop: 4 }}>
                {r.description}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="card-pad small muted" style={{ borderTop: '1px solid var(--border)' }}>
        These rules govern decisions on agent proposals. Maker-checker on manual journal entries, reconciliation sign-offs, flux approval and close-task review is also built into those workflows and stays on even if SOD-001 is switched off.
      </p>
      {!editable && (
        <p className="card-pad small muted row">
          <Lock size={13} aria-hidden="true" /> An Admin requests rule changes and a Controller or CFO approves them; every change is versioned and audited.
        </p>
      )}
      {editing && (
        <Modal
          title={`${editing.rule.code} ${editing.rule.name}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || reason.trim().length < 5}
                onClick={async () => {
                  const r = await run(() => api.patch(`/api/admin/sod-rules/${editing.rule.id}`, { enabled: editing.enabled, severity: editing.severity, reason: reason.trim() }), 'Change requested: it applies when a Controller or CFO other than you approves it.');
                  if (r) setEditing(null);
                }}
              >
                Request change
              </button>
            </>
          }
        >
          <p className="small text-2">{editing.rule.description}</p>
          <label className="chip-check">
            <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
            <span>Rule is on</span>
          </label>
          <div className="field">
            <label htmlFor="sod-sev">When it is violated</label>
            <select id="sod-sev" className="select" value={editing.severity} onChange={(e) => setEditing({ ...editing, severity: e.target.value as 'block' | 'warn' })}>
              <option value="block">Block the action</option>
              <option value="warn">Allow it, but flag and audit it</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="sod-reason">Why are you changing a control?</label>
            <textarea id="sod-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
            <span className="hint">A control never changes on one person's say-so: a Controller or CFO other than you must approve the change before it applies. Both steps are audited.</span>
          </div>
        </Modal>
      )}
    </section>
  );
}

function Sessions() {
  const { data, error, reload } = useApi<SessionRow[]>('/api/admin/sessions', { pollMs: 15000 });
  const { run, busy } = useAction();
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={6} />;
  return (
    <section className="card" aria-label="Active sessions">
      <div className="card-head">
        <h2>
          <ShieldCheck size={15} aria-hidden="true" /> {data.length} active session{data.length === 1 ? '' : 's'}
        </h2>
        <span className="small muted">Sessions expire after 30 minutes idle or 12 hours; tokens rotate every 15 minutes</span>
      </div>
      {data.length === 0 ? (
        <Empty title="No active sessions" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th className="hide-sm">Method</th>
                <th>Last seen</th>
                <th className="hide-sm">Client</th>
                <th className="right">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <td>{s.user}</td>
                  <td className="hide-sm small">
                    {s.method} {s.mfaVerified && <Badge tone="success">MFA</Badge>}
                  </td>
                  <td className="small">
                    {ago(s.lastSeenAt)}
                    <div className="tiny muted">idle expiry {date(s.expiresAt, 'time')}</div>
                  </td>
                  <td className="hide-sm tiny muted clamp-2">
                    {s.ip ?? '—'} · {s.userAgent ?? '—'}
                  </td>
                  <td className="right">
                    <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void run(() => api.del(`/api/admin/sessions/${s.id}`), 'Session revoked.')}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

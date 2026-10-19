import { Copy, KeyRound, Lock, Plus, ShieldCheck, UserX, Users } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { ago, date, money } from '../lib/format';
import { useAction, useApi, useCan, useMe } from '../lib/hooks';
import { Avatar, Badge, Empty, ErrorBox, Modal, Skeleton, Tabs, Term } from '../components/ui';

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
  roles: Array<{ key: string | undefined; name: string | undefined; entityId: string | null }>;
  activeSessions: number;
}

interface RoleInfo {
  key: string;
  name: string;
  description: string;
  approvalLimit: number | null;
  readOnly: boolean;
  permissions: string[];
}

interface UsersData {
  users: AdminUser[];
  roles: RoleInfo[];
  permissions: Array<{ key: string; description: string }>;
  canManage: boolean;
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

type Tab = 'people' | 'roles' | 'sod' | 'sessions';

export function AdminScreen() {
  const can = useCan();
  const [tab, setTab] = useState<Tab>('people');
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'people', label: 'People' },
    { id: 'roles', label: 'Roles and permissions' },
    { id: 'sod', label: 'Segregation of duties' },
    ...(can('admin.sessions') ? [{ id: 'sessions' as Tab, label: 'Sessions' }] : []),
  ];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Administration</h1>
          <div className="sub">People, roles, controls and sessions. Admins manage access but hold no financial approval rights.</div>
        </div>
      </div>
      <Tabs<Tab> label="Administration sections" value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'people' && <People />}
      {tab === 'roles' && <Roles />}
      {tab === 'sod' && <SodRules />}
      {tab === 'sessions' && <Sessions />}
    </div>
  );
}

function SecretOnce({ title, email, secret, onClose }: { title: string; email?: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <p className="small text-2">Share this temporary password with {email ?? 'the person'} over a separate channel. It is shown once and is not stored in readable form; they should change it after signing in.</p>
      <div className="row">
        <code className="secret grow">{secret}</code>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(secret).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          <Copy size={14} aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </Modal>
  );
}

function People() {
  const me = useMe();
  const can = useCan();
  const { data, error, reload } = useApi<UsersData>('/api/admin/users');
  const { run, busy } = useAction();
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', title: '', roles: ['staff_accountant'] });
  const [secret, setSecret] = useState<{ email?: string; value: string } | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={8} />;
  const roleName = new Map(data.roles.map((r) => [r.key, r.name]));
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
                      <Badge key={i}>{r.name ?? r.key}</Badge>
                    ))}
                    {u.roles.length === 0 && <span className="muted small">No roles</span>}
                  </div>
                </td>
                <td className="hide-sm small">
                  <div>{u.lastLoginAt ? ago(u.lastLoginAt) : 'Never'}</div>
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
                            setRoles(u.roles.map((r) => r.key).filter((k): k is string => !!k));
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
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={async () => {
                          const r = await run(() => api.post<{ temporaryPassword: string }>(`/api/admin/users/${u.id}/reset-password`), `Password reset for ${u.name}; their sessions were signed out.`);
                          if (r) setSecret({ email: u.email, value: r.temporaryPassword });
                        }}
                      >
                        <KeyRound size={14} aria-hidden="true" /> Reset password
                      </button>
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
                  const r = await run(() => api.put(`/api/admin/users/${editing.id}/roles`, { roles }), 'Roles updated; their sessions were signed out.');
                  if (r) setEditing(null);
                }}
              >
                Save roles
              </button>
            </>
          }
        >
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small text-2" style={{ marginBottom: 8 }}>
              Changing roles signs the person out everywhere. Conflicting combinations (SoD-005) are refused.
            </legend>
            {data.roles.map((r) => (
              <label key={r.key} className="chip-check">
                <input type="checkbox" checked={roles.includes(r.key)} onChange={(e) => setRoles(e.target.checked ? [...roles, r.key] : roles.filter((x) => x !== r.key))} />
                <span>
                  <strong>{r.name}</strong>
                  <span className="tiny muted" style={{ display: 'block' }}>
                    {r.description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
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
                disabled={busy || form.name.trim().length < 2 || !form.email.includes('@') || form.roles.length === 0}
                onClick={async () => {
                  const r = await run(() => api.post<{ id: string; temporaryPassword: string }>('/api/admin/users', { name: form.name, email: form.email, title: form.title || undefined, roles: form.roles }), `${form.name} added.`);
                  if (r) {
                    setCreating(false);
                    setSecret({ email: form.email, value: r.temporaryPassword });
                    setForm({ name: '', email: '', title: '', roles: ['staff_accountant'] });
                  }
                }}
              >
                Add person
              </button>
            </>
          }
        >
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
          <div className="field">
            <label htmlFor="nu-role">Role</label>
            <select id="nu-role" className="select" value={form.roles[0]} onChange={(e) => setForm({ ...form, roles: [e.target.value] })}>
              {data.roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {roleName.get(r.key)}
                </option>
              ))}
            </select>
          </div>
        </Modal>
      )}
      {secret && <SecretOnce title="Temporary password" email={secret.email} secret={secret.value} onClose={() => setSecret(null)} />}
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
  const [editing, setEditing] = useState<{ rule: SodRule; enabled: boolean; severity: 'block' | 'warn'; limit: string } | null>(null);
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
                {editable && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setReason('');
                      setEditing({ rule: r, enabled: r.enabled, severity: r.severity, limit: typeof r.params.limit_minor === 'number' ? String((r.params.limit_minor as number) / 100) : '' });
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
          <Lock size={13} aria-hidden="true" /> Only an Admin can change these rules; every change is versioned and audited.
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
                  const params = editing.rule.kind === 'requester_limit' && editing.limit !== '' ? { ...editing.rule.params, limit_minor: Math.round(Number(editing.limit) * 100) } : undefined;
                  const r = await run(() => api.patch(`/api/admin/sod-rules/${editing.rule.id}`, { enabled: editing.enabled, severity: editing.severity, ...(params ? { params } : {}), reason: reason.trim() }), 'Control updated.');
                  if (r) setEditing(null);
                }}
              >
                Save change
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
          {editing.rule.kind === 'requester_limit' && (
            <div className="field">
              <label htmlFor="sod-limit">Self-review limit (USD)</label>
              <input id="sod-limit" className="input num" inputMode="decimal" value={editing.limit} onChange={(e) => setEditing({ ...editing, limit: e.target.value })} />
            </div>
          )}
          <div className="field">
            <label htmlFor="sod-reason">Why are you changing a control?</label>
            <textarea id="sod-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
            <span className="hint">Saved with the new version in the audit log.</span>
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

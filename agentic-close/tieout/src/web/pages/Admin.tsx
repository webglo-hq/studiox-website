/**
 * Administration: people and roles (SoD-checked), segregation-of-duties controls, access requests
 * (the second person who approves new approval authority or a control change), security
 * settings, materiality per entity, and the signed-in person's own account (password, MFA,
 * API tokens for the MCP server). Invitations and password resets send the person a link; the
 * administrator never sees a password or a link.
 */
import { KeyRound, Plus, ShieldCheck, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, setCsrf, type AccessRequest, type AccessRequests, type AdminData, type LinkSent } from '../api';
import { RecoveryCodes } from '../components/RecoveryCodes';
import { Avatar, Badge, Dialog, Empty, ErrorBox, Loading, Money, ReasonDialog, Segmented, Term } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { dateTime, ROLE_LABEL } from '../lib/format';
import { setQuery, useRoute } from '../lib/router';

type Tab = 'people' | 'controls' | 'access' | 'security' | 'materiality' | 'account';
/** what an access change returns when it waits for a second person */
type Pending = { id: string; ref: string; summary: string } | null | undefined;

export function Admin() {
  const route = useRoute();
  const tab = (route.query.get('tab') as Tab | null) ?? 'people';
  const { data, error, loading, reload } = useData(() => api<AdminData>('/admin'), []);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const seesRequests = data.canManage.users || data.canManage.sod || data.canManage.access;
  return (
    <div className={loading ? 'skeleton' : undefined}>
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <p className="lede">People, roles and the controls around them. Every change here is written to the audit log with who made it and why. New approval authority and control changes take effect only when a second person approves them.</p>
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <Segmented
          label="Section"
          value={tab}
          onChange={(v) => setQuery('tab', v === 'people' ? null : v)}
          options={[
            { value: 'people' as Tab, label: 'People & roles' },
            { value: 'controls' as Tab, label: 'SoD controls' },
            ...(seesRequests ? [{ value: 'access' as Tab, label: data.pendingAccessRequests ? `Access requests (${data.pendingAccessRequests})` : 'Access requests' }] : []),
            { value: 'security' as Tab, label: 'Security' },
            { value: 'materiality' as Tab, label: 'Materiality' },
            { value: 'account' as Tab, label: 'My account' },
          ]}
        />
      </div>
      {tab === 'people' ? <People data={data} /> : null}
      {tab === 'controls' ? <Controls data={data} /> : null}
      {tab === 'access' && seesRequests ? <Requests /> : null}
      {tab === 'security' ? <Security data={data} /> : null}
      {tab === 'materiality' ? <Materiality data={data} /> : null}
      {tab === 'account' ? <Account data={data} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ people
function People({ data }: { data: AdminData }) {
  const { toast, bump } = useApp();
  const me = useMe();
  const [editing, setEditing] = useState<AdminData['users'][number] | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  /** entity ids the roles are limited to; null = every entity */
  const [scope, setScope] = useState<string[] | null>(null);
  const legal = data.entities.filter((e) => e.kind === 'legal');
  /** why the role change is needed (shown to the person who approves it) */
  const [why, setWhy] = useState('');
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({ email: '', name: '', title: '', role: 'staff_accountant' });
  const [disabling, setDisabling] = useState<AdminData['users'][number] | null>(null);
  const [signIn, setSignIn] = useState<AdminData['users'][number] | null>(null);
  const [resettingMfa, setResettingMfa] = useState<AdminData['users'][number] | null>(null);
  const waits = (p: Pending) => (p ? ` ${p.summary} waits for a second person to approve it (${p.ref}, under Access requests).` : '');

  async function saveRoles() {
    if (!editing) return;
    try {
      const r = await api<{ pending?: Pending }>(`/admin/users/${editing.id}/roles`, { body: { roles, entityIds: scope, reason: why } });
      toast(r.pending ? `Requested.${waits(r.pending)}` : `Roles updated for ${editing.name}.`);
      setEditing(null);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not change roles.', 'bad');
    }
  }
  async function sendInvite() {
    try {
      const r = await api<{ sent: LinkSent; pending: Pending }>('/admin/users', { body: invite });
      toast(`Invitation sent to ${r.sent.to}. ${invite.name} chooses their own password with the link.${waits(r.pending)}`);
      setInviting(false);
      setInvite({ email: '', name: '', title: '', role: 'staff_accountant' });
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not invite.', 'bad');
    }
  }
  async function setStatus(u: AdminData['users'][number], status: 'active' | 'disabled', reason = '') {
    try {
      await api(`/admin/users/${u.id}/status`, { body: { status, reason } });
      toast(`${u.name} ${status === 'active' ? 'enabled' : 'disabled'}.`);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not change status.', 'bad');
    } finally {
      setDisabling(null);
    }
  }

  async function resetPassword(u: AdminData['users'][number]) {
    try {
      const r = await api<{ sent: LinkSent }>(`/admin/users/${u.id}/password-reset`, { body: {} });
      setSignIn(null);
      toast(u.status === 'invited' ? `A new invitation link was sent to ${r.sent.to}.` : `A single-use link to choose a new password was sent to ${r.sent.to}. ${u.name} was signed out everywhere.`);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not reset the password.', 'bad');
    }
  }
  async function resetMfa(u: AdminData['users'][number], reason: string) {
    try {
      await api(`/admin/users/${u.id}/mfa-reset`, { body: { reason } });
      toast(`Two-factor authentication reset for ${u.name}. They were signed out everywhere.`);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not reset two-factor authentication.', 'bad');
    } finally {
      setResettingMfa(null);
    }
  }

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>People</h2>
          {data.canManage.users ? (
            <span className="right">
              <button className="btn small" onClick={() => setInviting(true)}>
                <UserPlus className="icon" aria-hidden="true" /> Invite
              </button>
            </span>
          ) : null}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Roles</th>
                <th scope="col">Two-factor</th>
                <th scope="col" className="hide-sm">
                  Last sign-in
                </th>
                <th scope="col">Status</th>
                {data.canManage.users ? <th scope="col"><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                      <Avatar name={u.name} />
                      <div>
                        <div>{u.name}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {u.title ?? ''} · {u.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {u.roles.map((r) => (
                        <Badge key={r} icon={false}>
                          {ROLE_LABEL[r] ?? r}
                        </Badge>
                      ))}
                      {u.scope ? (
                        <Badge tone="info" icon={false} title="Entity scope: this person sees and acts on these entities only">
                          Only {u.scope.join(', ')}
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  <td>{u.mfa ? <Badge tone="good">On</Badge> : <Badge tone="warn">Off</Badge>}</td>
                  <td className="hide-sm">{u.lastLoginAt ? dateTime(u.lastLoginAt) : <span className="muted">never</span>}</td>
                  <td>{u.status === 'active' ? <Badge tone="good">Active</Badge> : u.status === 'invited' ? <Badge tone="info" title="Has not chosen a password yet">Invited</Badge> : <Badge tone="bad">{u.status}</Badge>}</td>
                  {data.canManage.users ? (
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      {u.id === me.user.id ? (
                        // nobody changes their own roles, sign-in or status (segregation of duties)
                        <span className="muted" style={{ fontSize: 13 }}>
                          You
                        </span>
                      ) : (
                        <>
                          <button
                            className="btn ghost small"
                            onClick={() => {
                              setEditing(u);
                              setRoles(u.roles);
                              setScope(u.scope ? legal.filter((e) => u.scope!.includes(e.code)).map((e) => e.id) : null);
                              setWhy('');
                            }}
                          >
                            Roles
                          </button>
                          <button className="btn ghost small" onClick={() => setSignIn(u)}>
                            Sign-in
                          </button>
                          {u.status === 'active' ? (
                            <button className="btn ghost small" onClick={() => setDisabling(u)}>
                              Disable
                            </button>
                          ) : (
                            <button className="btn ghost small" onClick={() => void setStatus(u, 'active')}>
                              Enable
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Roles</h2>
          <span className="right muted" style={{ fontSize: 13 }}>
            <span>
              Approval limits apply to journal entries in USD at the closing rate (<a href="#/ontology?axiom=AX-SOD-04">AX-SOD-04</a>).
            </span>
          </span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col" className="r">
                  Approval limit
                </th>
                <th scope="col">Can do</th>
              </tr>
            </thead>
            <tbody>
              {data.roles.map((r) => (
                <tr key={r.key}>
                  <td>
                    <strong>{r.name}</strong>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {r.description}
                    </div>
                  </td>
                  <td className="r">{r.approvalLimitMinor === null ? <span className="muted">No limit</span> : r.approvalLimitMinor === 0 ? <span className="muted">Cannot approve</span> : <Money minor={r.approvalLimitMinor} />}</td>
                  <td>
                    <details>
                      <summary>{r.permissions.length} permissions</summary>
                      <div className="mono" style={{ fontSize: 12, lineHeight: 1.7 }}>
                        {r.permissions.join(' · ')}
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`Roles for ${editing?.name ?? ''}`}
        actions={
          <>
            <button className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={!roles.length || (scope !== null && !scope.length)} onClick={() => void saveRoles()}>
              Save roles
            </button>
          </>
        }
      >
        <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
          Combinations that break segregation of duties (for example, preparing and approving journal entries without limits) are refused. Approval authority the person does not hold yet (approving entries, reconciliations, variances or payments, signing off or locking the close, or setting agent autonomy) takes effect once a second person approves it.
        </p>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Roles</legend>
          {data.roles.map((r) => (
            <label key={r.key} className="row" style={{ gap: 8, padding: '4px 0' }}>
              <input type="checkbox" checked={roles.includes(r.key)} onChange={(e) => setRoles((x) => (e.target.checked ? [...x, r.key] : x.filter((y) => y !== r.key)))} />
              {r.name}
            </label>
          ))}
        </fieldset>
        <fieldset style={{ border: 0, padding: 0, margin: '14px 0 0' }}>
          <legend style={{ fontWeight: 600, padding: 0 }}>Entities</legend>
          <p className="muted" style={{ margin: '2px 0 6px', fontSize: 13 }}>
            Limit these roles to some entities: the person then sees and acts on those entities only, and group-wide work (consolidation, the close package, locking the period) is left to people with access to every entity.
          </p>
          <label className="row" style={{ gap: 8, padding: '4px 0' }}>
            <input type="radio" name="entity-scope" checked={scope === null} onChange={() => setScope(null)} />
            Every entity
          </label>
          <label className="row" style={{ gap: 8, padding: '4px 0' }}>
            <input type="radio" name="entity-scope" checked={scope !== null} onChange={() => setScope(legal.slice(0, 1).map((e) => e.id))} />
            Only these entities
          </label>
          {scope !== null ? (
            <div style={{ paddingLeft: 26 }}>
              {legal.map((e) => (
                <label key={e.id} className="row" style={{ gap: 8, padding: '4px 0' }}>
                  <input type="checkbox" checked={scope.includes(e.id)} onChange={(ev) => setScope((x) => (ev.target.checked ? [...(x ?? []), e.id] : (x ?? []).filter((y) => y !== e.id)))} />
                  {e.code} · {e.name}
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>
        <label className="field" style={{ marginTop: 14 }}>
          Why (shown to the person who approves new authority)
          <input value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} placeholder="For example: covering for Jordan during the October close" />
        </label>
      </Dialog>

      <Dialog
        open={inviting}
        onClose={() => setInviting(false)}
        title="Invite a person"
        actions={
          <>
            <button className="btn" onClick={() => setInviting(false)}>
              Cancel
            </button>
            <button className="btn primary" disabled={!invite.email || !invite.name} onClick={() => void sendInvite()}>
              Invite
            </button>
          </>
        }
      >
        <div className="stack">
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            They receive a link to choose their own password; it works once and expires after 72 hours. A role with approval authority starts once a second person approves it.
          </p>
          <label className="field">
            Email
            <input type="email" autoComplete="off" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
          </label>
          <label className="field">
            Name
            <input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
          </label>
          <label className="field">
            Title (optional)
            <input value={invite.title} onChange={(e) => setInvite({ ...invite, title: e.target.value })} />
          </label>
          <label className="field">
            Role
            <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              {data.roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Dialog>

      <Dialog
        open={!!signIn}
        onClose={() => setSignIn(null)}
        title={`Sign-in help for ${signIn?.name ?? ''}`}
        actions={
          <button className="btn" onClick={() => setSignIn(null)}>
            Close
          </button>
        }
      >
        <div className="stack">
          {signIn?.status === 'invited' ? (
            <div className="stack" style={{ gap: 6 }}>
              <strong>Invitation not accepted yet</strong>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                Sends {signIn.name} a new invitation link; earlier links stop working. You never see the link.
              </p>
              <div>
                <button className="btn" onClick={() => void resetPassword(signIn)}>
                  Send a new invitation link
                </button>
              </div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              <strong>Forgotten password</strong>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                Their current password stops working, they are signed out everywhere, and they receive a single-use link to choose a new one (valid for 24 hours). You never see the link or a password.
              </p>
              <div>
                <button className="btn" onClick={() => signIn && void resetPassword(signIn)}>
                  Send a password-reset link
                </button>
              </div>
            </div>
          )}
          <div className="stack" style={{ gap: 6 }}>
            <strong>Lost authenticator</strong>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              {signIn?.mfa
                ? 'Removes their two-factor set-up and recovery codes and signs them out everywhere; they set it up again at their next sign-in. Check their identity first, outside Tieout.'
                : 'Two-factor authentication is not on for this person.'}
            </p>
            <div>
              <button
                className="btn danger"
                aria-disabled={!signIn?.mfa}
                onClick={() => {
                  if (!signIn?.mfa) return;
                  setResettingMfa(signIn);
                  setSignIn(null);
                }}
              >
                Reset two-factor
              </button>
            </div>
          </div>
        </div>
      </Dialog>

      <ReasonDialog
        open={!!resettingMfa}
        title={`Reset two-factor for ${resettingMfa?.name ?? ''}?`}
        label="How did you confirm it is really them? (for the audit log)"
        min={10}
        confirm="Reset two-factor"
        onCancel={() => setResettingMfa(null)}
        onConfirm={(reason) => resettingMfa && void resetMfa(resettingMfa, reason)}
      />

      <ReasonDialog
        open={!!disabling}
        title={`Disable ${disabling?.name ?? ''}?`}
        label="They are signed out everywhere and cannot sign in. Reason (for the audit log)"
        confirm="Disable account"
        onCancel={() => setDisabling(null)}
        onConfirm={(reason) => disabling && void setStatus(disabling, 'disabled', reason)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ SoD controls
function Controls({ data }: { data: AdminData }) {
  const { toast, bump } = useApp();
  const [toggling, setToggling] = useState<AdminData['sod'][number] | null>(null);
  async function toggle(code: string, enabled: boolean, reason: string) {
    try {
      const r = await api<{ pending: { ref: string } }>(`/admin/sod/${encodeURIComponent(code)}`, { body: { enabled, reason } });
      toast(`Requested: turning ${code} ${enabled ? 'on' : 'off'} waits for a second person to approve it (${r.pending.ref}, under Access requests).`);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not change the control.', 'bad');
    } finally {
      setToggling(null);
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <Term id="tie:SegregationOfDuties">Segregation of duties</Term>
        </h2>
        <span className="right muted" style={{ fontSize: 13 }}>
          Enforced by the app and, for maker-checker, by a database trigger as well. A change takes effect once a second person approves it.
        </span>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Control</th>
              <th scope="col">Effect</th>
              <th scope="col">Status</th>
              {data.canManage.sod ? <th scope="col"><span className="sr-only">Actions</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {data.sod.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>
                    <span className="mono">{r.code}</span> {r.name}
                  </strong>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {r.description}
                  </div>
                </td>
                <td>{r.severity === 'block' ? <Badge tone="bad">Blocks</Badge> : <Badge tone="warn">Warns</Badge>}</td>
                <td>{r.enabled ? <Badge tone="good">On</Badge> : <Badge tone="bad">Off</Badge>}</td>
                {data.canManage.sod ? (
                  <td className="r">
                    <button className="btn ghost small" onClick={() => setToggling(r)}>
                      {r.enabled ? 'Turn off' : 'Turn on'}
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ReasonDialog
        open={!!toggling}
        title={toggling?.enabled ? `Turn off ${toggling.code}?` : `Turn on ${toggling?.code ?? ''}?`}
        label="Documented reason (at least 10 characters; the approver and auditors will read this)"
        min={10}
        confirm={toggling?.enabled ? 'Request to turn off' : 'Request to turn on'}
        tone={toggling?.enabled ? 'danger' : 'primary'}
        onCancel={() => setToggling(null)}
        onConfirm={(reason) => toggling && void toggle(toggling.code, !toggling.enabled, reason)}
      />
    </section>
  );
}

// ------------------------------------------------------------------ access requests (two people)
const REQUEST_STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  pending: { label: 'Waiting', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  rejected: { label: 'Rejected', tone: 'bad' },
  cancelled: { label: 'Withdrawn', tone: 'neutral' },
  superseded: { label: 'Replaced', tone: 'neutral' },
};

function Requests() {
  const { toast, bump, version } = useApp();
  const { data, error, reload } = useData(() => api<AccessRequests>('/access-requests'), [version]);
  const [approving, setApproving] = useState<AccessRequest | null>(null);
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState<AccessRequest | null>(null);
  async function decide(r: AccessRequest, action: 'approve' | 'reject' | 'cancel', body: Record<string, string> = {}) {
    try {
      await api(`/access-requests/${r.id}/${action}`, { body });
      toast(action === 'approve' ? `${r.ref} approved: ${r.summary}. It applies now.` : action === 'reject' ? `${r.ref} rejected. Nothing changed.` : `${r.ref} withdrawn.`);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not record the decision.', 'bad');
    } finally {
      setApproving(null);
      setRejecting(null);
    }
  }
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Access requests</h2>
        <span className="right muted" style={{ fontSize: 13 }}>
          New approval authority and changes to SoD controls need a second person: never the requester or the person who gains access, and someone whose own authority covers it.
        </span>
      </div>
      {data.items.length === 0 ? (
        <Empty title="No access requests">When someone asks to give a person approval authority, or to change a control, it waits here for a second person.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Asked by</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>
                      <span className="mono">{r.ref}</span> {r.summary}
                    </strong>
                    <div className="muted" style={{ fontSize: 13 }}>
                      Why: {r.reason}
                    </div>
                    {r.status === 'pending' && !r.canDecide && r.blockedBy.length ? (
                      <div className="muted" style={{ fontSize: 13 }}>
                        You cannot decide this: {r.blockedBy.join(' ')}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {r.requestedBy}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {dateTime(r.requestedAt)}
                    </div>
                  </td>
                  <td>
                    <Badge tone={REQUEST_STATUS[r.status]?.tone ?? 'neutral'}>{REQUEST_STATUS[r.status]?.label ?? r.status}</Badge>
                    {r.decidedBy ? (
                      <div className="muted" style={{ fontSize: 12 }}>
                        by {r.decidedBy}
                        {r.note ? `: ${r.note}` : ''}
                      </div>
                    ) : null}
                  </td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    {r.canDecide ? (
                      <>
                        <button
                          className="btn primary small"
                          onClick={() => {
                            setNote('');
                            setApproving(r);
                          }}
                        >
                          Approve<span className="sr-only"> {r.ref}</span>
                        </button>{' '}
                        <button className="btn ghost small" onClick={() => setRejecting(r)}>
                          Reject<span className="sr-only"> {r.ref}</span>
                        </button>
                      </>
                    ) : null}
                    {r.canCancel ? (
                      <button className="btn ghost small" onClick={() => void decide(r, 'cancel')}>
                        Withdraw<span className="sr-only"> {r.ref}</span>
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={!!approving}
        onClose={() => setApproving(null)}
        title={`Approve ${approving?.ref ?? ''}?`}
        actions={
          <>
            <button className="btn" onClick={() => setApproving(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => approving && void decide(approving, 'approve', { note })}>
              Approve and apply
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          <strong>{approving?.summary}</strong>
        </p>
        <p className="muted" style={{ fontSize: 14 }}>
          Asked by {approving?.requestedBy}. Why: {approving?.reason}
        </p>
        <label className="field">
          Note for the audit log (optional)
          <input data-autofocus value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="For example: confirmed with the board minutes" />
        </label>
      </Dialog>
      <ReasonDialog
        open={!!rejecting}
        title={`Reject ${rejecting?.ref ?? ''}?`}
        label="Why (the requester and auditors will read this)"
        min={5}
        confirm="Reject request"
        onCancel={() => setRejecting(null)}
        onConfirm={(reason) => rejecting && void decide(rejecting, 'reject', { reason })}
      />
    </section>
  );
}

// ------------------------------------------------------------------ security settings
function Security({ data }: { data: AdminData }) {
  const { toast, bump } = useApp();
  const s = data.settings;
  const [mfaRoles, setMfaRoles] = useState<string[]>(s.mfaRequiredRoles ?? []);
  const [idle, setIdle] = useState(String(s.sessionIdleMinutes ?? 30));
  const [abs, setAbs] = useState(String(s.sessionAbsoluteHours ?? 12));
  useEffect(() => {
    setMfaRoles(s.mfaRequiredRoles ?? []);
  }, [s.mfaRequiredRoles]);
  const editable = data.canManage.settings;
  async function save() {
    try {
      await api('/admin/settings', { body: { mfaRequiredRoles: mfaRoles, sessionIdleMinutes: Number(idle), sessionAbsoluteHours: Number(abs) } });
      toast('Security settings saved.');
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save.', 'bad');
    }
  }
  return (
    <div className="grid cols-2">
      <section className="card card-pad stack">
        <h2 style={{ margin: 0 }}>Two-factor authentication</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          People in these roles must set up an authenticator app (TOTP) and enter a code at every sign-in.
        </p>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={!editable}>
          <legend className="sr-only">Roles that require two-factor</legend>
          {data.roles.map((r) => (
            <label key={r.key} className="row" style={{ gap: 8, padding: '3px 0' }}>
              <input type="checkbox" checked={mfaRoles.includes(r.key)} onChange={(e) => setMfaRoles((x) => (e.target.checked ? [...x, r.key] : x.filter((y) => y !== r.key)))} />
              {r.name}
            </label>
          ))}
        </fieldset>
      </section>
      <section className="card card-pad stack">
        <h2 style={{ margin: 0 }}>Sessions</h2>
        <label className="field">
          Sign out after inactivity (minutes)
          <input type="number" min={5} max={240} value={idle} disabled={!editable} onChange={(e) => setIdle(e.target.value)} />
        </label>
        <label className="field">
          Maximum session length (hours)
          <input type="number" min={1} max={24} value={abs} disabled={!editable} onChange={(e) => setAbs(e.target.value)} />
        </label>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Session cookies are HttpOnly, SameSite=Strict and Secure in production; only a hash of the token is stored. Every change request also needs a CSRF token.
        </p>
      </section>
      {editable ? (
        <div>
          <button className="btn primary" onClick={() => void save()}>
            Save security settings
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ materiality
function Materiality({ data }: { data: AdminData }) {
  const legal = data.entities.filter((e) => e.kind === 'legal');
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        <Term id="tie:Materiality">Materiality</Term> drives what agents may post on their own, which variances need an explanation, and what escalates. Clearly trivial ≤ performance ≤ overall (<a href="#/ontology?axiom=AX-MAT-01">AX-MAT-01</a>).
      </p>
      <div className="grid cols-2">
        {legal.map((e) => (
          <MaterialityCard key={e.id} entity={e} editable={data.canManage.settings} />
        ))}
      </div>
    </div>
  );
}

function MaterialityCard({ entity, editable }: { entity: AdminData['entities'][number]; editable: boolean }) {
  const { toast, bump } = useApp();
  const m = entity.materiality;
  const toMajor = (v: number) => String(Math.round(v / 100));
  const [form, setForm] = useState({ overall: toMajor(m.overallMinor), performance: toMajor(m.performanceMinor), trivial: toMajor(m.clearlyTrivialMinor), fluxAbs: toMajor(m.fluxAbsMinor), fluxPct: String(Math.round(m.fluxPct * 100)) });
  async function save() {
    try {
      await api(`/admin/entities/${entity.id}/materiality`, {
        body: { overallMinor: Number(form.overall) * 100, performanceMinor: Number(form.performance) * 100, clearlyTrivialMinor: Number(form.trivial) * 100, fluxAbsMinor: Number(form.fluxAbs) * 100, fluxPct: Number(form.fluxPct) / 100 },
      });
      toast(`${entity.code} materiality saved.`);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save.', 'bad');
    }
  }
  const field = (k: keyof typeof form, label: string, suffix?: string) => (
    <label className="field">
      {label}
      <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        {suffix ? null : <span className="muted">{entity.currency}</span>}
        <input type="number" min={0} value={form[k]} disabled={!editable} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
        {suffix ? <span className="muted">{suffix}</span> : null}
      </span>
    </label>
  );
  return (
    <section className="card card-pad stack" aria-label={`${entity.code} materiality`}>
      <h2 style={{ margin: 0 }}>
        {entity.code} · {entity.name}
      </h2>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {m.rationale}
      </p>
      <div className="grid cols-2">
        {field('overall', 'Overall materiality')}
        {field('performance', 'Performance materiality')}
        {field('trivial', 'Clearly trivial')}
        {field('fluxAbs', 'Flux: minimum change')}
        {field('fluxPct', 'Flux: minimum change', '%')}
      </div>
      {editable ? (
        <div>
          <button className="btn primary" onClick={() => void save()}>
            Save {entity.code}
          </button>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ my account
function Account({ data }: { data: AdminData }) {
  const me = useMe();
  const { toast, bump, refresh } = useApp();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [enrol, setEnrol] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [tokenName, setTokenName] = useState('Claude Desktop (MCP)');
  const [newToken, setNewToken] = useState<string | null>(null);

  async function changePw() {
    try {
      await api('/auth/password', { body: pw });
      toast('Password changed. Other sessions were signed out.');
      setPw({ current: '', next: '' });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not change the password.', 'bad');
    }
  }
  async function startMfa() {
    try {
      setEnrol(await api<{ secret: string; otpauth: string }>('/auth/mfa/enroll', { body: {} }));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not start set-up.', 'bad');
    }
  }
  async function verifyMfa() {
    try {
      const r = await api<{ csrfToken: string; recoveryCodes: string[] | null }>('/auth/mfa/verify', { body: { code } });
      setCsrf(r.csrfToken);
      setEnrol(null);
      setCode('');
      setCodes(r.recoveryCodes);
      toast('Two-factor authentication is on.');
      await refresh();
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'That code did not work.', 'bad');
    }
  }
  async function newCodes() {
    try {
      setCodes((await api<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { body: {} })).recoveryCodes);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not issue recovery codes.', 'bad');
    }
  }
  async function createToken() {
    try {
      const r = await api<{ token: string }>('/auth/tokens', { body: { name: tokenName, days: 30 } });
      setNewToken(r.token);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not create a token.', 'bad');
    }
  }
  async function revoke(id: string) {
    try {
      await api(`/auth/tokens/${id}`, { method: 'DELETE' });
      toast('Token revoked.');
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not revoke.', 'bad');
    }
  }

  return (
    <div className="grid cols-2">
      <section className="card card-pad stack" aria-labelledby="mfa-h">
        <h2 id="mfa-h" style={{ margin: 0 }}>
          <ShieldCheck className="icon" aria-hidden="true" /> Two-factor authentication
        </h2>
        {me.user.mfaEnabled ? (
          <div className="stack">
            <p style={{ margin: 0 }}>
              <Badge tone="good">On</Badge> You enter a code from your authenticator app at sign-in.
            </p>
            {codes ? (
              <RecoveryCodes codes={codes} account={me.user.email} />
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                {data.account.recoveryCodesLeft} unused recovery code{data.account.recoveryCodesLeft === 1 ? '' : 's'} for when you lose your authenticator.
              </p>
            )}
            <div>
              <button className="btn" onClick={() => void newCodes()}>
                New recovery codes
              </button>
            </div>
          </div>
        ) : enrol ? (
          <div className="stack">
            <p style={{ margin: 0 }}>Add this key to your authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.</p>
            <p className="mono" style={{ fontSize: 18, letterSpacing: 1, userSelect: 'all', margin: 0 }} aria-label="Setup key">
              {enrol.secret.match(/.{1,4}/g)?.join(' ')}
            </p>
            <details>
              <summary>Setup link (otpauth)</summary>
              <p className="mono" style={{ fontSize: 12, wordBreak: 'break-all', userSelect: 'all' }}>
                {enrol.otpauth}
              </p>
            </details>
            <label className="field">
              Code
              <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </label>
            <div>
              <button className="btn primary" disabled={code.length !== 6} onClick={() => void verifyMfa()}>
                Turn on
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <p style={{ margin: 0 }}>
              <Badge tone="warn">Off</Badge> {data.settings.mfaRequiredRoles?.some((r) => me.user.roles.includes(r)) ? 'Your role requires it.' : 'Recommended for everyone who approves entries.'}
            </p>
            <div>
              <button className="btn primary" onClick={() => void startMfa()}>
                Set up
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card card-pad stack" aria-labelledby="pw-h">
        <h2 id="pw-h" style={{ margin: 0 }}>
          <KeyRound className="icon" aria-hidden="true" /> Password
        </h2>
        <label className="field">
          Current password
          <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        </label>
        <label className="field">
          New password
          <input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} aria-describedby="pw-hint" />
          <span className="hint" id="pw-hint">
            At least 12 characters. A long passphrase is best.
          </span>
        </label>
        <div>
          <button className="btn" disabled={!pw.current || pw.next.length < 12} onClick={() => void changePw()}>
            Change password
          </button>
        </div>
      </section>

      {data.canManage.tokens || can(me, 'mcp.token') ? (
        <section className="card card-pad stack" aria-labelledby="tok-h" style={{ gridColumn: '1 / -1' }}>
          <h2 id="tok-h" style={{ margin: 0 }}>
            API tokens for the MCP server
          </h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Connect Claude or another MCP client to Tieout. Tokens can read and start agent runs; they cannot approve, post or change settings. Shown once, stored as a hash, expire after 30 days.
          </p>
          <div className="row">
            <label className="field" style={{ minWidth: 260 }}>
              Token name
              <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} maxLength={80} />
            </label>
            <button className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={!tokenName.trim()} onClick={() => void createToken()}>
              <Plus className="icon" aria-hidden="true" /> Create token
            </button>
          </div>
          {newToken ? (
            <div className="callout good" role="status">
              <div>
                <strong>Copy this token now. It will not be shown again.</strong>
                <p className="mono" style={{ wordBreak: 'break-all', userSelect: 'all', margin: '6px 0 0' }}>
                  {newToken}
                </p>
              </div>
            </div>
          ) : null}
          {data.tokens.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Created</th>
                    <th scope="col">Expires</th>
                    <th scope="col">Last used</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.tokens.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td>{dateTime(t.createdAt)}</td>
                      <td>{dateTime(t.expiresAt)}</td>
                      <td>{t.lastUsedAt ? dateTime(t.lastUsedAt) : <span className="muted">never</span>}</td>
                      <td className="r">
                        {t.revoked ? (
                          <Badge>Revoked</Badge>
                        ) : (
                          <button className="btn ghost small" onClick={() => void revoke(t.id)}>
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

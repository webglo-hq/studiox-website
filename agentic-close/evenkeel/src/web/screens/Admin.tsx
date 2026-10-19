import { FileUp, KeyRound, Plug, ShieldCheck, UserCog } from 'lucide-react';
import { useState } from 'react';
import type { MethodOutput } from '../../app/methods';
import { useAction, useApi } from '../lib/api';
import { humanize, money, plural, ROLE_LABEL, when } from '../lib/format';
import { setQuery, type Route } from '../lib/router';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Dialog, Field, Notice, PageHead, Query, Status, Tabs } from '../ui/kit';
import { Term } from '../ui/term';

type User = MethodOutput<'admin.users'>[number];
type Tab = 'users' | 'roles' | 'sod' | 'settings' | 'connectors';

export function Admin({ route }: { route: Route }) {
  const { can } = useSession();
  const tabs: { value: Tab; label: string }[] = [
    ...(can('admin.users') ? [{ value: 'users' as const, label: 'People' }] : []),
    { value: 'roles', label: 'Roles' },
    { value: 'sod', label: 'Segregation of duties' },
    { value: 'settings', label: 'Close settings' },
    { value: 'connectors', label: 'Connectors' },
  ];
  const tab = (route.query.get('tab') as Tab | null) ?? tabs[0]!.value;
  return (
    <div className="page">
      <PageHead eyebrow="Administration" title="Access, controls and settings" sub="Who can do what, the segregation-of-duties rules the system enforces, materiality and the systems Evenkeel imports from. Every change here is audited." />
      <Tabs label="Admin sections" value={tab} onChange={(v) => setQuery(route, 'tab', v)} items={tabs} />
      {tab === 'users' && <Users />}
      {tab === 'roles' && <Roles />}
      {tab === 'sod' && <SodRules />}
      {tab === 'settings' && <Settings />}
      {tab === 'connectors' && <Connectors />}
    </div>
  );
}

/** "All entities" or the entity codes a person's roles are limited to. */
function entityLabel(access: User['entities']): string {
  return access === 'all' ? 'All entities' : access.join(', ');
}

function RolesDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const roles = useApi('admin.roles', {});
  const ref = useApi('journals.reference', {});
  const [sel, setSel] = useState<Set<string>>(new Set(user.roles));
  const [allEntities, setAllEntities] = useState(user.entities === 'all');
  const [ents, setEnts] = useState<Set<string>>(new Set(user.entities === 'all' ? [] : user.entities));
  const save = useAction('admin.setRoles', { success: `Roles updated for ${user.name}. Their sessions were signed out so the change applies now.`, onSuccess: onClose });
  const pick = (set: (fn: (s: Set<string>) => Set<string>) => void, v: string) =>
    set((s) => {
      const n = new Set(s);
      if (n.has(v)) n.delete(v);
      else n.add(v);
      return n;
    });
  return (
    <Dialog
      title={`Roles for ${user.name}`}
      description="Combinations that break a blocking segregation-of-duties rule are refused. Limiting someone to some entities hides the other entities, consolidated figures, the close package and the audit log from them."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={!allEntities && ents.size === 0} onClick={() => save.mutate({ userId: user.id, roles: [...sel], entities: allEntities ? 'all' : [...ents] })}>
            Save roles
          </Button>
        </>
      }
    >
      <Query q={roles} rows={6}>
        {(r) => (
          <div className="stack" style={{ gap: 6 }}>
            {r.roles.map((role) => (
              <label key={role.code} className="panel row" style={{ alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="checkbox" checked={sel.has(role.code)} onChange={() => pick(setSel, role.code)} style={{ width: 18, height: 18, marginTop: 2 }} />
                <span className="stack" style={{ gap: 2 }}>
                  <strong className="small">{role.name}</strong>
                  <span className="xs ink2">{role.description}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </Query>
      <fieldset className="stack" style={{ border: 0, margin: '14px 0 0', padding: 0, gap: 6 }}>
        <legend className="small strong" style={{ marginBottom: 6 }}>
          Entities these roles cover
        </legend>
        <label className="row" style={{ cursor: 'pointer' }}>
          <input type="radio" name="entity-scope" checked={allEntities} onChange={() => setAllEntities(true)} style={{ accentColor: 'var(--accent)' }} />
          <span className="small">All entities</span>
        </label>
        <label className="row" style={{ cursor: 'pointer' }}>
          <input type="radio" name="entity-scope" checked={!allEntities} onChange={() => setAllEntities(false)} style={{ accentColor: 'var(--accent)' }} />
          <span className="small">Only these entities</span>
        </label>
        {!allEntities && (
          <Query q={ref} rows={2}>
            {(r) => (
              <div className="row-wrap" style={{ paddingLeft: 26 }}>
                {r.entities.map((e) => (
                  <label key={e.code} className="row small" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={ents.has(e.code)} onChange={() => pick(setEnts, e.code)} style={{ width: 18, height: 18 }} />
                    {e.name} ({e.code})
                  </label>
                ))}
              </div>
            )}
          </Query>
        )}
      </fieldset>
    </Dialog>
  );
}

function Users() {
  const { info } = useSession();
  const q = useApi('admin.users', {});
  const [editing, setEditing] = useState<User | null>(null);
  const status = useAction('admin.setStatus', { success: (_o, i) => (i.status === 'disabled' ? 'User disabled and signed out.' : 'User enabled.') });
  return (
    <Card flush>
      <Query q={q} rows={8}>
        {(users) => (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="first" scope="col">
                    Person
                  </th>
                  <th scope="col">Roles</th>
                  <th scope="col">Entities</th>
                  <th scope="col">Security</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col" className="last">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="first" style={{ minWidth: 220 }}>
                      <div className="strong small">{u.name}</div>
                      <div className="xs muted">
                        {u.title} · {u.email}
                      </div>
                    </td>
                    <td>
                      <div className="row-wrap">
                        {u.roles.map((r) => (
                          <Badge key={r}>{ROLE_LABEL[r] ?? r}</Badge>
                        ))}
                      </div>
                      {u.conflicts.length > 0 && <div className="xs diff-bad">{u.conflicts.map((c) => `${c.rule} ${c.name}`).join(', ')}</div>}
                    </td>
                    <td className="small nowrap">{entityLabel(u.entities)}</td>
                    <td className="small">
                      <div className="row-wrap">
                        <Status value={u.status === 'active' ? 'ok' : 'blocked'} label={humanize(u.status)} />
                        {u.mfaEnabled ? <Badge tone="good">2-step on</Badge> : <Badge>2-step off</Badge>}
                        {u.lockedUntil && u.lockedUntil > new Date().toISOString() && <Badge tone="bad">locked</Badge>}
                      </div>
                    </td>
                    <td className="small nowrap">{when(u.lastLoginAt)}</td>
                    <td className="last">
                      {u.id !== info.user.id && (
                        <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                          <Button size="s" icon={<UserCog size={14} aria-hidden />} onClick={() => setEditing(u)}>
                            Roles
                          </Button>
                          <Button size="s" variant="quiet" busy={status.isPending} onClick={() => status.mutate({ userId: u.id, status: u.status === 'active' ? 'disabled' : 'active' })}>
                            {u.status === 'active' ? 'Disable' : 'Enable'}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Query>
      {editing && <RolesDialog user={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function Roles() {
  const q = useApi('admin.roles', {});
  return (
    <Query q={q} rows={8}>
      {(r) => (
        <Card title="Permissions by role" hint={<Term id="ek:Role">Roles</Term>} flush>
          {/* Wide matrix: focusable so keyboard users can scroll it (WCAG 2.1.1). */}
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Permissions by role">
            <table className="table">
              <thead>
                <tr>
                  <th className="first" scope="col">
                    Permission
                  </th>
                  {r.roles.map((role) => (
                    <th key={role.code} scope="col" style={{ textAlign: 'center' }}>
                      {role.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.permissions.map((p) => (
                  <tr key={p.code}>
                    <td className="first small" style={{ minWidth: 260 }}>
                      <span className="mono xs">{p.code}</span>
                      <div className="xs muted">{p.description}</div>
                    </td>
                    {r.roles.map((role) => (
                      <td key={role.code} style={{ textAlign: 'center' }} aria-label={role.permissions.includes(p.code) ? 'yes' : 'no'}>
                        {role.permissions.includes(p.code) ? <span className="diff-ok strong">✓</span> : <span className="muted">·</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Query>
  );
}

function SodRules() {
  const { can } = useSession();
  const q = useApi('admin.sodRules', {});
  const [toggling, setToggling] = useState<{ code: string; enabled: boolean } | null>(null);
  const [note, setNote] = useState('');
  const save = useAction('admin.setSodRule', { success: 'Rule updated.', onSuccess: () => (setToggling(null), setNote('')) });
  return (
    <>
      <Notice tone="info">
        <Term id="ek:SegregationOfDuties">Segregation of duties</Term> is enforced in the database and the service layer, not only on screen: SOD-01, SOD-02 and SOD-05 are core <Term id="ek:MakerChecker">maker-checker</Term> controls and cannot be switched off.
      </Notice>
      <Card flush>
        <Query q={q} rows={6}>
          {(rules) => (
            <div className="list">
              {rules.map((r) => (
                <div key={r.code} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <ShieldCheck size={18} aria-hidden color={r.enabled ? 'var(--good)' : 'var(--muted)'} style={{ marginTop: 2 }} />
                  <span className="grow stack" style={{ gap: 2 }}>
                    <strong className="small">
                      <span className="mono">{r.code}</span> {r.name}
                    </strong>
                    <span className="xs ink2">{r.description}</span>
                    <span className="xs muted">
                      {humanize(r.kind)} · {r.severity === 'block' ? 'blocks the action' : 'warns'}
                    </span>
                  </span>
                  <Status value={r.enabled ? 'ok' : 'dismissed'} label={r.enabled ? 'On' : 'Off'} />
                  {can('admin.sod') && !['SOD-01', 'SOD-02', 'SOD-05'].includes(r.code) && (
                    <Button size="s" onClick={() => setToggling({ code: r.code, enabled: !r.enabled })}>
                      {r.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Query>
      </Card>
      {toggling && (
        <Dialog
          title={`${toggling.enabled ? 'Turn on' : 'Turn off'} ${toggling.code}`}
          onClose={() => setToggling(null)}
          footer={
            <>
              <Button onClick={() => setToggling(null)}>Cancel</Button>
              <Button variant="primary" disabled={note.trim().length < 5} busy={save.isPending} onClick={() => save.mutate({ code: toggling.code, enabled: toggling.enabled, note })}>
                Save
              </Button>
            </>
          }
        >
          <Field label="Reason (audited)" htmlFor="sod-note">
            <input id="sod-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-autofocus />
          </Field>
        </Dialog>
      )}
    </>
  );
}

type SettingsData = MethodOutput<'admin.settings'>;

const settingsForm = (s: SettingsData) => ({
  overall: String(s.materiality.overall / 100),
  performance: String(s.materiality.performance / 100),
  trivial: String(s.materiality.clearlyTrivial / 100),
  cap: String(s.capitalizationThreshold / 100),
  prepaid: String(s.prepaidThreshold / 100),
  autoContinue: s.autoContinue,
});

function Settings() {
  const q = useApi('admin.settings', {});
  // Keyed by the values in force, so the form starts over whenever the saved settings change.
  return <Query q={q} rows={6}>{(s) => <SettingsForm key={JSON.stringify(settingsForm(s))} s={s} />}</Query>;
}

function SettingsForm({ s }: { s: SettingsData }) {
  const { can } = useSession();
  const [form, setForm] = useState(() => settingsForm(s));
  const [note, setNote] = useState('');
  const save = useAction('admin.updateSettings', { success: 'Settings saved.', onSuccess: () => setNote('') });
  const c = (v: string) => Math.round(Number(v) * 100);
  const editable = can('period.lock');
  return (
        <div className="grid grid-main">
          <Card title={<Term id="ek:Materiality">Materiality</Term>} hint="Drives which agent proposals always need a person, and how variances are judged">
            <div className="stack">
              <div className="grid grid-3">
                <Field label="Overall (USD)" htmlFor="m-overall">
                  <input id="m-overall" className="input num" inputMode="decimal" value={form.overall} onChange={(e) => setForm({ ...form, overall: e.target.value })} readOnly={!editable} />
                </Field>
                <Field label="Performance (USD)" htmlFor="m-perf" help="At or above: controller or CFO approves.">
                  <input id="m-perf" className="input num" inputMode="decimal" value={form.performance} onChange={(e) => setForm({ ...form, performance: e.target.value })} readOnly={!editable} />
                </Field>
                <Field label="Clearly trivial (USD)" htmlFor="m-triv">
                  <input id="m-triv" className="input num" inputMode="decimal" value={form.trivial} onChange={(e) => setForm({ ...form, trivial: e.target.value })} readOnly={!editable} />
                </Field>
                <Field label="Capitalize at or above (USD)" htmlFor="m-cap">
                  <input id="m-cap" className="input num" inputMode="decimal" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} readOnly={!editable} />
                </Field>
                <Field label="Prepaid at or above (USD)" htmlFor="m-pre">
                  <input id="m-pre" className="input num" inputMode="decimal" value={form.prepaid} onChange={(e) => setForm({ ...form, prepaid: e.target.value })} readOnly={!editable} />
                </Field>
              </div>
              <label className="check small">
                <input type="checkbox" checked={form.autoContinue} disabled={!editable} onChange={(e) => setForm({ ...form, autoContinue: e.target.checked })} /> After approvals, start the next ready agents automatically
              </label>
              {editable && (
                <>
                  <Field label="Change note (audited)" htmlFor="m-note">
                    <input id="m-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
                  </Field>
                  <div>
                    <Button
                      variant="primary"
                      disabled={note.trim().length < 5}
                      busy={save.isPending}
                      onClick={() => save.mutate({ materiality: { overall: c(form.overall), performance: c(form.performance), clearlyTrivial: c(form.trivial) }, capitalizationThreshold: c(form.cap), prepaidThreshold: c(form.prepaid), autoContinue: form.autoContinue, note })}
                    >
                      Save settings
                    </Button>
                  </div>
                </>
              )}
            </div>
          </Card>
          <Card title="In force now">
            <div className="stack small">
              <div>Overall {money(s.materiality.overall)} · performance {money(s.materiality.performance)} · clearly trivial {money(s.materiality.clearlyTrivial)}</div>
              <div className="ink2">
                <Term id="AX-MAT-01">AX-MAT-01</Term> requires clearly trivial &lt; performance ≤ overall.
              </div>
              <div>Reporting currency {s.reportingCurrency} · time zone {s.timezone}</div>
              <div>Close target WD+{s.closeTargetWorkday}</div>
            </div>
          </Card>
        </div>
  );
}

function Connectors() {
  const { can } = useSession();
  const q = useApi('integrations.connectors', {});
  const docs = useApi('integrations.documents', { limit: 30 });
  const [uploading, setUploading] = useState<string | null>(null);
  return (
    <>
      <Card title="Connectors" hint="Real parsers for CSV, BAI2, OFX and ISO 20022 camt.053; imports are idempotent and keep the source file" flush>
        <Query q={q} rows={6}>
          {(cs) => (
            <div className="list">
              {cs.map((c) => (
                <div key={c.id} className="list-item">
                  <Plug size={18} aria-hidden className="muted" />
                  <span className="grow stack" style={{ gap: 2 }}>
                    <strong className="small">{c.name}</strong>
                    <span className="xs muted">
                      {c.catalog?.label ?? humanize(c.kind)} · {c.entityCode ?? 'all entities'} · {plural(c.documents, 'file')} · last import {when(c.lastSyncAt)}
                    </span>
                  </span>
                  <Status value={c.status === 'active' ? 'ok' : c.status} label={humanize(c.status)} />
                  {can('integration.import') && c.status === 'active' && (
                    <Button size="s" icon={<FileUp size={14} aria-hidden />} onClick={() => setUploading(c.id)}>
                      Import a file
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Query>
      </Card>
      <Card title="Recent files" flush>
        <Query q={docs} rows={6}>
          {(ds) => (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {ds.map((d) => (
                    <tr key={d.id}>
                      <td className="first small">
                        <a href={`#/documents/${d.id}`}>{d.filename}</a>
                        <div className="xs muted mono">{d.sha256.slice(0, 16)}…</div>
                      </td>
                      <td className="small">{plural(d.records ?? 0, 'record')}</td>
                      <td className="small nowrap">{when(d.receivedAt)}</td>
                      <td className="last">
                        <Status value={d.status === 'parsed' ? 'ok' : d.status} label={humanize(d.status)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Query>
      </Card>
      {uploading && <UploadDialog connectorId={uploading} onClose={() => setUploading(null)} />}
    </>
  );
}

function UploadDialog({ connectorId, onClose }: { connectorId: string; onClose: () => void }) {
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = useAction('integrations.upload', {
    success: (o) => (o.status === 'duplicate_file' ? 'This exact file was already imported; nothing changed.' : `Imported ${plural(o.created, 'new record')}; ${o.duplicates} already present.`),
    onSuccess: onClose,
  });
  return (
    <Dialog
      title="Import a file"
      description="The file is parsed in Evenkeel, stored with its hash and linked to every record it creates. Importing the same file twice creates nothing new."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<KeyRound size={16} aria-hidden />} disabled={!file} busy={upload.isPending} onClick={() => file && upload.mutate({ connectorId, filename: file.name, content: file.content })}>
            Import
          </Button>
        </>
      }
    >
      <Field label="File (CSV, BAI2, OFX, camt.053 XML or JSON, up to 5 MB)" htmlFor="up-file" error={error}>
        <input
          id="up-file"
          className="input"
          type="file"
          accept=".csv,.txt,.bai,.bai2,.ofx,.qfx,.xml,.json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            setError(null);
            if (!f) return setFile(null);
            if (f.size > 5 * 1024 * 1024) return setError('Files are limited to 5 MB.');
            void f.text().then((content) => setFile({ name: f.name, content }));
          }}
        />
      </Field>
    </Dialog>
  );
}

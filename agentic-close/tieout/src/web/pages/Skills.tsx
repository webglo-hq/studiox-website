/**
 * Skill catalog and the policy editor: autonomy (bounded by the manifest), thresholds,
 * plain-English rules compiled and shown back before saving, version history, SKILL.md,
 * allowed tools and the golden eval suite.
 */
import { ArrowLeft, FlaskConical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type SkillDetail, type SkillsCatalog } from '../api';
import { Badge, Dialog, ErrorBox, Loading, Segmented, Term } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { dateTime, titleCase } from '../lib/format';
import { setQuery, useRoute } from '../lib/router';

type Level = 'L0' | 'L1' | 'L2' | 'L3';
const LEVELS: Level[] = ['L0', 'L1', 'L2', 'L3'];
const rank = (l: string) => LEVELS.indexOf(l as Level);
/** claude-opus-5-5 → "Claude Opus 5.5" (provider config keeps the exact model id). */
const modelName = (id: string) => id.replace(/^claude-([a-z]+)-(\d+)-(\d+)$/, (_m, fam: string, a: string, b: string) => `Claude ${fam[0]!.toUpperCase()}${fam.slice(1)} ${a}.${b}`);

export function Skills() {
  const route = useRoute();
  if (route.path[1]) return <SkillPage skillKey={route.path[1]} />;
  return <Catalog />;
}

function Catalog() {
  const { data, error, loading, reload } = useData(() => api<SkillsCatalog>('/skills'), []);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className={loading ? 'skeleton' : undefined}>
      <div className="page-head">
        <div>
          <h1>Skills & policy</h1>
          <p className="lede">
            Each close task is a versioned skill: a SKILL.md procedure with a typed manifest (inputs, outputs, permissions, controls, budgets, model) and a golden eval suite. The Controller sets how much each skill may do on its own, from{' '}
            <Term id="tie:AutonomyLevel">L0 to L3</Term>, never above the manifest’s maximum.
          </p>
        </div>
      </div>
      <div className="grid cols-2">
        {data.items.map((s) => (
          <article key={s.key} className="card card-pad stack" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>
                  <a className="row-link" href={`#/skills/${s.key}`}>
                    {s.title}
                  </a>
                </h2>
                <div className="muted" style={{ fontSize: 13 }}>
                  {titleCase(s.category.replace(/_/g, ' '))} · v{s.version} · {modelName(s.model.live)}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {s.enabled ? <Badge tone="good">On</Badge> : <Badge tone="neutral">Off</Badge>}
                <Badge tone="info" icon={false} title={s.autonomyLabel.description}>
                  {s.autonomy} · {s.autonomyLabel.name}
                </Badge>
              </div>
            </div>
            <p style={{ margin: 0 }}>{s.summary}</p>
            <dl className="kv" style={{ fontSize: 13 }}>
              <dt>Agent runs</dt>
              <dd className="num">{s.stats.runs}</dd>
              <dt>Proposals</dt>
              <dd>
                <span className="num">{s.stats.proposals}</span> · <span className="num">{s.stats.applied}</span> applied ({s.stats.autoApplied} automatically) · <span className="num">{s.stats.rejected}</span> rejected
              </dd>
              <dt>Acceptance</dt>
              <dd className="num">{s.stats.acceptance === null ? '—' : `${Math.round(s.stats.acceptance * 100)}% of decided proposals approved`}</dd>
              <dt>Golden evals</dt>
              <dd>
                {s.lastEval ? (
                  <Badge tone={s.lastEval.passed === s.lastEval.total ? 'good' : 'bad'}>
                    {s.lastEval.passed}/{s.lastEval.total} passed
                  </Badge>
                ) : (
                  <span className="muted">{s.evalCases} cases, not run here yet</span>
                )}
              </dd>
            </dl>
          </article>
        ))}
      </div>
    </div>
  );
}

function SkillPage({ skillKey }: { skillKey: string }) {
  const route = useRoute();
  const tab = (route.query.get('tab') as 'policy' | 'skill' | 'tools' | 'evals' | 'history' | null) ?? 'policy';
  const { data, error, loading, reload } = useData(() => api<SkillDetail>(`/skills/${encodeURIComponent(skillKey)}`), [skillKey]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className={loading ? 'skeleton' : undefined}>
      <a className="btn ghost small" href="#/skills" style={{ marginBottom: 10 }}>
        <ArrowLeft className="icon" aria-hidden="true" /> All skills
      </a>
      <div className="page-head">
        <div>
          <h1>{data.title}</h1>
          <p className="lede">{data.description}</p>
          <div className="muted mono" style={{ fontSize: 12 }}>
            {data.key}@{data.version} · content {data.contentHash.slice(0, 12)}
          </div>
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <Segmented
          label="Section"
          value={tab}
          onChange={(v) => setQuery('tab', v === 'policy' ? null : v)}
          options={[
            { value: 'policy', label: 'Policy' },
            { value: 'skill', label: 'SKILL.md' },
            { value: 'tools', label: 'Tools & controls' },
            { value: 'evals', label: 'Evals' },
            { value: 'history', label: 'History' },
          ]}
        />
      </div>
      {tab === 'policy' ? <Policy data={data} /> : null}
      {tab === 'skill' ? <SkillDoc data={data} /> : null}
      {tab === 'tools' ? <Tools data={data} /> : null}
      {tab === 'evals' ? <Evals data={data} /> : null}
      {tab === 'history' ? <History data={data} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ policy editor
function fmtThreshold(v: number | undefined, unit: string, ccy: string): string {
  if (v === undefined || v === null) return '—';
  if (unit === 'minor') return (v / 100).toLocaleString('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 });
  if (unit === 'pct') return `${v}%`;
  if (unit === 'ratio') return v.toFixed(2);
  if (unit === 'days') return `${v} day${v === 1 ? '' : 's'}`;
  return String(v);
}

function Policy({ data }: { data: SkillDetail }) {
  const me = useMe();
  const { toast, bump } = useApp();
  const global = data.policies.find((p) => !p.scopeEntityId) ?? data.policies[0]!;
  const scoped = data.policies.filter((p) => p.scopeEntityId);
  const canAutonomy = can(me, 'skill.autonomy.set');
  const canEdit = can(me, 'skill.policy.edit');
  const max = data.manifest.autonomy.max;
  const [autonomy, setAutonomy] = useState<Level>(global.autonomy as Level);
  const specs = data.thresholdSpecs;
  const initial = useMemo(() => {
    const o: Record<string, string> = {};
    for (const [k, spec] of Object.entries(specs)) {
      const v = global.thresholds[k];
      o[k] = v === undefined ? '' : spec.unit === 'minor' ? String(v / 100) : String(v);
    }
    return o;
  }, [specs, global]);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [enabled, setEnabled] = useState(global.enabled);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAutonomy(global.autonomy as Level);
    setValues(initial);
    setEnabled(global.enabled);
  }, [global, initial]);

  const changed: Record<string, number> = {};
  for (const [k, spec] of Object.entries(specs)) {
    if (values[k] === initial[k] || values[k] === '') continue;
    const n = Number(values[k]);
    changed[k] = spec.unit === 'minor' ? Math.round(n * 100) : n;
  }
  const dirty = autonomy !== global.autonomy || enabled !== global.enabled || Object.keys(changed).length > 0;

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ version: number }>(`/skills/${data.key}/policy`, {
        body: { autonomy: autonomy !== global.autonomy ? autonomy : undefined, thresholds: Object.keys(changed).length ? changed : undefined, enabled: enabled !== global.enabled ? enabled : undefined, note },
      });
      toast(`Saved as policy version ${r.version}. The change is in the audit log.`);
      setNote('');
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save the policy.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid main-side">
      <div className="stack">
        <section className="card card-pad stack" aria-labelledby="autonomy-h">
          <div>
            <h2 id="autonomy-h" style={{ margin: 0 }}>
              Autonomy
            </h2>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
              The manifest allows up to <strong>{max}</strong>. Whatever the level, maker-checker, approval limits and policy rules still apply, and anything flagged (instruction-like text, control accounts, low confidence) waits for a person.
            </p>
          </div>
          <div role="radiogroup" aria-label="Autonomy level" className="stack" style={{ gap: 8 }}>
            {LEVELS.map((l) => {
              const allowed = rank(l) <= rank(max);
              const label = data.autonomyLevels[l];
              return (
                <label key={l} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', alignItems: 'start', gap: 10, padding: '8px 10px', border: `1px solid ${autonomy === l ? 'var(--accent)' : 'var(--line)'}`, borderRadius: 'var(--radius-sm)', opacity: allowed ? 1 : 0.55, background: autonomy === l ? 'var(--accent-wash)' : undefined, cursor: allowed && canAutonomy ? 'pointer' : 'default' }}>
                  <input type="radio" name="autonomy" value={l} checked={autonomy === l} disabled={!allowed || !canAutonomy} onChange={() => setAutonomy(l)} style={{ marginTop: 4 }} />
                  <span>
                    <strong>
                      {l} · {label.name}
                    </strong>
                    {!allowed ? <span className="muted"> (above this skill’s maximum)</span> : null}
                    <br />
                    <span className="muted" style={{ fontSize: 13 }}>
                      {label.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {!canAutonomy ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>Only a Controller or CFO can change autonomy.</p> : null}
        </section>

        <section className="card card-pad stack" aria-labelledby="thr-h">
          <h2 id="thr-h" style={{ margin: 0 }}>
            Thresholds
          </h2>
          <div className="grid cols-2">
            {Object.entries(specs).map(([k, spec]) => (
              <label key={k} className="field">
                {spec.label}
                <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  {spec.unit === 'minor' ? <span className="muted">$</span> : null}
                  <input
                    type="number"
                    inputMode="decimal"
                    step={spec.unit === 'ratio' ? 0.01 : spec.unit === 'minor' ? 1 : 1}
                    min={spec.min === undefined ? undefined : spec.unit === 'minor' ? spec.min / 100 : spec.min}
                    max={spec.max === undefined ? undefined : spec.unit === 'minor' ? spec.max / 100 : spec.max}
                    value={values[k] ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                    aria-describedby={`thr-${k}`}
                  />
                  {spec.unit === 'pct' ? <span className="muted">%</span> : spec.unit === 'days' ? <span className="muted">days</span> : null}
                </span>
                <span className="hint" id={`thr-${k}`}>
                  {spec.description}
                </span>
              </label>
            ))}
          </div>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} /> Skill is switched on
          </label>
        </section>

        {canEdit || canAutonomy ? (
          <section className="card card-pad stack" aria-label="Save policy">
            <label className="field">
              Why are you changing this? (recorded in the audit log)
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Raise ceiling after 3 clean months" maxLength={500} />
            </label>
            <div className="row">
              <button className="btn primary" disabled={!dirty || note.trim().length < 4 || busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save new policy version'}
              </button>
              <span className="muted" style={{ fontSize: 13 }}>
                Current: version {global.version}. Saving creates version {global.version + 1}; earlier versions stay in History.
              </span>
            </div>
          </section>
        ) : null}

        <Rules data={data} rules={global.rules} />
      </div>

      <aside className="stack">
        <section className="card card-pad stack" aria-label="Effective policy">
          <h2 style={{ margin: 0, fontSize: 16 }}>In force now</h2>
          <dl className="kv" style={{ fontSize: 13 }}>
            <dt>Autonomy</dt>
            <dd>
              {global.autonomy} · {data.autonomyLevels[global.autonomy as Level].name}
            </dd>
            {Object.entries(specs).map(([k, spec]) => (
              <FragmentKV key={k} k={spec.label} v={fmtThreshold(global.thresholds[k], spec.unit, 'USD')} />
            ))}
          </dl>
        </section>
        {scoped.map((p) => {
          const ent = me.entities.find((e) => e.id === p.scopeEntityId);
          return (
            <section key={p.id} className="card card-pad stack" aria-label={`Policy for ${ent?.code ?? 'entity'}`}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Override for {ent ? `${ent.code} (${ent.currency})` : 'an entity'}</h2>
              <dl className="kv" style={{ fontSize: 13 }}>
                <dt>Autonomy</dt>
                <dd>{p.autonomy}</dd>
                {Object.entries(p.thresholds)
                  .filter(([k, v]) => global.thresholds[k] !== v)
                  .map(([k, v]) => (
                    <FragmentKV key={k} k={specs[k]?.label ?? k} v={fmtThreshold(v, specs[k]?.unit ?? 'count', ent?.currency ?? 'USD')} />
                  ))}
              </dl>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Entity overrides keep thresholds in the entity’s own currency and materiality.
              </p>
            </section>
          );
        })}
        <section className="card card-pad stack" aria-label="Controls">
          <h2 style={{ margin: 0, fontSize: 16 }}>Controls from the manifest</h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            <li>Approvers: {data.manifest.controls.approverRoles.map((r) => titleCase(r.replace(/_/g, ' '))).join(', ')}</li>
            <li>{data.manifest.controls.makerChecker ? 'Maker-checker enforced (SOD-01)' : 'No maker-checker'}</li>
            <li>{data.manifest.controls.requesterMayApprove ? 'The person who ran it may approve (review-only output)' : 'Whoever ran the agent cannot approve its output (SOD-02)'}</li>
            <li>{data.manifest.controls.evidenceRequired ? 'Evidence required on every proposal (AX-AGT-01)' : 'Evidence optional'}</li>
            <li>
              Budget: {data.manifest.budgets.maxToolCalls} tool calls, ${data.manifest.budgets.maxCostUsd} per run
            </li>
          </ul>
        </section>
      </aside>
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className="num">{v}</dd>
    </>
  );
}

function Rules({ data, rules }: { data: SkillDetail; rules: SkillDetail['policies'][number]['rules'] }) {
  const me = useMe();
  const { toast, bump } = useApp();
  const canEdit = can(me, 'skill.policy.edit');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{ status: string; interpretation: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (text.trim().length < 6) {
      setPreview(null);
      return;
    }
    const t = window.setTimeout(() => {
      api<{ status: string; interpretation: string }>(`/skills/${data.key}/rules/preview`, { body: { text } })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [text, data.key]);

  async function add() {
    setBusy(true);
    try {
      await api(`/skills/${data.key}/rules`, { body: { text } });
      toast('Rule saved as a new policy version.');
      setText('');
      setPreview(null);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not add the rule.', 'bad');
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    try {
      await api(`/skills/${data.key}/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('Rule removed (new policy version).');
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not remove the rule.', 'bad');
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="card card-pad stack" aria-labelledby="rules-h">
      <div>
        <h2 id="rules-h" style={{ margin: 0 }}>
          Rules in plain English
        </h2>
        <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
          Write a rule the way you would tell a new hire. Tieout shows back exactly how it understood it before you save, and refuses rules it cannot interpret.
        </p>
      </div>
      {rules.length ? (
        <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 8 }}>
          {rules.map((r) => (
            <li key={r.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
              <div>
                <strong>“{r.text}”</strong>
                <div className="muted" style={{ fontSize: 13 }}>
                  {r.interpretation}
                </div>
              </div>
              {canEdit ? (
                <button className="btn ghost small" onClick={() => setRemoving(r.id)} aria-label={`Remove rule: ${r.text}`}>
                  <Trash2 className="icon" aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          No rules yet.
        </p>
      )}
      {canEdit ? (
        <div className="stack" style={{ gap: 8 }}>
          <label className="field">
            New rule
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={data.ruleExamples[0]} maxLength={300} aria-describedby="rule-preview" />
          </label>
          <div id="rule-preview" aria-live="polite">
            {preview ? (
              <div className={`callout ${preview.status === 'active' ? 'good' : 'warn'}`}>
                <div>
                  <strong>{preview.status === 'active' ? 'Tieout will read this as:' : 'Not understood yet.'}</strong> {preview.interpretation}
                </div>
              </div>
            ) : null}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {data.ruleExamples.map((ex) => (
              <button key={ex} className="btn ghost small" onClick={() => setText(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <div>
            <button className="btn primary" disabled={!preview || preview.status !== 'active' || busy} onClick={() => void add()}>
              <Plus className="icon" aria-hidden="true" /> {busy ? 'Saving…' : 'Add rule'}
            </button>
          </div>
        </div>
      ) : null}
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove this rule?"
        actions={
          <>
            <button className="btn" onClick={() => setRemoving(null)}>
              Keep it
            </button>
            <button className="btn danger" onClick={() => removing && void remove(removing)}>
              Remove rule
            </button>
          </>
        }
      >
        <p>Removing a rule creates a new policy version. The old version stays in the history and the audit log.</p>
      </Dialog>
    </section>
  );
}

// ------------------------------------------------------------------ SKILL.md, tools, evals, history
function SkillDoc({ data }: { data: SkillDetail }) {
  return (
    <div className="stack">
      <section className="card card-pad">
        <h2 style={{ marginTop: 0 }}>SKILL.md</h2>
        <p className="muted" style={{ fontSize: 14 }}>
          The procedure the agent follows, with the typed manifest in its front matter. Skills follow the Agent Skills layout (SKILL.md plus resources), so the same folder works in other agent runtimes.
        </p>
        <pre className="doc" tabIndex={0} aria-label="SKILL.md source">
          {data.skillMd}
        </pre>
      </section>
      {data.resources.length ? (
        <section className="card card-pad stack">
          <h2 style={{ margin: 0 }}>Resources</h2>
          {data.resources.map((r) => (
            <details key={r.path}>
              <summary className="mono">{r.path}</summary>
              <pre className="doc" tabIndex={0}>
                {r.content}
              </pre>
            </details>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function Tools({ data }: { data: SkillDetail }) {
  const m = data.manifest;
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Allowed tools</h2>
          <span className="right muted" style={{ fontSize: 13 }}>
            The agent sees only these, and each call is checked against the requester’s permissions too.
          </span>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Effect</th>
                <th scope="col">Needs</th>
                <th scope="col">What it does</th>
              </tr>
            </thead>
            <tbody>
              {data.allowedTools.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td>{t.effect === 'read' ? <Badge tone="neutral" icon={false}>Read</Badge> : <Badge tone="info" icon={false}>Proposes</Badge>}</td>
                  <td className="mono muted">{t.permission}</td>
                  <td>{t.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card card-pad">
        <h2 style={{ marginTop: 0 }}>Manifest</h2>
        <dl className="kv">
          <dt>Inputs</dt>
          <dd>{m.inputs.map((i) => `${i.name} (${i.type})`).join(', ') || '—'}</dd>
          <dt>Outputs</dt>
          <dd>{m.outputs.map((o) => `${o.kind} (${o.type})`).join(', ')}</dd>
          <dt>Permissions</dt>
          <dd className="mono" style={{ fontSize: 13 }}>
            {m.permissions.join(' ')}
          </dd>
          <dt>Model (live)</dt>
          <dd>
            <span className="mono">{m.model.live}</span>, effort {m.model.effort}
          </dd>
          <dt>Budgets</dt>
          <dd>
            {m.budgets.maxSteps} steps · {m.budgets.maxToolCalls} tool calls · ${m.budgets.maxCostUsd}
          </dd>
          <dt>Depends on</dt>
          <dd>{m.dependsOn.length ? m.dependsOn.join(', ') : '—'}</dd>
        </dl>
      </section>
    </div>
  );
}

function Evals({ data }: { data: SkillDetail }) {
  const me = useMe();
  const { toast, bump } = useApp();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await api<{ passed: number; total: number }>(`/skills/${data.key}/evals`, { body: {} });
      toast(`${r.passed}/${r.total} golden cases passed.`, r.passed === r.total ? 'ok' : 'bad');
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not run the evals.', 'bad');
    } finally {
      setBusy(false);
    }
  }
  const last = data.evalRuns[0];
  return (
    <div className="stack">
      <section className="card card-pad stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>Golden evals</h2>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
              Each case runs the skill against an isolated copy of the fictional demo company and checks the proposals it makes. CI runs the same suite on every change.
            </p>
          </div>
          {can(me, 'skill.eval.run') ? (
            <button className="btn primary" disabled={busy} onClick={() => void run()}>
              <FlaskConical className="icon" aria-hidden="true" /> {busy ? 'Running…' : 'Run eval suite'}
            </button>
          ) : null}
        </div>
        {data.evals.map((e) => {
          const res = last?.results.find((r) => r.caseId === e.id);
          return (
            <details key={e.id} open={!!res && !res.passed}>
              <summary>
                <strong>{e.title}</strong> {res ? res.passed ? <Badge tone="good">Passed</Badge> : <Badge tone="bad">Failed</Badge> : <span className="muted">not run here</span>}
              </summary>
              <ul className="checks">
                {(res?.expectations ?? e.expectations.map((x) => ({ description: x, passed: null as boolean | null, detail: '' }))).map((x, i) => (
                  <li key={i}>
                    {x.passed === null ? <Badge icon={false}>—</Badge> : x.passed ? <Badge tone="good">Pass</Badge> : <Badge tone="bad">Fail</Badge>} {x.description}
                    {x.detail ? <span className="muted"> · {x.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </section>
      {data.evalRuns.length ? (
        <section className="card">
          <div className="card-head">
            <h2>Recent eval runs</h2>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">By</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {data.evalRuns.map((r) => (
                  <tr key={r.id}>
                    <td>{dateTime(r.at)}</td>
                    <td>{r.by}</td>
                    <td>
                      <Badge tone={r.passed === r.total ? 'good' : 'bad'}>
                        {r.passed}/{r.total} cases
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function History({ data }: { data: SkillDetail }) {
  const me = useMe();
  return (
    <section className="card">
      <div className="card-head">
        <h2>Policy versions</h2>
        <span className="right">
          <a className="btn ghost small" href="#/audit?action=skill.">
            Audit trail
          </a>
        </span>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Scope</th>
              <th scope="col">Autonomy</th>
              <th scope="col">Change</th>
              <th scope="col">By</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {data.history.map((h) => (
              <tr key={`${h.scopeEntityId ?? 'g'}-${h.version}`}>
                <td className="num">
                  v{h.version} {h.current ? <Badge tone="good">Current</Badge> : null}
                </td>
                <td>{h.scopeEntityId ? (me.entities.find((e) => e.id === h.scopeEntityId)?.code ?? 'Entity') : 'All entities'}</td>
                <td>{h.autonomy}</td>
                <td>{h.note}</td>
                <td>{h.by}</td>
                <td>{dateTime(h.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

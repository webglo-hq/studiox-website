import { ArrowLeft, Boxes, Check, FlaskConical, History, Lock, Play, ShieldCheck, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { ago, date, label } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { Badge, Empty, ErrorBox, Skeleton, StatusBadge, Tabs, Term } from '../components/ui';

interface SkillRow {
  key: string;
  name: string;
  version: string;
  category: string;
  summary: string;
  autonomy: string;
  autonomyName: string;
  maxAutonomy: string;
  policyVersion: number;
  controls: Array<{ id: string; name: string; assertions: string[] }>;
  tools: number;
  lastRun: { id: string; status: string; at: string } | null;
  runs: number;
  evalSummary: { passed?: number; total?: number } | null;
  execution: 'agentic' | 'deterministic';
}

interface Threshold {
  key: string;
  type: 'integer' | 'number' | 'money' | 'percent' | 'boolean' | 'days';
  default: number | boolean;
  min?: number;
  max?: number;
  label: string;
  help?: string;
  value: number | boolean;
}

interface CompiledRule {
  kind: string;
  text: string;
  hint?: string;
  [k: string]: unknown;
}

interface SkillDetailData {
  manifest: {
    key: string;
    name: string;
    version: string;
    domain: string;
    category: string;
    summary: string;
    permissions: { run: string; approve: string };
    controls: Array<{ id: string; name: string; assertions: string[] }>;
    autonomy: { default: string; max: string };
    materiality: string;
    budgets: { maxSteps: number; maxToolCalls: number; maxTokens: number; maxCostUsd: number };
    spawns: string[];
    execution: 'agentic' | 'deterministic';
    evals?: string;
  };
  instructions: string;
  contentHash: string;
  inputs: Array<{ name: string; type: string; required: boolean; description?: string; label: string; definition: string | null }>;
  outputs: Array<{ kind: string; type: string; label: string; definition: string | null }>;
  tools: Array<{ name: string; title: string; description: string; permission: string; mutation: boolean; untrustedOutput: boolean; ontology: string[]; schema: unknown }>;
  thresholds: Threshold[];
  policy: { id: string | null; version: number; autonomy: string; rulesText: string; rules: CompiledRule[]; createdBy: string | null };
  autonomyLevels: Array<{ level: string; name: string; summary: string; allowed: boolean }>;
  history: Array<{ id: string; version: number; autonomy: string; thresholds: Record<string, number | boolean>; rulesText: string[]; reason: string; author: string | null; at: string }>;
  runs: Array<{ id: string; status: string; summary: string | null; at: string; proposals: number; mode: string }>;
  versions: Array<{ version: string; contentHash: string; publishedAt: string; evalSummary: unknown }>;
  canEdit: boolean;
  canSetAutonomy: boolean;
}

interface Preview {
  rules: CompiledRule[];
  unparsed: CompiledRule[];
  thresholds: Record<string, number | boolean>;
  autonomy: string;
  problems: string[];
}

const CATEGORY_ORDER = ['orchestration', 'cards', 'cash', 'reconciliation', 'accruals', 'prepaids', 'fixed_assets', 'intercompany', 'fx', 'review', 'reporting'];
const rank = (c: string) => {
  const i = CATEGORY_ORDER.indexOf(c);
  return i < 0 ? 99 : i;
};

export function SkillsScreen() {
  const { data, error, reload } = useApi<SkillRow[]>('/api/skills');
  const skills = useMemo(() => [...(data ?? [])].sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name)), [data]);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Skills and policies</h1>
          <div className="sub">
            Each <Term id="bh:Skill">skill</Term> is a versioned package: instructions, typed tools, controls and eval fixtures. Its <Term id="bh:SkillPolicy">policy</Term> sets the <Term id="bh:AutonomyLevel">autonomy level</Term>, thresholds and plain-English rules.
          </div>
        </div>
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Skeleton rows={8} />}
      {data && data.length === 0 && <Empty title="No skills installed" icon={<Boxes size={26} aria-hidden="true" />} />}
      <div className="grid grid-3">
        {skills.map((s) => (
          <a key={s.key} href={`#/skills/${s.key}`} className="card card-pad skill-card">
            <div className="row">
              <strong className="grow">{s.name}</strong>
              <span className="tiny muted">v{s.version}</span>
            </div>
            <p className="small text-2 clamp-3">{s.summary}</p>
            <div className="row-wrap">
              <Badge tone={s.autonomy === 'L0' ? '' : s.autonomy === 'L1' ? 'info' : 'violet'} title={s.autonomyName}>
                {s.autonomy} · {s.autonomyName}
              </Badge>
              <Badge>{label(s.category)}</Badge>
              {s.execution === 'deterministic' && <Badge>Deterministic</Badge>}
            </div>
            <div className="tiny muted">
              {s.controls.length} controls · {s.tools} tools · policy v{s.policyVersion}
              {s.lastRun ? ` · last run ${ago(s.lastRun.at)}` : ' · not run yet'}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

type Tab = 'policy' | 'instructions' | 'tools' | 'contract' | 'history';

function toDisplay(t: Threshold, v: number | boolean): string {
  if (typeof v === 'boolean') return String(v);
  if (t.type === 'money') return (v / 100).toFixed(2);
  if (t.type === 'percent') return String(Math.round(v * 1000) / 10);
  return String(v);
}

function fromDisplay(t: Threshold, s: string): number | null {
  const n = Number(s.replace(/[$,%\s]/g, ''));
  if (!Number.isFinite(n) || s.trim() === '') return null;
  if (t.type === 'money') return Math.round(n * 100);
  if (t.type === 'percent') return n / 100;
  if (t.type === 'integer' || t.type === 'days') return Math.round(n);
  return n;
}

function describeRule(r: CompiledRule): string {
  const amt = (k: string) => (typeof r[k] === 'number' ? `$${((r[k] as number) / 100).toLocaleString('en-US')}` : '');
  switch (r.kind) {
    case 'merchant_account':
      return `Code "${String(r.match)}" to ${String(r.accountNumber)}${r.departmentCode ? ` (${String(r.departmentCode)})` : ''}`;
    case 'max_auto_amount':
      return `Never auto-apply over ${amt('amountMinor')}`;
    case 'auto_post_under':
      return `Auto-apply limit ${amt('amountMinor')}`;
    case 'min_confidence':
      return `Auto-apply only at ${Math.round(Number(r.value) * 100)}% confidence or more`;
    case 'require_review':
      return `Always send "${String(r.match)}" for review`;
    case 'capitalize_over':
      return `Capitalize purchases over ${amt('amountMinor')}`;
    case 'tolerance':
      return `Tolerate differences under ${amt('amountMinor')}`;
    case 'flux_threshold':
      return `Explain variances over ${r.pct !== null ? `${Math.round(Number(r.pct) * 100)}%` : ''}${r.pct !== null && r.amountMinor !== null ? ' and ' : ''}${r.amountMinor !== null ? amt('amountMinor') : ''}`;
    case 'sample_rate':
      return `Sample ${Math.round(Number(r.value) * 100)}% of auto-applied items`;
    case 'exclude':
      return `Skip "${String(r.match)}"`;
    default:
      return r.text;
  }
}

export function SkillDetail({ skillKey }: { skillKey: string }) {
  const { data, error, reload } = useApi<SkillDetailData>(`/api/skills/${skillKey}`);
  const [tab, setTab] = useState<Tab>('policy');
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={12} />;
  const m = data.manifest;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <a href="#/skills" className="small row">
        <ArrowLeft size={14} aria-hidden="true" /> All skills
      </a>
      <div className="page-head">
        <div>
          <div className="row-wrap" style={{ marginBottom: 6 }}>
            <Badge>{label(m.category)}</Badge>
            <span className="small muted">
              {m.key} v{m.version} · {m.execution === 'deterministic' ? 'deterministic orchestration' : 'agentic'} · sha256 <code>{data.contentHash.slice(0, 12)}</code>
            </span>
          </div>
          <h1>{m.name}</h1>
          <div className="sub" style={{ maxWidth: 820 }}>
            {m.summary}
          </div>
        </div>
      </div>
      <Tabs<Tab>
        label="Skill sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'policy', label: 'Policy' },
          { id: 'instructions', label: 'Instructions' },
          { id: 'tools', label: 'Tools', count: data.tools.length },
          { id: 'contract', label: 'Inputs, outputs & controls' },
          { id: 'history', label: 'History & runs' },
        ]}
      />
      {tab === 'policy' && <PolicyEditor key={`${data.policy.id ?? 'default'}-${data.policy.version}`} skillKey={skillKey} data={data} />}
      {tab === 'instructions' && (
        <section className="card card-pad">
          <div className="skill-md">
            {data.instructions.split('\n').map((line, i) =>
              line.startsWith('## ') ? (
                <h3 key={i}>{line.slice(3)}</h3>
              ) : line.startsWith('# ') ? (
                <h2 key={i}>{line.slice(2)}</h2>
              ) : line.trim() === '' ? (
                <div key={i} className="md-gap" />
              ) : (
                <p key={i} className={/^(\d+\.|-)\s/.test(line.trim()) ? 'md-li' : undefined}>
                  {renderInline(line)}
                </p>
              ),
            )}
          </div>
          <p className="tiny muted" style={{ marginTop: 16 }}>
            In live mode these instructions are the system prompt (with the ontology terms the skill's inputs use). The offline engine implements the same procedure deterministically.
          </p>
        </section>
      )}
      {tab === 'tools' && (
        <section className="stack">
          {data.tools.map((t) => (
            <details key={t.name} className="card tool-card">
              <summary className="card-pad row-wrap">
                <code>{t.name}</code>
                <strong className="grow">{t.title}</strong>
                {t.mutation && <Badge tone="attention">writes</Badge>}
                {t.untrustedOutput && (
                  <Badge tone="danger" title="Output includes third-party text; it is wrapped as untrusted data and scanned for instructions">
                    untrusted text
                  </Badge>
                )}
                <Badge>{t.permission}</Badge>
              </summary>
              <div className="card-pad stack" style={{ paddingTop: 0 }}>
                <p className="small text-2">{t.description}</p>
                {t.ontology.length > 0 && (
                  <div className="row-wrap small">
                    Grounded in:
                    {t.ontology.map((o) => (
                      <a key={o} href={`#/ontology/${encodeURIComponent(o)}`}>
                        <Badge tone="info">{o}</Badge>
                      </a>
                    ))}
                  </div>
                )}
                <pre className="code">{JSON.stringify(t.schema, null, 2)}</pre>
              </div>
            </details>
          ))}
        </section>
      )}
      {tab === 'contract' && (
        <div className="grid grid-2">
          <section className="card">
            <div className="card-head">
              <h2>Inputs</h2>
            </div>
            <ul className="list small">
              {data.inputs.map((i) => (
                <li key={i.name}>
                  <code>{i.name}</code> {i.required && <Badge>required</Badge>} <Term id={i.type}>{i.label}</Term>
                  {i.description && <div className="muted">{i.description}</div>}
                </li>
              ))}
            </ul>
            <div className="card-head" style={{ borderTop: '1px solid var(--border)' }}>
              <h2>Outputs</h2>
            </div>
            <ul className="list small">
              {data.outputs.map((o) => (
                <li key={o.kind}>
                  <code>{o.kind}</code> <Term id={o.type}>{o.label}</Term>
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <div className="card-head">
              <h2>Controls</h2>
            </div>
            <ul className="list small">
              {m.controls.map((c) => (
                <li key={c.id}>
                  <div className="row">
                    <ShieldCheck size={14} aria-hidden="true" />
                    <strong className="grow">{c.name}</strong>
                    <span className="tiny muted mono">{c.id}</span>
                  </div>
                  <div className="row-wrap" style={{ marginTop: 4 }}>
                    {c.assertions.map((a) => (
                      <Badge key={a}>{label(a)}</Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <div className="card-head" style={{ borderTop: '1px solid var(--border)' }}>
              <h2>Permissions and budgets</h2>
            </div>
            <dl className="facts card-pad small">
              <dt>Run</dt>
              <dd>
                <code>{m.permissions.run}</code>
              </dd>
              <dt>Approve output</dt>
              <dd>
                <code>{m.permissions.approve}</code>
              </dd>
              <dt>Materiality</dt>
              <dd>{label(m.materiality)}</dd>
              <dt>Budget</dt>
              <dd>
                {m.budgets.maxSteps} steps · {m.budgets.maxToolCalls} tool calls · {m.budgets.maxTokens.toLocaleString('en-US')} tokens · ${m.budgets.maxCostUsd}
              </dd>
              {m.spawns.length > 0 && (
                <>
                  <dt>May start</dt>
                  <dd>{m.spawns.includes('*') ? 'Any skill the requester may run' : m.spawns.join(', ')}</dd>
                </>
              )}
              {m.evals && (
                <>
                  <dt>Eval fixtures</dt>
                  <dd>
                    <FlaskConical size={13} aria-hidden="true" /> {m.evals} (run in CI)
                  </dd>
                </>
              )}
            </dl>
          </section>
        </div>
      )}
      {tab === 'history' && (
        <div className="grid grid-2">
          <section className="card">
            <div className="card-head">
              <h2>
                <History size={15} aria-hidden="true" /> Policy versions
              </h2>
            </div>
            <ul className="list small">
              {data.history.map((h) => (
                <li key={h.id}>
                  <div className="row">
                    <strong>v{h.version}</strong>
                    <Badge>{h.autonomy}</Badge>
                    <span className="grow" />
                    <span className="tiny muted">
                      {h.author ?? 'package default'} · {date(h.at, 'time')}
                    </span>
                  </div>
                  <div className="text-2" style={{ marginTop: 4 }}>
                    {h.reason}
                  </div>
                  {h.rulesText.length > 0 && <div className="tiny muted">Rules: {h.rulesText.join(' · ')}</div>}
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <div className="card-head">
              <h2>
                <Play size={15} aria-hidden="true" /> Recent runs
              </h2>
            </div>
            {data.runs.length === 0 ? (
              <p className="card-pad small muted">Not run yet.</p>
            ) : (
              <ul className="list small">
                {data.runs.map((r) => (
                  <li key={r.id} className="row">
                    <a className="grow" href={`#/runs/${r.id}`}>
                      {r.summary ?? 'Run'}
                    </a>
                    <span className="tiny muted">{ago(r.at)}</span>
                    <StatusBadge status={r.status} />
                  </li>
                ))}
              </ul>
            )}
            <div className="card-head" style={{ borderTop: '1px solid var(--border)' }}>
              <h2>Published versions</h2>
            </div>
            <ul className="list small">
              {data.versions.map((v) => (
                <li key={v.version} className="row">
                  <strong>v{v.version}</strong>
                  <code className="tiny grow">{v.contentHash.slice(0, 16)}</code>
                  <span className="tiny muted">{date(v.publishedAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

function renderInline(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}

function PolicyEditor({ skillKey, data }: { skillKey: string; data: SkillDetailData }) {
  const [autonomy, setAutonomy] = useState(data.policy.autonomy);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(data.thresholds.map((t) => [t.key, toDisplay(t, t.value)])));
  const [rulesText, setRulesText] = useState(data.policy.rulesText);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const { run, busy } = useAction();
  const editable = data.canEdit;
  const thresholds: Record<string, number | boolean> = {};
  const invalid: string[] = [];
  for (const t of data.thresholds) {
    const raw = values[t.key] ?? '';
    if (t.type === 'boolean') {
      thresholds[t.key] = raw === 'true';
      continue;
    }
    const v = fromDisplay(t, raw);
    if (v === null) invalid.push(t.label);
    else thresholds[t.key] = v;
  }
  const change = { autonomy, thresholds, rulesText };
  const dirty = autonomy !== data.policy.autonomy || rulesText !== data.policy.rulesText || data.thresholds.some((t) => thresholds[t.key] !== t.value);
  const doPreview = () => run(async () => setPreview(await api.post<Preview>(`/api/skills/${skillKey}/policy/preview`, change)));
  const save = () => run(() => api.put(`/api/skills/${skillKey}/policy`, { ...change, reason: reason.trim() }), 'Policy published as a new version.');
  const currentRules = preview ? preview.rules : data.policy.rules;
  return (
    <div className="split">
      <div className="stack" style={{ gap: 16 }}>
        <section className="card" aria-labelledby="autonomy-h">
          <div className="card-head">
            <h2 id="autonomy-h">
              <Term id="bh:AutonomyLevel">Autonomy</Term>
            </h2>
            {!data.canSetAutonomy && (
              <span className="small muted row">
                <Lock size={13} aria-hidden="true" /> Controller or CFO sets this
              </span>
            )}
          </div>
          <div className="card-pad autonomy-grid" role="radiogroup" aria-labelledby="autonomy-h">
            {data.autonomyLevels.map((l) => {
              const disabled = !l.allowed || !data.canSetAutonomy || !editable;
              return (
                <label key={l.level} className={`autonomy-option${autonomy === l.level ? ' selected' : ''}${disabled ? ' disabled' : ''}`}>
                  <input type="radio" name="autonomy" value={l.level} checked={autonomy === l.level} disabled={disabled} onChange={() => { setAutonomy(l.level); setPreview(null); }} />
                  <span>
                    <strong>
                      {l.level} · {l.name}
                    </strong>
                    <span className="small text-2" style={{ display: 'block' }}>
                      {l.summary}
                    </span>
                    {!l.allowed && <span className="tiny muted">Above this skill&apos;s maximum ({data.manifest.autonomy.max})</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </section>
        {data.thresholds.length > 0 && (
          <section className="card" aria-labelledby="thr-h">
            <div className="card-head">
              <h2 id="thr-h">Thresholds</h2>
            </div>
            <div className="card-pad grid grid-2">
              {data.thresholds.map((t) => (
                <div key={t.key} className="field">
                  <label htmlFor={`thr-${t.key}`}>{t.type === 'money' ? t.label.replace(/\s*\(cents\)/i, '') : t.label}</label>
                  {t.type === 'boolean' ? (
                    <select id={`thr-${t.key}`} className="select" value={values[t.key]} disabled={!editable} onChange={(e) => setValues({ ...values, [t.key]: e.target.value })}>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  ) : (
                    <div className="input-affix">
                      {t.type === 'money' && <span aria-hidden="true">$</span>}
                      <input id={`thr-${t.key}`} className="input num" inputMode="decimal" value={values[t.key] ?? ''} disabled={!editable} aria-invalid={fromDisplay(t, values[t.key] ?? '') === null} onChange={(e) => { setValues({ ...values, [t.key]: e.target.value }); setPreview(null); }} />
                      {t.type === 'percent' && <span aria-hidden="true">%</span>}
                      {t.type === 'days' && <span aria-hidden="true">days</span>}
                    </div>
                  )}
                  <span className="hint">
                    Default {toDisplay(t, t.default)}
                    {t.type === 'percent' ? '%' : ''}
                    {t.min !== undefined && t.max !== undefined && t.type !== 'boolean' ? ` · ${toDisplay(t, t.min)} to ${toDisplay(t, t.max)}${t.type === 'percent' ? '%' : ''}` : ''}
                    {t.help ? ` · ${t.help}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
        <section className="card" aria-labelledby="rules-h">
          <div className="card-head">
            <h2 id="rules-h">Rules in plain English</h2>
          </div>
          <div className="card-pad stack">
            <label htmlFor="rules" className="sr-only">
              Rules, one per line
            </label>
            <textarea id="rules" className="textarea mono" rows={6} value={rulesText} disabled={!editable} onChange={(e) => { setRulesText(e.target.value); setPreview(null); }} placeholder={'Always code Figma to 6420\nNever auto-post anything over $5,000\nRequire approval for Copperline Legal'} />
            <p className="hint">
              One rule per line. Examples: &quot;Always code Uber to 6200 for Sales&quot;, &quot;Never auto-post anything over $25k&quot;, &quot;Require approval for Halcyon&quot;, &quot;Explain variances over 10% and $25,000&quot;, &quot;Sample 20% of auto-posted items&quot;. Each line compiles to a typed rule; a line Bookhand cannot understand blocks saving.
            </p>
          </div>
        </section>
      </div>
      <div className="stack sticky-aside" style={{ gap: 16 }}>
        <section className="card" aria-labelledby="compiled-h">
          <div className="card-head">
            <h2 id="compiled-h">{preview ? 'Preview' : `In force (v${data.policy.version})`}</h2>
            <span className="tiny muted">by {data.policy.createdBy ?? 'package default'}</span>
          </div>
          <div className="card-pad stack small">
            {preview?.problems.map((p) => (
              <div key={p} className="callout danger">
                {p}
              </div>
            ))}
            {preview?.unparsed.map((u) => (
              <div key={u.text} className="callout attention">
                <strong>Not understood:</strong> &quot;{u.text}&quot;
                <div className="tiny">{u.hint}</div>
              </div>
            ))}
            {currentRules.length === 0 ? (
              <p className="muted">No custom rules; thresholds and autonomy apply.</p>
            ) : (
              <ul className="compiled">
                {currentRules.map((r, i) => (
                  <li key={i}>
                    <Wand2 size={13} aria-hidden="true" />
                    <span className="grow">
                      {describeRule(r)}
                      <span className="tiny muted" style={{ display: 'block' }}>
                        {r.kind} · &quot;{r.text}&quot;
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {preview && !preview.problems.length && !preview.unparsed.length && (
              <div className="callout success">
                <Check size={14} aria-hidden="true" /> Autonomy {preview.autonomy}, {preview.rules.length} rule{preview.rules.length === 1 ? '' : 's'}. Ready to publish.
              </div>
            )}
          </div>
        </section>
        {editable ? (
          <section className="card card-pad stack" aria-label="Publish">
            <div className="field">
              <label htmlFor="policy-reason">Why are you changing it?</label>
              <input id="policy-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Auditors asked for review of all legal accruals" />
              <span className="hint">Every version is kept and the change is written to the audit log.</span>
            </div>
            {invalid.length > 0 && <div className="error-text">Check: {invalid.join(', ')}</div>}
            <div className="row-wrap">
              <button type="button" className="btn" disabled={busy || invalid.length > 0} onClick={() => void doPreview()}>
                Preview
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || !dirty || invalid.length > 0 || reason.trim().length < 5} onClick={() => void save()}>
                Publish new version
              </button>
            </div>
          </section>
        ) : (
          <div className="callout small">
            <Lock size={14} aria-hidden="true" /> Your role can view this policy but not change it.
          </div>
        )}
      </div>
    </div>
  );
}

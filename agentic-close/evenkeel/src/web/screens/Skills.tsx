import { ArrowLeft, CircleAlert, CircleCheck, FlaskConical, Gauge, History, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MethodOutput } from '../../app/methods';
import { useAction, useApi } from '../lib/api';
import { humanize, money, plural, when } from '../lib/format';
import { href } from '../lib/router';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Disclosure, Empty, Field, Kv, LinkButton, Notice, PageHead, Person, Query, Status, Tabs } from '../ui/kit';
import { Term } from '../ui/term';

type Detail = MethodOutput<'skills.get'>;
const LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
const LEVEL_TEXT: Record<(typeof LEVELS)[number], { name: string; body: string }> = {
  L0: { name: 'Suggest only', body: 'The agent drafts; nothing is posted, every item needs a person.' },
  L1: { name: 'Approve each', body: 'The agent prepares postings; a person approves each one.' },
  L2: { name: 'Auto under threshold', body: 'Verified, confident items under the amount threshold post automatically; a sample is reviewed afterwards.' },
  L3: { name: 'Auto, review after', body: 'Verified, confident items post automatically and every one is reviewed afterwards.' },
};

export function Skills({ openId }: { openId: string | null }) {
  if (openId) return <SkillDetail id={openId} />;
  return <SkillCatalog />;
}

function SkillCatalog() {
  const q = useApi('skills.list', {});
  return (
    <div className="page">
      <PageHead
        eyebrow="Agents"
        title="Skills and policies"
        sub={
          <>
            Each <Term id="ek:Skill">skill</Term> is a packaged agent capability: instructions, ontology-typed inputs and outputs, the only tools it may use, the controls it enforces and evaluation cases. Your team tunes it in plain English and sets its <Term id="ek:AutonomyLevel">autonomy</Term>.
          </>
        }
      />
      <Query q={q} rows={8}>
        {(skills) => (
          <div className="grid grid-3">
            {skills.map((s) => (
              <a key={s.id} href={href(`/skills/${s.id}`)} className="card" style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column' }} data-testid={`skill-${s.id}`}>
                <div className="card-head">
                  <span className="row" style={{ gap: 8 }}>
                    <Sparkles size={16} aria-hidden color="var(--accent)" />
                    <h2>{s.title}</h2>
                  </span>
                </div>
                <div className="card-body stack" style={{ gap: 10, flex: 1 }}>
                  <div>
                    <Badge tone={s.autonomy === 'L0' || s.autonomy === 'L1' ? 'neutral' : 'accent'} title={LEVEL_TEXT[s.autonomy].body}>
                      {s.autonomy} · {LEVEL_TEXT[s.autonomy].name}
                    </Badge>
                  </div>
                  <p className="small ink2">{s.summary}</p>
                  <div className="row-wrap xs muted">
                    <span>{humanize(s.category)}</span>·<span>{s.model} model</span>·<span>{plural(s.tools.length, 'tool')}</span>·<span>policy v{s.policyVersion}</span>
                  </div>
                  <div className="row-wrap" style={{ marginTop: 'auto' }}>
                    <Badge>{plural(s.runs, 'run')}</Badge>
                    {s.proposals.total > 0 && (
                      <Badge tone="info">
                        {s.proposals.auto} auto · {s.proposals.approved} approved · {s.proposals.rejected} rejected
                      </Badge>
                    )}
                    {s.evals && (
                      <Badge tone={s.evals.passed === s.evals.total ? 'good' : 'warn'}>
                        evals {s.evals.passed}/{s.evals.total}
                      </Badge>
                    )}
                    {!s.enabled && <Badge tone="bad">disabled</Badge>}
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
      </Query>
    </div>
  );
}

function AutonomyEditor({ d }: { d: Detail }) {
  const { can } = useSession();
  const [level, setLevel] = useState(d.policy.autonomy);
  const [note, setNote] = useState('');
  const save = useAction('skills.setAutonomy', { success: (_o, i) => `Autonomy set to ${i.level}. Policy version saved.`, onSuccess: () => setNote('') });
  const maxIdx = LEVELS.indexOf(d.manifest.autonomy.max);
  const allowed = can('skill.autonomy.set');
  // A new policy version (saved here or elsewhere) resets the picker to what is in force.
  const [levelInForce, setLevelInForce] = useState(d.policy.autonomy);
  if (levelInForce !== d.policy.autonomy) {
    setLevelInForce(d.policy.autonomy);
    setLevel(d.policy.autonomy);
  }
  return (
    <Card title="Autonomy" hint={allowed ? 'Only a controller can change this. Every change is a new, audited policy version.' : 'Set by the controller.'}>
      <fieldset style={{ border: 0, margin: 0, padding: 0 }} disabled={!allowed}>
        <legend className="sr-only">Autonomy level</legend>
        <div className="stack" style={{ gap: 8 }}>
          {LEVELS.map((l, i) => (
            <label key={l} className="panel row" style={{ alignItems: 'flex-start', cursor: allowed && i <= maxIdx ? 'pointer' : 'default', opacity: i > maxIdx ? 0.55 : 1, borderColor: level === l ? 'var(--accent)' : undefined }}>
              <input type="radio" name="autonomy" value={l} checked={level === l} disabled={i > maxIdx} onChange={() => setLevel(l)} style={{ marginTop: 4, accentColor: 'var(--accent)' }} />
              <span className="stack" style={{ gap: 2 }}>
                <strong className="small">
                  {l} · {LEVEL_TEXT[l].name} {i > maxIdx && <span className="muted">(above this skill's maximum)</span>}
                </strong>
                <span className="xs ink2">{LEVEL_TEXT[l].body}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {allowed && level !== d.policy.autonomy && (
        <div className="stack" style={{ marginTop: 12 }}>
          <Field label="Why the change?" htmlFor="aut-note">
            <input id="aut-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Ninety days of clean reviews at L1" />
          </Field>
          <div>
            <Button variant="primary" disabled={note.trim().length < 5} busy={save.isPending} onClick={() => save.mutate({ skillId: d.id, level, note })}>
              Save autonomy
            </Button>
          </div>
        </div>
      )}
      <p className="xs muted" style={{ marginTop: 12 }}>
        Whatever the level, items at or above <Term id="ek:Materiality">materiality</Term>, items that fail verification, low-confidence items and flagged text always wait for a person.
      </p>
    </Card>
  );
}

function PolicyEditor({ d }: { d: Detail }) {
  const { can } = useSession();
  const current = d.versions.find((v) => v.current);
  const [text, setText] = useState(current?.rulesText ?? '');
  const [autoPost, setAutoPost] = useState(String(d.policy.autoPostBelow / 100));
  const [minConf, setMinConf] = useState(String(Math.round(d.policy.minConfidence * 100)));
  const [sample, setSample] = useState(String(Math.round(d.policy.sampleRate * 100)));
  const [note, setNote] = useState('');
  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text), 350);
    return () => window.clearTimeout(t);
  }, [text]);
  const preview = useApi('skills.previewRules', { text: debounced }, { keepPrevious: true, staleTime: 60_000 });
  const save = useAction('skills.updatePolicy', { success: (o) => `Policy version ${o.policy.version} saved.`, onSuccess: () => setNote('') });
  const editable = can('skill.policy.edit');
  const thresholds = { autoPostBelow: Math.round(Number(autoPost) * 100), minConfidence: Number(minConf) / 100, sampleRate: Number(sample) / 100 };
  const valid = Number.isFinite(thresholds.autoPostBelow) && thresholds.autoPostBelow >= 0 && thresholds.minConfidence > 0 && thresholds.minConfidence <= 1 && thresholds.sampleRate >= 0 && thresholds.sampleRate <= 1;
  const changed = text !== (current?.rulesText ?? '') || thresholds.autoPostBelow !== d.policy.autoPostBelow || Math.abs(thresholds.minConfidence - d.policy.minConfidence) > 1e-9 || Math.abs(thresholds.sampleRate - d.policy.sampleRate) > 1e-9;
  return (
    <Card title="Policy in plain English" hint="One rule per line. Evenkeel restates each rule so you can confirm what it will do.">
      <div className="stack">
        <Field label="Rules" htmlFor="rules" help={'Examples: When merchant contains "Quillsoft", code to 6200 · Never auto-post when memo contains "gift" · Flag amount over $5,000'}>
          <textarea id="rules" className="textarea code" value={text} onChange={(e) => setText(e.target.value)} readOnly={!editable} spellCheck={false} />
        </Field>
        {preview.data && (
          <div className="stack" style={{ gap: 4 }} aria-live="polite">
            {preview.data.rules.map((r) => (
              <div key={r.id} className="policy-rule">
                <CircleCheck size={16} color="var(--good)" aria-hidden />
                <span>
                  <span className="xs muted">Line {r.line} · </span>
                  {r.explanation}
                </span>
              </div>
            ))}
            {preview.data.errors.map((e, i) => (
              <div key={i} className="policy-rule">
                <CircleAlert size={16} color="var(--bad)" aria-hidden />
                <span>
                  <span className="xs muted">Line {e.line} · </span>
                  <span className="diff-bad">{e.message}</span>
                  {e.suggestion && <span className="ink2"> {e.suggestion}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="grid grid-3">
          <Field label="Auto-post below (USD)" htmlFor="th-auto" help="L2 only: larger items wait for a person.">
            <input id="th-auto" className="input num" inputMode="decimal" value={autoPost} onChange={(e) => setAutoPost(e.target.value)} readOnly={!editable} />
          </Field>
          <Field label="Minimum confidence (%)" htmlFor="th-conf">
            <input id="th-conf" className="input num" inputMode="numeric" value={minConf} onChange={(e) => setMinConf(e.target.value)} readOnly={!editable} />
          </Field>
          <Field label="Post-hoc review sample (%)" htmlFor="th-sample">
            <input id="th-sample" className="input num" inputMode="numeric" value={sample} onChange={(e) => setSample(e.target.value)} readOnly={!editable} />
          </Field>
        </div>
        {editable && changed && (
          <>
            <Field label="Change note" htmlFor="pol-note" help="Required. Shown in the policy history and the audit log.">
              <input id="pol-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </Field>
            <div className="row-wrap">
              <Button variant="primary" disabled={!valid || note.trim().length < 5 || (preview.data?.errors.length ?? 0) > 0} busy={save.isPending} onClick={() => save.mutate({ skillId: d.id, rulesText: text, thresholds, note })}>
                Save as version {(d.versions[0]?.version ?? 0) + 1}
              </Button>
              {(preview.data?.errors.length ?? 0) > 0 && <span className="small diff-bad">Fix the highlighted lines first.</span>}
            </div>
          </>
        )}
        {!editable && <Notice tone="info">Your role can read but not edit policies.</Notice>}
      </div>
    </Card>
  );
}

function SkillDetail({ id }: { id: string }) {
  const q = useApi('skills.get', { id });
  const [tab, setTab] = useState<'policy' | 'manifest' | 'instructions' | 'history' | 'evals'>('policy');
  return (
    <div className="page">
      <div>
        <LinkButton href="#/skills" variant="quiet" size="s" icon={<ArrowLeft size={14} aria-hidden />}>
          All skills
        </LinkButton>
      </div>
      <Query q={q} rows={10}>
        {(d) => (
          <>
            <PageHead eyebrow={`Skill · ${d.name} · v${d.manifest.version}`} title={d.manifest.title} sub={d.description} />
            <div className="row-wrap">
              <Badge tone="accent">
                <Gauge size={12} aria-hidden /> {d.policy.autonomy}
              </Badge>
              <Badge>{d.manifest.model} model tier</Badge>
              <Badge>policy v{d.policy.version}</Badge>
              <Badge>
                budget {d.manifest.budgets.maxSteps} steps · {d.manifest.budgets.maxTokens.toLocaleString()} tokens · ${d.manifest.budgets.maxCostUsd}
              </Badge>
              <span className="xs muted mono">sha256 {d.contentHash.slice(0, 12)}…</span>
            </div>
            <Tabs
              label="Skill sections"
              value={tab}
              onChange={setTab}
              items={[
                { value: 'policy', label: 'Policy & autonomy' },
                { value: 'manifest', label: 'Manifest' },
                { value: 'instructions', label: 'Instructions' },
                { value: 'evals', label: 'Evaluations', count: d.evalCases.length },
                { value: 'history', label: 'History', count: d.versions.length },
              ]}
            />
            {tab === 'policy' && (
              <div className="grid grid-main">
                <PolicyEditor d={d} />
                <AutonomyEditor d={d} />
              </div>
            )}
            {tab === 'manifest' && (
              <div className="grid grid-2">
                <Card title="Inputs and outputs" hint="Typed by ontology classes">
                  <div className="stack small">
                    <div>
                      <strong>Inputs</strong>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {d.manifest.inputs.length ? d.manifest.inputs.map((i) => (
                          <li key={i.name}>
                            <code>{i.name}</code>: <Term id={i.type}>{i.type}</Term> {i.required ? '' : '(optional)'} <span className="muted">{i.description}</span>
                          </li>
                        )) : <li className="muted">none</li>}
                      </ul>
                    </div>
                    <div>
                      <strong>Outputs</strong>
                      <div className="chip-list" style={{ marginTop: 4 }}>
                        {d.manifest.outputs.map((o) => (
                          <span key={o} className="chip">
                            <Term id={o}>{o}</Term>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </Card>
                <Card title="Least-privilege tools and permissions">
                  <div className="stack small">
                    <div className="chip-list">
                      {d.manifest.tools.map((t) => (
                        <span key={t} className="chip">
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="chip-list">
                      {d.manifest.permissions.map((p) => (
                        <span key={p} className="chip">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                </Card>
                <Card title="Controls">
                  <Kv
                    items={[
                      ['Preparer', d.manifest.controls.preparer],
                      ['Reviewer', d.manifest.controls.reviewer],
                      ['Always needs approval', d.manifest.controls.approvalRequired.join(', ') || '—'],
                      ['Segregation of duties', d.manifest.controls.sod.join(', ') || '—'],
                      ['Assertions', d.manifest.controls.assertions.join(', ') || '—'],
                      ['COSO', d.manifest.controls.coso ?? '—'],
                      ['Materiality basis', humanize(d.manifest.materiality.basis)],
                    ]}
                  />
                </Card>
                <Card title="Defaults">
                  <Kv items={[['Default autonomy', d.manifest.autonomy.default], ['Maximum autonomy', d.manifest.autonomy.max], ['Auto-post below', money(d.manifest.autonomy.autoPostBelow)], ['Minimum confidence', `${Math.round(d.manifest.autonomy.minConfidence * 100)}%`], ['Review sample', `${Math.round(d.manifest.autonomy.sampleRate * 100)}%`], ['Ontology range', d.manifest.ontology]]} />
                </Card>
              </div>
            )}
            {tab === 'instructions' && (
              <div className="stack-l">
                <Card title="SKILL.md" hint="What the agent reads first (progressive disclosure: resources load on demand)">
                  <pre className="code" style={{ maxHeight: 640 }}>
                    {d.instructions}
                  </pre>
                </Card>
                {d.resources.map((r) => (
                  <Card key={r.path} title={r.path} hint={r.description}>
                    <Disclosure summary="Show resource">
                      <pre className="code">{r.content}</pre>
                    </Disclosure>
                  </Card>
                ))}
              </div>
            )}
            {tab === 'evals' && (
              <div className="grid grid-2">
                <Card title="Evaluation cases" hint="Run in CI against the planted Kitewell scenario">
                  {d.evalCases.length ? (
                    <ul className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
                      {d.evalCases.map((c) => (
                        <li key={c.id}>
                          <code>{c.id}</code> {c.description}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty icon={<FlaskConical size={22} />} title="No eval cases" />
                  )}
                </Card>
                <Card title="Recent eval runs">
                  {d.evalRuns.length ? (
                    <ul className="stack small" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
                      {d.evalRuns.map((e, i) => (
                        <li key={i} className="row">
                          <Status value={e.passed === e.total ? 'ok' : 'failed'} label={`${e.passed}/${e.total}`} /> {e.engine} · {when(e.at)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="small muted">Evals run with npm run evals; results are recorded here when they run against this database.</p>
                  )}
                </Card>
              </div>
            )}
            {tab === 'history' && (
              <Card title="Policy versions" hint="Every change is versioned and audited" flush>
                <div className="list">
                  {d.versions.map((v) => (
                    <div key={v.version} className="list-item" style={{ alignItems: 'flex-start' }}>
                      <History size={16} aria-hidden className="muted" style={{ marginTop: 3 }} />
                      <span className="grow stack" style={{ gap: 2 }}>
                        <span className="small strong">
                          Version {v.version} · {v.autonomy} {v.current && <Badge tone="good">current</Badge>} {!v.enabled && <Badge tone="bad">disabled</Badge>}
                        </span>
                        <span className="xs ink2">{v.changeNote ?? 'Initial policy'}</span>
                        <span className="xs muted row" style={{ gap: 4 }}>
                          <Person name={v.createdBy?.name ?? 'Evenkeel'} /> · {when(v.createdAt)} · {plural(v.rules.length, 'rule')}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}
      </Query>
    </div>
  );
}

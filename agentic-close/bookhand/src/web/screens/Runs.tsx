import { AlertTriangle, ArrowLeft, Bot, CheckCircle2, CircleDot, Eye, FileCheck2, ListChecks, Square, Wrench } from 'lucide-react';
import { useState } from 'react';
import { api, qs } from '../lib/api';
import { ago, date, KIND_LABELS, label, money } from '../lib/format';
import { useAction, useApi, useCan } from '../lib/hooks';
import { Badge, Confidence, Empty, ErrorBox, ReasonDialog, Skeleton, StatusBadge, Term } from '../components/ui';

interface RunRow {
  id: string;
  skill: string;
  skillName: string;
  version: string;
  status: string;
  phase: string;
  mode: string;
  model: string | null;
  trigger: string;
  requestedBy: string | null;
  parentRunId: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  steps: number;
  toolCalls: number;
  proposals: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  resumeCount: number;
}

interface RunDetail {
  run: {
    id: string;
    skill: string;
    skillName: string;
    version: string;
    ontologyVersion: string;
    status: string;
    phase: string;
    mode: string;
    provider: string | null;
    model: string | null;
    trigger: string;
    requestedBy: string | null;
    input: Record<string, unknown>;
    plan: string[] | null;
    summary: string | null;
    error: string | null;
    budget: { max_steps: number; max_tool_calls: number; max_tokens: number; max_cost_usd_micros: number };
    stepsUsed: number;
    toolCallsUsed: number;
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    costUsd: number;
    startedAt: string | null;
    finishedAt: string | null;
    heartbeatAt: string | null;
    resumeCount: number;
    parentRunId: string | null;
    closeTaskId: string | null;
    policyId: string | null;
    idempotencyKey: string | null;
  };
  steps: Array<{
    seq: number;
    phase: string;
    kind: string;
    title: string;
    detail: Record<string, unknown>;
    at: string;
    durationMs: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
    tool: { name: string; status: string; mutation: boolean; input: string; output: string; error: string | null; durationMs: number | null } | null;
  }>;
  proposals: Array<{ id: string; kind: string; title: string; status: string; confidence: number | null; amount: number | null; riskFlags: string[] }>;
  children: Array<{ id: string; skill: string; status: string; summary: string | null; proposals: number }>;
}

function duration(a: string | null, b: string | null): string {
  if (!a) return '—';
  const ms = Date.parse(b ?? new Date().toISOString()) - Date.parse(a);
  if (ms < 1000) return `${Math.max(ms, 0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function ModeBadge({ mode, model }: { mode: string; model: string | null }) {
  if (mode === 'live') return <Badge tone="violet">Live · {model ?? 'Claude'}</Badge>;
  if (mode === 'replay') return <Badge tone="info">Replay</Badge>;
  return <Badge title="Deterministic offline engine: same input, same output">Offline engine</Badge>;
}

export function RunsScreen() {
  const [skill, setSkill] = useState('');
  const [status, setStatus] = useState('');
  const { data, error, reload } = useApi<RunRow[]>(`/api/runs${qs({ skill, status, limit: 150 })}`, { pollMs: 4000 });
  const { data: skills } = useApi<Array<{ key: string; name: string }>>('/api/skills');
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Agent runs</h1>
          <div className="sub">
            Every <Term id="bh:AgentRun">agent run</Term> leaves a full trace: plan, each typed <Term id="bh:ToolCall">tool call</Term>, verification, proposals and cost.
          </div>
        </div>
      </div>
      <div className="row-wrap report-controls">
        <div className="field">
          <label htmlFor="runs-skill">Skill</label>
          <select id="runs-skill" className="select" value={skill} onChange={(e) => setSkill(e.target.value)}>
            <option value="">All skills</option>
            {skills?.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="runs-status">Status</label>
          <select id="runs-status" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {['running', 'queued', 'completed', 'failed', 'cancelled', 'budget_exceeded'].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Skeleton rows={10} />}
      {data && data.length === 0 && (
        <div className="card">
          <Empty title="No agent runs yet" icon={<Bot size={26} aria-hidden="true" />} action={<a className="btn btn-primary" href="#/">Go to my close</a>}>
            Runs appear here when you start the close agents from the home page or the cockpit.
          </Empty>
        </div>
      )}
      {data && data.length > 0 && (
        <section className="card table-wrap" aria-label="Runs">
          <table className="table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Status</th>
                <th className="hide-sm">Engine</th>
                <th className="hide-sm">Started</th>
                <th className="num">Proposals</th>
                <th className="num hide-sm">Tool calls</th>
                <th className="num hide-sm">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={`#/runs/${r.id}`}>{r.skillName}</a>
                    {r.parentRunId && <span className="tiny muted"> · child run</span>}
                    <div className="tiny muted clamp-2">{r.error ?? r.summary ?? `${label(r.phase)}...`}</div>
                  </td>
                  <td>
                    <StatusBadge status={r.status} />
                    {r.resumeCount > 0 && (
                      <div className="tiny muted" title="Resumed after an interruption; journaled tool calls were replayed, not re-executed">
                        resumed {r.resumeCount}x
                      </div>
                    )}
                  </td>
                  <td className="hide-sm">
                    <ModeBadge mode={r.mode} model={r.model} />
                  </td>
                  <td className="hide-sm small">
                    {ago(r.startedAt)}
                    <div className="tiny muted">
                      {r.requestedBy ?? label(r.trigger)} · {duration(r.startedAt, r.finishedAt)}
                    </div>
                  </td>
                  <td className="num">{r.proposals}</td>
                  <td className="num hide-sm">{r.toolCalls}</td>
                  <td className="num hide-sm small">{r.mode === 'live' ? `$${r.costUsd.toFixed(3)}` : '$0'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const STEP_ICON: Record<string, typeof Bot> = {
  plan: ListChecks,
  tool_call: Wrench,
  observation: Eye,
  verification: CheckCircle2,
  proposal: FileCheck2,
  error: AlertTriangle,
  decision: CircleDot,
  message: Bot,
};

function Meter({ label: text, used, max, format = (n: number) => n.toLocaleString('en-US') }: { label: string; used: number; max: number; format?: (n: number) => string }) {
  const ratio = max > 0 ? used / max : 0;
  return (
    <div className="meter">
      <div className="row small">
        <span className="grow muted">{text}</span>
        <span className="num">
          {format(used)} / {format(max)}
        </span>
      </div>
      <div className={`progress${ratio > 0.9 ? ' warn' : ''}`} role="progressbar" aria-label={text} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
        <span style={{ width: `${Math.max(1, Math.min(100, ratio * 100))}%` }} />
      </div>
    </div>
  );
}

export function RunTrace({ id }: { id: string }) {
  const can = useCan();
  const [poll, setPoll] = useState(true);
  const { data, error, reload } = useApi<RunDetail>(`/api/runs/${id}`, { pollMs: poll ? 2000 : undefined });
  const { run: act, busy } = useAction();
  const [cancelling, setCancelling] = useState(false);
  const [filter, setFilter] = useState<'all' | 'tools' | 'proposals' | 'problems'>('all');
  const active = data ? data.run.status === 'running' || data.run.status === 'queued' : true;
  if (data && !active && poll) setPoll(false);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={12} />;
  const r = data.run;
  const steps = data.steps.filter((s) => (filter === 'all' ? true : filter === 'tools' ? s.kind === 'tool_call' : filter === 'proposals' ? s.kind === 'proposal' || s.kind === 'decision' : s.kind === 'error' || s.tool?.status === 'error' || s.tool?.status === 'denied'));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <a href="#/runs" className="small row">
        <ArrowLeft size={14} aria-hidden="true" /> All runs
      </a>
      <div className="page-head">
        <div>
          <div className="row-wrap" style={{ marginBottom: 6 }}>
            <StatusBadge status={r.status} />
            <ModeBadge mode={r.mode} model={r.model} />
            <span className="small muted">
              v{r.version} · ontology v{r.ontologyVersion} · {label(r.trigger)}
              {r.requestedBy ? ` by ${r.requestedBy}` : ''}
            </span>
          </div>
          <h1>{r.skillName}</h1>
          <div className="sub">
            {date(r.startedAt, 'time')} · {duration(r.startedAt, r.finishedAt)}
            {r.resumeCount > 0 && ` · resumed ${r.resumeCount}x after interruption (journaled tool calls replayed)`}
          </div>
        </div>
        <div className="row-wrap">
          {r.parentRunId && (
            <a className="btn" href={`#/runs/${r.parentRunId}`}>
              Parent run
            </a>
          )}
          <a className="btn" href={`#/skills/${r.skill}`}>
            Skill and policy
          </a>
          {active && can('skill.run') && (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setCancelling(true)}>
              <Square size={14} aria-hidden="true" /> Cancel run
            </button>
          )}
        </div>
      </div>
      {r.error && (
        <div className="callout danger small" role="alert">
          <strong>{label(r.status)}:</strong> {r.error}
        </div>
      )}
      {r.summary && <div className="callout small">{r.summary}</div>}
      <div className="split">
        <div className="stack" style={{ gap: 16 }}>
          {r.plan && r.plan.length > 0 && (
            <section className="card" aria-labelledby="plan-h">
              <div className="card-head">
                <h2 id="plan-h">Plan</h2>
              </div>
              <ol className="plan">
                {r.plan.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            </section>
          )}
          <section className="card" aria-labelledby="trace-h">
            <div className="card-head">
              <h2 id="trace-h">Trace ({data.steps.length} steps)</h2>
              <select className="select" style={{ width: 'auto', minHeight: 32 }} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Filter steps">
                <option value="all">All steps</option>
                <option value="tools">Tool calls</option>
                <option value="proposals">Proposals and decisions</option>
                <option value="problems">Errors and denials</option>
              </select>
            </div>
            {steps.length === 0 ? (
              <Empty title={active ? 'Working...' : 'No steps match'} />
            ) : (
              <ol className="timeline">
                {steps.map((s) => {
                  const Icon = STEP_ICON[s.kind] ?? CircleDot;
                  const bad = s.kind === 'error' || s.tool?.status === 'error' || s.tool?.status === 'denied';
                  return (
                    <li key={s.seq} className={`tl-item${bad ? ' bad' : ''}`}>
                      <span className="tl-icon" aria-hidden="true">
                        <Icon size={14} />
                      </span>
                      <div className="grow">
                        <div className="row-wrap">
                          <span className="tiny muted mono">#{s.seq}</span>
                          <Badge>{s.phase}</Badge>
                          <strong className="small">{s.title}</strong>
                          {s.tool?.mutation && <Badge tone="attention">writes workpaper</Badge>}
                          {s.tool && s.tool.status !== 'ok' && <Badge tone="danger">{s.tool.status}</Badge>}
                          <span className="grow" />
                          {s.durationMs !== null && <span className="tiny muted">{s.durationMs} ms</span>}
                        </div>
                        {s.tool && (
                          <details className="tl-details">
                            <summary className="small">
                              <code>{s.tool.name}</code> input and output
                            </summary>
                            <div className="tiny muted">Input</div>
                            <pre className="code">{pretty(s.tool.input)}</pre>
                            <div className="tiny muted">Output{s.tool.error ? ' (error)' : ''}</div>
                            <pre className="code">{s.tool.error ?? pretty(s.tool.output)}</pre>
                          </details>
                        )}
                        {!s.tool && Object.keys(s.detail ?? {}).length > 0 && (
                          <details className="tl-details">
                            <summary className="small">Details</summary>
                            <pre className="code">{JSON.stringify(s.detail, null, 2)}</pre>
                          </details>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <section className="card card-pad stack" aria-label={'Budget'}>
            <h2 style={{ fontSize: 14.5 }}>
              <Term id="bh:RunBudget">Run budget</Term>
            </h2>
            <Meter label="Steps" used={r.stepsUsed} max={r.budget.max_steps} />
            <Meter label="Tool calls" used={r.toolCallsUsed} max={r.budget.max_tool_calls} />
            <Meter label="Tokens" used={r.tokensIn + r.tokensOut} max={r.budget.max_tokens} />
            <Meter label="Cost" used={Math.round(r.costUsd * 1e6)} max={r.budget.max_cost_usd_micros} format={(n) => `$${(n / 1e6).toFixed(2)}`} />
            {r.mode === 'live' && (
              <div className="tiny muted">
                {r.tokensIn.toLocaleString('en-US')} input · {r.tokensOut.toLocaleString('en-US')} output · {r.cacheReadTokens.toLocaleString('en-US')} cached
              </div>
            )}
          </section>
          <section className="card" aria-labelledby="props-h">
            <div className="card-head">
              <h2 id="props-h">
                <Term id="bh:Proposal">Proposals</Term> ({data.proposals.length})
              </h2>
            </div>
            {data.proposals.length === 0 ? (
              <p className="card-pad small muted">No proposals from this run.</p>
            ) : (
              <ul className="list small">
                {data.proposals.map((p) => (
                  <li key={p.id}>
                    <a href={`#/inbox/${p.id}?view=all`}>{p.title}</a>
                    <div className="row-wrap" style={{ marginTop: 4 }}>
                      <Badge>{KIND_LABELS[p.kind] ?? label(p.kind)}</Badge>
                      <StatusBadge status={p.status} />
                      {p.amount !== null && <span className="num tiny">{money(p.amount)}</span>}
                      {p.confidence !== null && <Confidence value={p.confidence} />}
                      {p.riskFlags.map((f) => (
                        <Badge key={f} tone="danger">
                          {label(f)}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {data.children.length > 0 && (
            <section className="card" aria-labelledby="kids-h">
              <div className="card-head">
                <h2 id="kids-h">Child runs ({data.children.length})</h2>
              </div>
              <ul className="list small">
                {data.children.map((c) => (
                  <li key={c.id} className="row">
                    <a className="grow" href={`#/runs/${c.id}`}>
                      {c.skill}
                    </a>
                    <span className="tiny muted">{c.proposals} proposals</span>
                    <StatusBadge status={c.status} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="card card-pad stack small" aria-label="Run facts">
            <dl className="facts">
              <dt>Input</dt>
              <dd>
                <code className="wrap">{JSON.stringify(r.input)}</code>
              </dd>
              <dt>Provider</dt>
              <dd>{r.provider ?? 'offline'}</dd>
              <dt>Idempotency key</dt>
              <dd>
                <code className="wrap">{r.idempotencyKey ?? '—'}</code>
              </dd>
              <dt>Last heartbeat</dt>
              <dd>{date(r.heartbeatAt, 'time')}</dd>
            </dl>
          </section>
        </div>
      </div>
      {cancelling && <ReasonDialog title="Cancel this run" prompt="Why are you cancelling it?" confirmLabel="Cancel run" danger minLength={0} onClose={() => setCancelling(false)} onSubmit={(reason) => act(() => api.post(`/api/runs/${id}/cancel`, { reason }), 'Run cancelled.')} />}
    </div>
  );
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json.endsWith('...') ? json.slice(0, -3) : json), null, 2);
  } catch {
    return json;
  }
}

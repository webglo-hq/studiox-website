import { ArrowLeft, Bot, CheckCircle2, CircleAlert, Eye, Flag, Hand, ListChecks, Send, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApi } from '../lib/api';
import { duration, humanize, money, period, plural, when } from '../lib/format';
import { href, navigate, type Route } from '../lib/router';
import { Badge, Card, Disclosure, Empty, Kv, LinkButton, PageHead, Query, Status } from '../ui/kit';
import { Term } from '../ui/term';

const PHASE_ICON: Record<string, ReactNode> = {
  plan: <ListChecks size={15} aria-hidden />,
  act: <Wrench size={15} aria-hidden />,
  observe: <Eye size={15} aria-hidden />,
  verify: <ShieldCheck size={15} aria-hidden />,
  propose: <Sparkles size={15} aria-hidden />,
  gate: <Hand size={15} aria-hidden />,
  post: <Send size={15} aria-hidden />,
  audit: <Flag size={15} aria-hidden />,
  finish: <CheckCircle2 size={15} aria-hidden />,
  error: <CircleAlert size={15} aria-hidden />,
};

export function Runs({ route, openId }: { route: Route; openId: string | null }) {
  void route;
  if (openId) return <RunTrace id={openId} />;
  return <RunList />;
}

function RunList() {
  const q = useApi('runs.list', { limit: 200 });
  return (
    <div className="page">
      <PageHead
        eyebrow="Agents"
        title="Agent runs"
        sub={
          <>
            Every run follows the same durable loop: plan, act through typed tools, observe, verify deterministically, propose, pass the policy gate, post or wait for a person, and audit. Open a run to see its full trace.
          </>
        }
      />
      <Card flush>
        <Query q={q} rows={10} empty={(d) => (d.length ? null : <Empty icon={<Bot size={22} />} title="No agent runs yet">Run the close agents from My close or the cockpit.</Empty>)}>
          {(runs) => (
            <div className="table-wrap">
              <table className="table" data-testid="runs-table">
                <thead>
                  <tr>
                    <th className="first" scope="col">
                      Run
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Engine</th>
                    <th scope="col" className="num">
                      Steps
                    </th>
                    <th scope="col" className="num">
                      Proposals
                    </th>
                    <th scope="col" className="last">
                      Started
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(href(`/runs/${r.id}`))}>
                      <td className="first" style={{ minWidth: 280 }}>
                        <a href={href(`/runs/${r.id}`)} className="strong small" onClick={(e) => e.stopPropagation()}>
                          {r.task ? `${r.task.code} ${r.task.title}` : humanize(r.skillId)}
                        </a>
                        <div className="xs muted">
                          {r.skillId} v{r.skillVersion} · policy v{r.policyVersion} · {humanize(r.trigger)}
                          {r.requestedBy ? ` · for ${r.requestedBy.name}` : ''}
                        </div>
                        {r.summary && <div className="xs ink2">{r.summary}</div>}
                        {r.error && <div className="xs diff-bad">{r.error}</div>}
                      </td>
                      <td>
                        <Status value={r.status} />
                      </td>
                      <td className="small">{r.engine === 'live' ? (r.model ?? 'Claude') : 'Offline'}</td>
                      <td className="num small">
                        {r.stepsUsed}/{r.maxSteps}
                      </td>
                      <td className="num small">
                        {r.proposals.total}
                        <div className="xs muted">
                          {r.proposals.auto} auto · {r.proposals.pending} waiting
                        </div>
                      </td>
                      <td className="last small nowrap">
                        {when(r.startedAt)}
                        <div className="xs muted">{duration(r.durationMs)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Query>
      </Card>
    </div>
  );
}

function RunTrace({ id }: { id: string }) {
  const q = useApi('runs.get', { id });
  return (
    <div className="page">
      <div>
        <LinkButton href="#/runs" variant="quiet" size="s" icon={<ArrowLeft size={14} aria-hidden />}>
          All runs
        </LinkButton>
      </div>
      <Query q={q} rows={12}>
        {(t) => {
          const r = t.run;
          const callsByStep = new Map<number, typeof t.toolCalls>();
          for (const c of t.toolCalls) callsByStep.set(c.stepSeq, [...(callsByStep.get(c.stepSeq) ?? []), c]);
          return (
            <>
              <PageHead
                eyebrow={
                  <>
                    <Term id="ek:AgentRun">Agent run</Term> · {r ? humanize(r.skillId) : ''} · {r?.periodKey ? period(r.periodKey) : ''}
                  </>
                }
                title={r?.task ? `${r.task.code} ${r.task.title}` : humanize(r?.skillId ?? 'Run')}
                sub={r?.summary ?? r?.error ?? undefined}
              />
              {r && (
                <div className="grid grid-4">
                  <div className="card stat">
                    <span className="label">Status</span>
                    <span>
                      <Status value={r.status} />
                    </span>
                    <span className="small muted">{duration(r.durationMs)}</span>
                  </div>
                  <div className="card stat">
                    <span className="label">Engine</span>
                    <span className="value" style={{ fontSize: '1.2rem' }}>
                      {r.engine === 'live' ? (r.model ?? 'Claude') : 'Offline'}
                    </span>
                    <span className="small muted">{r.engine === 'live' ? `${r.tokens.toLocaleString()} tokens · $${r.costUsd.toFixed(2)}` : 'deterministic playbook'}</span>
                  </div>
                  <div className="card stat">
                    <span className="label">Budget used</span>
                    <span className="value">
                      {r.stepsUsed}/{r.maxSteps}
                    </span>
                    <span className="small muted">tool calls</span>
                  </div>
                  <div className="card stat">
                    <span className="label">Proposals</span>
                    <span className="value">{r.proposals.total}</span>
                    <span className="small muted">
                      {r.proposals.auto} auto-posted · {r.proposals.pending} waiting · {r.proposals.applied} approved
                    </span>
                  </div>
                </div>
              )}
              <div className="grid grid-main">
                <Card title="Trace" hint={`${plural(t.steps.length, 'step')} · ontology ${t.ontologyVersion}`}>
                  <ol className="timeline">
                    {t.steps.map((s) => (
                      <li key={s.seq} className={`tl-step ${s.status === 'error' || s.phase === 'error' ? 'err' : s.phase}`}>
                        <span className="tl-icon" title={s.phase}>
                          {PHASE_ICON[s.phase] ?? <Bot size={15} aria-hidden />}
                        </span>
                        <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                          <div className="tl-title">
                            <span className="badge t-outline" style={{ marginRight: 6 }}>
                              {s.phase}
                            </span>
                            {s.title}
                          </div>
                          <div className="tl-meta">
                            #{s.seq} · {when(s.at)}
                            {s.tokens ? ` · ${s.tokens.toLocaleString()} tokens` : ''}
                          </div>
                          {(callsByStep.get(s.seq) ?? []).map((c, i) => (
                            <Disclosure key={i} summary={<span className="mono xs">{c.tool}({c.status}) · {duration(c.durationMs)}</span>}>
                              <div className="stack" style={{ gap: 6 }}>
                                <span className="xs muted">Input</span>
                                <pre className="code">{JSON.stringify(c.input, null, 2)}</pre>
                                <span className="xs muted">Output</span>
                                <pre className="code">{c.error ?? JSON.stringify(c.output, null, 2)}</pre>
                                <span className="xs muted mono">idempotency key {c.idempotencyKey}</span>
                              </div>
                            </Disclosure>
                          ))}
                          {s.detail !== null && s.detail !== undefined && !(callsByStep.get(s.seq) ?? []).length && typeof s.detail === 'object' && Object.keys(s.detail as object).length > 0 && (
                            <Disclosure summary={<span className="xs">Details</span>}>
                              <pre className="code">{JSON.stringify(s.detail, null, 2)}</pre>
                            </Disclosure>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </Card>
                <div className="stack-l">
                  <Card title="Proposals" flush>
                    {t.proposals.length ? (
                      <div className="list">
                        {t.proposals.map((p) => (
                          <a key={p.id} className="list-item" href={href(`/inbox/${p.id}`)}>
                            <span className="grow small">
                              {p.title}
                              <div className="xs muted">
                                {humanize(p.kind)} · {Math.round(p.confidence * 100)}% · gate {p.gate ?? '—'}
                              </div>
                            </span>
                            {p.amount !== null && <span className="small num">{money(p.amount, p.currency ?? 'USD')}</span>}
                            <Status value={p.status} />
                          </a>
                        ))}
                      </div>
                    ) : (
                      <Empty title="No proposals" />
                    )}
                  </Card>
                  {t.children.length > 0 && (
                    <Card title="Tasks this run dispatched" flush>
                      <div className="list">
                        {t.children.map((c) => (
                          <a key={c.id} className="list-item" href={href(`/runs/${c.id}`)}>
                            <span className="grow small">
                              {c.task ? `${c.task.code} ${c.task.title}` : c.skillId}
                              <div className="xs muted">{c.summary}</div>
                            </span>
                            <Status value={c.status} />
                          </a>
                        ))}
                      </div>
                    </Card>
                  )}
                  <Card title="Input">
                    <pre className="code">{JSON.stringify(t.input, null, 2)}</pre>
                    {t.parent && (
                      <p className="small" style={{ marginTop: 8 }}>
                        Started by <a href={href(`/runs/${t.parent.id}`)}>{humanize(t.parent.skillId)}</a>
                      </p>
                    )}
                  </Card>
                  {r && (
                    <Card title="Who and when">
                      <Kv items={[['Requested by', r.requestedBy?.name ?? 'system'], ['Trigger', humanize(r.trigger)], ['Started', when(r.startedAt)], ['Finished', when(r.finishedAt)]]} />
                      <div style={{ marginTop: 8 }}>
                        <Badge>
                          {r.skillId} v{r.skillVersion}
                        </Badge>
                      </div>
                    </Card>
                  )}
                </div>
              </div>
            </>
          );
        }}
      </Query>
    </div>
  );
}

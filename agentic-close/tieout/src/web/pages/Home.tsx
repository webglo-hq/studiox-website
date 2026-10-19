/** "My close": what needs me today, how far the close is, and the one button that starts the agents. */
import { ArrowRight, Bot, CircleCheck, FileText, Lock, Play } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, type CloseRunResult, type HomeData } from '../api';
import { Badge, Confidence, Dialog, ErrorBox, FlagBadges, Loading, Meter, Money, ProposalStatus, Stat, Term } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { date, dateTime, KIND_LABEL, periodName } from '../lib/format';

export function Home() {
  const me = useMe();
  const { period, toast, bump } = useApp();
  const { data, error, loading, reload } = useData(() => api<HomeData>(`/home?period=${period}`), [period]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CloseRunResult | null>(null);

  async function runAgents() {
    setRunning(true);
    try {
      const r = await api<CloseRunResult>(`/close/${period}/run-agents`, { body: {} });
      setResult(r);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'The agents could not start.', 'bad');
    } finally {
      setRunning(false);
    }
  }

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading your close" />;
  const first = me.user.name.split(' ')[0];
  const closed = data.closed;
  return (
    <div className={loading ? 'skeleton' : undefined}>
      <div className="page-head">
        <div>
          <h1>Welcome back, {first}.</h1>
          {closed ? (
            <p className="lede">
              {periodName(period)} is closed: every entity was locked{closed.by ? ` by ${closed.by}` : ''}
              {closed.at ? ` on ${dateTime(closed.at)}` : ''}. Nothing more posts to it; reopening needs a documented reason.
            </p>
          ) : (
            <p className="lede">
              {periodName(period)} close · <strong>{data.workday ?? '—'}</strong> ({date(data.businessDate, true)}). {data.progress.done} of {data.progress.total} checklist tasks are done
              {data.closePeriod ? `; target close ${date(data.closePeriod.target_close_date)}` : ''}.
            </p>
          )}
        </div>
        <div className="actions">
          {closed && data.latestPackage ? (
            <a className="btn primary big" href={`#/package/${data.latestPackage.id}`}>
              <FileText className="icon" aria-hidden="true" /> Open the close package
            </a>
          ) : null}
          {!closed && can(me, 'agent.run') ? (
            <button className="btn primary big" onClick={() => void runAgents()} disabled={running} aria-busy={running}>
              <Play className="icon" aria-hidden="true" />
              {running ? 'Agents are working…' : data.agentsRun ? 'Run close agents again' : 'Run close agents'}
            </button>
          ) : null}
          <a className="btn big" href="#/inbox">
            Open inbox <ArrowRight className="icon" aria-hidden="true" />
          </a>
        </div>
      </div>

      {closed ? (
        <div className="callout good" style={{ marginBottom: 16 }}>
          <Lock className="icon" aria-hidden="true" />
          <div>
            <strong>{periodName(period)} is closed.</strong> Every proposal was decided, every reconciliation reviewed, every significant variance explained and the close package signed
            {data.latestPackage ? ` (version ${data.latestPackage.version}, ${data.latestPackage.status})` : ''}. The trail is in the <a href="#/audit">audit log</a>.
          </div>
        </div>
      ) : !data.agentsRun ? (
        <div className="callout info" style={{ marginBottom: 16 }}>
          <Bot className="icon" aria-hidden="true" />
          <div>
            <strong>The agents haven’t run for {periodName(period)} yet.</strong> Bank and card feeds were imported at 06:05. Running the close agents reconciles the bank, codes card spend, rolls schedules, finds accruals, matches intercompany,
            remeasures FX, reviews journal entries and drafts variance explanations — about a second offline. Nothing posts without a person unless the Controller’s policy allows it.
          </div>
        </div>
      ) : null}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Waiting for you" value={<span>{data.inbox.awaitingMe}</span>} sub={<a href="#/inbox">{data.inbox.pending} need approval overall</a>} />
        <Stat label="Applied by policy" value={data.inbox.autoApplied} sub={<span>{data.inbox.reviewQueue} sampled for review</span>} />
        <div className="card stat">
          <div className="label">Close progress</div>
          <div className="value">
            {data.progress.done}/{data.progress.total}
          </div>
          <div style={{ marginTop: 8 }}>
            <Meter value={data.progress.done} max={data.progress.total} label="Checklist tasks done" />
          </div>
        </div>
        <Stat
          label={closed ? 'Period' : 'Ready to lock'}
          value={closed ? 'Locked' : data.readiness.ready ? 'Yes' : 'Not yet'}
          sub={
            closed ? (
              'Closed for every entity'
            ) : data.readiness.ready ? (
              'Every lock condition holds'
            ) : (
              <span>
                {data.readiness.messages.length} <Term id="tie:LockedPeriod">lock conditions</Term> open
              </span>
            )
          }
        />
      </div>

      <div className="grid main-side">
        <section className="card" aria-labelledby="h-wait">
          <div className="card-head">
            <h2 id="h-wait">Needs a decision</h2>
            <span className="right">
              <a href="#/inbox" className="btn small ghost">
                All {data.inbox.pending + data.inbox.suggested} <ArrowRight className="icon" aria-hidden="true" />
              </a>
            </span>
          </div>
          {data.highlights.length ? (
            data.highlights.map((p) => (
              <div className="prop" key={p.id}>
                <span className="badge neutral">{p.ref}</span>
                <div>
                  <a className="title" href={`#/inbox?open=${p.id}`}>
                    {p.title}
                  </a>
                  <p className="why">{p.why}</p>
                  <div className="meta">
                    <span>{KIND_LABEL[p.kind]}</span>
                    <ProposalStatus status={p.status} route={p.route} reviewStatus={p.reviewStatus} />
                    <FlagBadges flags={p.flags} />
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <Money minor={p.amountMinor} currency={p.currency} />
                  <div>
                    <Confidence value={p.confidence} />
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="empty">
              <CircleCheck className="icon" aria-hidden="true" /> Nothing is waiting. {data.agentsRun ? 'Every agent proposal has been decided.' : 'Run the close agents to get started.'}
            </div>
          )}
        </section>

        <div className="stack">
          <section className="card" aria-labelledby="h-tasks">
            <div className="card-head">
              <h2 id="h-tasks">Your tasks</h2>
              <span className="right">
                <a className="btn small ghost" href="#/close">
                  Checklist
                </a>
              </span>
            </div>
            {data.myTasks.length ? (
              data.myTasks.map((t) => (
                <div className="task" key={t.id}>
                  <span className={`tick ${t.status === 'ready_for_review' ? 'review' : t.status === 'in_progress' ? 'progress' : t.status === 'blocked' ? 'blocked' : ''}`} aria-hidden="true" />
                  <div>
                    <div className="title">{t.title}</div>
                    <div className="meta">
                      Due {t.dueLabel} ({date(t.due_date)}) · {t.owner_id === me.user.id ? 'You prepare' : 'You review'}
                      {t.openDependencies.length ? ` · waiting on ${t.openDependencies.join(', ')}` : ''}
                    </div>
                  </div>
                  <Badge tone={t.overdue ? 'bad' : t.status === 'ready_for_review' ? 'info' : 'neutral'}>{t.overdue ? 'Overdue' : t.status.replace(/_/g, ' ')}</Badge>
                </div>
              ))
            ) : (
              <div className="empty">No open tasks assigned to you.</div>
            )}
          </section>

          <section className="card card-pad" aria-labelledby="h-ready">
            <h2 id="h-ready" style={{ marginBottom: 8 }}>
              {closed ? 'Period locked' : 'Before the period can lock'}
            </h2>
            {closed ? (
              <p>
                <Badge tone="good">Locked</Badge> All conditions of <code>AX-CL-02</code> held at the lock.
              </p>
            ) : data.readiness.ready ? (
              <p>
                <Badge tone="good">Ready</Badge> All conditions of <code>AX-CL-02</code> hold.
              </p>
            ) : (
              <ul className="checks">
                {data.readiness.messages.map((m) => (
                  <li key={m}>
                    <Badge tone="warn" icon={false}>
                      Open
                    </Badge>
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="h-runs">
            <div className="card-head">
              <h2 id="h-runs">Recent agent runs</h2>
              <span className="right">
                <a className="btn small ghost" href="#/runs">
                  All runs
                </a>
              </span>
            </div>
            {data.runs.length ? (
              <ul className="checks" style={{ padding: '6px 16px' }}>
                {data.runs.slice(0, 6).map((r) => (
                  <li key={r.id}>
                    <a href={`#/runs/${r.id}`} className="mono" style={{ minWidth: 58 }}>
                      {r.ref}
                    </a>
                    <span style={{ fontSize: 13 }}>{r.headline ?? r.skillKey}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty">No runs yet.</div>
            )}
          </section>
        </div>
      </div>

      <Dialog open={!!result} onClose={() => setResult(null)} title="Close agents finished" actions={<a className="btn primary" href="#/inbox" onClick={() => setResult(null)}>Review the inbox</a>}>
        {result ? (
          <>
            <p>
              {result.tasks.filter((t) => t.outcome === 'succeeded').length} of {result.tasks.length} checklist tasks ran in {result.waves.length} dependency waves.
            </p>
            <ul className="checks">
              {result.tasks.map((t) => (
                <li key={t.key}>
                  <Badge tone={t.outcome === 'succeeded' ? 'good' : t.outcome === 'skipped' ? 'warn' : 'bad'}>
                    {t.key}
                  </Badge>
                  <span style={{ fontSize: 13 }}>{t.runs.map((r) => r.headline).join(' · ') || 'Skipped: a prerequisite did not finish.'}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}

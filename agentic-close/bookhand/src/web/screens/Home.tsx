import { ArrowRight, Bot, CheckCircle2, CircleDot, Clock, Inbox as InboxIcon, Lightbulb, Loader2, Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ago, date, label } from '../lib/format';
import { storage, useAction, useApi, useCan, useMe } from '../lib/hooks';
import { Badge, ErrorBox, Progress, Skeleton, StatusBadge, Term } from '../components/ui';

interface HomeData {
  user: { name: string; firstName: string; title: string | null; roles: string[] };
  tenant: { name: string; isDemo: boolean };
  businessDate: string;
  mode: { live: boolean; model: string | null };
  close: { id: string; name: string; periodEnd: string; status: string; targetWorkday: number; currentWorkday: number; currentWorkdayLabel: string; progress: { total: number; done: number; review: number; inProgress: number; blocked: number; pct: number } } | null;
  agents: { runId: string; status: string; startedBy: string; startedAt: string; finishedAt: string | null; working: number; proposals: number; autoApplied: number; waiting: number } | null;
  next: Array<{ id: string; title: string; detail: string; href: string; count?: number; tone: string }>;
  myTasks: Array<{ id: string; title: string; status: string; dueDate: string; dueWorkday: number; role: string; skillKey: string | null; ready: boolean; blockedBy: string[]; blockedReason: string | null; overdue: boolean }>;
  inbox: { pendingForMe: number; blockedForMe: number };
  recentRuns: Array<{ id: string; skill: string; status: string; summary: string | null; at: string; proposals: number }>;
  activity: Array<{ seq: number; at: string; actor: string; actorType: string; action: string; summary: string }>;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const TOUR = [
  { title: 'Start from "What\'s next"', body: 'Bookhand ranks what needs you now: agents to run, items to approve, reconciliations to certify.' },
  { title: 'Agents propose, you decide', body: 'Every proposal says why, how confident the agent is, and which ontology checks it passed. Routine items under your policy apply automatically and are sampled for review.' },
  { title: 'Controls are built in', body: 'Approval limits, maker-checker and segregation-of-duties rules decide who can approve what. Every action lands in a hash-chained audit log.' },
  { title: 'Undo is a reversal', body: 'Posted entries never change. Reversing creates a mirror entry, so the trail stays complete.' },
];

/** What the latest "Run close agents" is doing, and once it is done, the call to review what it left. */
function CloseAgentsCard({ agents, canReview }: { agents: NonNullable<HomeData['agents']>; canReview: boolean }) {
  const done = agents.working === 0;
  return (
    <section className="card card-pad agents-card" aria-labelledby="agents-h" role="status" aria-live="polite">
      <div className="row-wrap">
        {done ? <CheckCircle2 size={20} className="pos" aria-hidden="true" /> : <Loader2 size={20} className="spin" aria-hidden="true" />}
        <div className="grow">
          <h2 id="agents-h" style={{ fontSize: 16 }}>
            {done ? 'Close agents finished' : 'Close agents are working'}
          </h2>
          <div className="small text-2">
            {done
              ? `${agents.proposals} change${agents.proposals === 1 ? '' : 's'} proposed: ${agents.autoApplied} applied under your autonomy policy, ${agents.waiting} wait${agents.waiting === 1 ? 's' : ''} for review. Started by ${agents.startedBy} ${ago(agents.startedAt)}.`
              : `${agents.working} agent run${agents.working === 1 ? '' : 's'} in progress, started by ${agents.startedBy} ${ago(agents.startedAt)}. Their proposals land in the inbox as they finish.`}
          </div>
        </div>
        <a className="btn btn-sm btn-ghost" href={`#/runs/${agents.runId}`}>
          {done ? 'Open the agent trace' : 'Watch the agent trace'}
        </a>
        {done && canReview && agents.waiting > 0 && (
          <a className="btn btn-primary" href="#/inbox">
            <InboxIcon size={16} aria-hidden="true" /> Review {agents.waiting} item{agents.waiting === 1 ? '' : 's'}
          </a>
        )}
      </div>
    </section>
  );
}

export function HomeScreen() {
  const me = useMe();
  const can = useCan();
  // Poll quickly while the close agents work, so their outcome and the next step appear as soon as they finish.
  const [working, setWorking] = useState(false);
  const { data, error, loading, reload } = useApi<HomeData>('/api/home', { pollMs: working ? 2000 : 8000 });
  const { run, busy } = useAction();
  const tourKey = `bh-tour-${me.user.id}`;
  const [tour, setTour] = useState(storage.get(tourKey) !== 'done');
  const [step, setStep] = useState(0);
  useEffect(() => setWorking((data?.agents?.working ?? 0) > 0), [data]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data || loading && !data) return <Skeleton rows={8} />;
  const c = data.close;
  // Starting the agents keeps you here: My close shows them working, then what they left for people to review.
  const runAgents = async () => {
    if (!c) return;
    const r = await run(() => api.post<{ runId: string; alreadyRunning?: boolean }>(`/api/closes/${c.id}/run`, {}), (x) => (x.alreadyRunning ? 'The close agents are already running.' : 'Close agents started. Their results land here and in the inbox.'));
    if (r?.runId) setWorking(true);
  };
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div>
          <h1>
            {greeting()}, {data.user.firstName}
          </h1>
          <div className="sub">
            {c ? (
              <>
                {c.name} · business date {date(data.businessDate, 'long')} ·{' '}
                <Term id="bh:Workday">
                  {c.currentWorkdayLabel} of a WD{c.targetWorkday} target
                </Term>
              </>
            ) : (
              'No close is open.'
            )}
          </div>
        </div>
        {c && can('skill.run') && c.status !== 'closed' && (
          <button type="button" className="btn btn-primary" onClick={() => void runAgents()} disabled={busy}>
            <Play size={16} aria-hidden="true" /> Run close agents
          </button>
        )}
      </div>

      {data.agents && c && c.status !== 'closed' && <CloseAgentsCard agents={data.agents} canReview={can('proposal.view')} />}

      {tour && (
        <section className="card card-pad tour" aria-label="Getting started">
          <div className="row">
            <Lightbulb size={18} className="pos" aria-hidden="true" />
            <strong className="grow">
              Getting started · {step + 1} of {TOUR.length}: {TOUR[step]!.title}
            </strong>
            <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss the tour" onClick={() => { storage.set(tourKey, 'done'); setTour(false); }}>
              <X size={16} />
            </button>
          </div>
          <p className="text-2" style={{ margin: '6px 0 10px 26px' }}>
            {TOUR[step]!.body}
          </p>
          <div className="row" style={{ marginLeft: 26 }}>
            {step > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            {step < TOUR.length - 1 ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setStep(step + 1)}>
                Next
              </button>
            ) : (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => { storage.set(tourKey, 'done'); setTour(false); }}>
                Got it
              </button>
            )}
          </div>
        </section>
      )}

      <div className="split">
        <section className="card" aria-labelledby="next-h">
          <div className="card-head">
            <h2 id="next-h">What's next for you</h2>
            {data.inbox.pendingForMe > 0 && <Badge tone="attention">{data.inbox.pendingForMe} to approve</Badge>}
          </div>
          <ol className="list next-list">
            {data.next.map((n, i) => (
              <li key={n.id}>
                <a href={n.href} className={`next-item tone-${n.tone}`} onClick={(e) => { if (n.id === 'run-agents') { e.preventDefault(); void runAgents(); } }}>
                  <span className="next-num" aria-hidden="true">{n.tone === 'done' ? <CheckCircle2 size={18} /> : i + 1}</span>
                  <span className="grow">
                    <span style={{ display: 'block', fontWeight: 600 }}>{n.title}</span>
                    <span className="small text-2">{n.detail}</span>
                  </span>
                  <ArrowRight size={16} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ol>
        </section>
        {c && (
          <section className="card card-pad stack" aria-labelledby="progress-h">
            <div className="row">
              <h2 id="progress-h" className="grow">
                Close progress
              </h2>
              <a href={`#/close/${c.id}`} className="small">
                Open cockpit
              </a>
            </div>
            <div className="row" style={{ alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 34, fontWeight: 650, letterSpacing: '-0.02em' }} className="num">
                {Math.round(c.progress.pct * 100)}%
              </span>
              <span className="muted small">
                {c.progress.done} of {c.progress.total} tasks signed off
              </span>
            </div>
            <Progress value={c.progress.pct} label="Close progress" />
            <div className="grid grid-3 small">
              <div>
                <div className="muted">In review</div>
                <strong>{c.progress.review}</strong>
              </div>
              <div>
                <div className="muted">In progress</div>
                <strong>{c.progress.inProgress}</strong>
              </div>
              <div>
                <div className="muted">Waiting on others</div>
                <strong>{c.progress.blocked}</strong>
              </div>
            </div>
          </section>
        )}
      </div>

      <div className="grid grid-2">
        <section className="card" aria-labelledby="tasks-h">
          <div className="card-head">
            <h2 id="tasks-h">My tasks</h2>
            <span className="muted small">{data.myTasks.length} open</span>
          </div>
          {data.myTasks.length === 0 ? (
            <div className="empty small">Nothing assigned to you is open.</div>
          ) : (
            <ul className="list">
              {data.myTasks.map((t) => (
                <li key={t.id} className="row">
                  {t.ready ? <CircleDot size={16} className="pos" aria-hidden="true" /> : <Clock size={16} className="muted" aria-hidden="true" />}
                  <span className="grow">
                    <a href={c ? `#/close/${c.id}?task=${t.id}` : '#/'} style={{ fontWeight: 550, color: 'var(--text)' }}>
                      {t.title}
                    </a>
                    <span className="tiny muted" style={{ display: 'block' }}>
                      {t.role === 'reviewer' ? 'You review' : 'You own'} · due WD{t.dueWorkday} ({date(t.dueDate)}){t.blockedReason ? ` · ${t.blockedReason}` : !t.ready && t.blockedBy.length ? ` · waiting on ${t.blockedBy.slice(0, 2).join(', ')}` : ''}
                    </span>
                  </span>
                  {t.overdue && <Badge tone="danger">Overdue</Badge>}
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="runs-h">
          <div className="card-head">
            <h2 id="runs-h">Recent agent runs</h2>
            <a href="#/runs" className="small">
              All runs
            </a>
          </div>
          {data.recentRuns.length === 0 ? (
            <div className="empty small">
              <Bot size={22} aria-hidden="true" />
              <p>No agent has run yet this close.</p>
            </div>
          ) : (
            <ul className="list">
              {data.recentRuns.map((r) => (
                <li key={r.id}>
                  <a href={`#/runs/${r.id}`} className="row" style={{ color: 'inherit' }}>
                    <Bot size={16} aria-hidden="true" />
                    <span className="grow">
                      <span style={{ display: 'block', fontWeight: 550 }}>{label(r.skill)}</span>
                      <span className="tiny muted ellipsis" style={{ display: 'block' }}>
                        {r.summary ?? 'Running...'}
                      </span>
                    </span>
                    <StatusBadge status={r.status} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="activity-h">
        <div className="card-head">
          <h2 id="activity-h">Latest activity</h2>
          {can('audit.view') && (
            <a href="#/audit" className="small">
              Audit log
            </a>
          )}
        </div>
        <ul className="list">
          {data.activity.map((a) => (
            <li key={a.seq} className="row small">
              <Badge tone={a.actorType === 'agent' ? 'violet' : a.actorType === 'system' ? '' : 'info'}>{a.actorType}</Badge>
              <span className="grow">
                <strong>{a.actor}</strong> <span className="text-2">{a.summary}</span>
              </span>
              <span className="muted tiny">{ago(a.at)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

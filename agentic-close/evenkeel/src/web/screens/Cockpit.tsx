import { Bot, CheckCircle2, CircleAlert, Lock, Play, RotateCcw, Unlock } from 'lucide-react';
import { useState } from 'react';
import type { MethodOutput } from '../../app/methods';
import { useAgents } from '../lib/agents';
import { useAction, useApi } from '../lib/api';
import { date, humanize, period, plural } from '../lib/format';
import { href } from '../lib/router';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Dialog, Field, Notice, PageHead, Person, Progress, Query, Status } from '../ui/kit';
import { Term } from '../ui/term';

type Calendar = MethodOutput<'close.calendar'>;
type Task = Calendar['tasks'][number];

function TaskActions({ t }: { t: Task }) {
  const { info, can } = useSession();
  const me = info.user.id;
  const run = useAction('close.runTask', { success: (o) => o.summary ?? 'Agent finished.' });
  const update = useAction('close.updateTask', { success: (_o, i) => (i.action === 'complete' ? `${t.code} completed.` : i.action === 'prepare' ? `${t.code} marked prepared.` : i.action === 'reopen' ? `${t.code} reopened.` : 'Task updated.') });
  const canRun = !!t.skillId && t.status !== 'complete' && can('agent.run') && (t.owner?.id === me || can('agent.orchestrate'));
  const canPrepare = (t.status === 'in_progress' || t.status === 'not_started') && t.owner?.id === me && !t.skillId;
  const canComplete = t.status === 'ready_for_review' && can('close.task.review') && (t.preparedBy?.id ?? t.owner?.id) !== me;
  const canReopen = t.status === 'complete' && can('close.task.review');
  return (
    <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
      {canRun && (
        <Button size="s" icon={<Play size={14} aria-hidden />} busy={run.isPending} onClick={() => run.mutate({ taskId: t.id })} title={`Run the ${t.skillId} agent for ${t.code}`}>
          {t.runs ? 'Re-run' : 'Run agent'}
        </Button>
      )}
      {canPrepare && (
        <Button size="s" busy={update.isPending} onClick={() => update.mutate({ taskId: t.id, action: 'prepare' })}>
          Mark prepared
        </Button>
      )}
      {canComplete && (
        <Button size="s" variant="good" icon={<CheckCircle2 size={14} aria-hidden />} busy={update.isPending} onClick={() => update.mutate({ taskId: t.id, action: 'complete' })} data-testid={`complete-${t.code}`}>
          Complete review
        </Button>
      )}
      {canReopen && (
        <Button size="s" variant="quiet" icon={<RotateCcw size={14} aria-hidden />} busy={update.isPending} onClick={() => update.mutate({ taskId: t.id, action: 'reopen', note: 'Reopened from the cockpit' })}>
          Reopen
        </Button>
      )}
    </div>
  );
}

function LockDialog({ periodKey, onClose }: { periodKey: string; onClose: () => void }) {
  const [statement, setStatement] = useState(`I confirm the ${period(periodKey)} books are complete and reviewed.`);
  const lock = useAction('close.lock', { success: `${period(periodKey)} is locked. Further changes need a reopening with a reason.`, onSuccess: onClose });
  return (
    <Dialog
      title={`Lock ${period(periodKey)}`}
      description="Locking (hard close) stops every posting to the month for all entities. Only a CFO can reopen it, with a recorded reason."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Lock size={16} aria-hidden />} busy={lock.isPending} onClick={() => lock.mutate({ periodKey, statement })} data-testid="confirm-lock">
            Lock the month
          </Button>
        </>
      }
    >
      <Field label="Sign-off statement" htmlFor="lock-statement" help="Recorded in the audit log with your name and the time.">
        <textarea id="lock-statement" className="textarea" value={statement} onChange={(e) => setStatement(e.target.value)} maxLength={500} />
      </Field>
    </Dialog>
  );
}

function ReopenDialog({ periodKey, onClose }: { periodKey: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const reopen = useAction('close.reopen', { success: `${period(periodKey)} reopened.`, onSuccess: onClose });
  return (
    <Dialog
      title={`Reopen ${period(periodKey)}`}
      description="Reopening a locked month is rare and always audited. Say what needs to change."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<Unlock size={16} aria-hidden />} busy={reopen.isPending} disabled={reason.trim().length < 10} onClick={() => reopen.mutate({ periodKey, reason })}>
            Reopen
          </Button>
        </>
      }
    >
      <Field label="Reason (at least 10 characters)" htmlFor="reopen-reason">
        <textarea id="reopen-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </Field>
    </Dialog>
  );
}

export function Cockpit() {
  const { can } = useSession();
  const cal = useApi('close.calendar', {});
  const ready = useApi('close.lockReadiness', {});
  const agents = useAgents();
  const orchestrate = useAction('close.orchestrate', { success: (o) => (o.background ? 'The agents are working. This page updates as each task finishes.' : (o.summary ?? 'The agents finished.')), onSuccess: (o) => o.background && agents.expect() });
  const [lockOpen, setLockOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  return (
    <div className="page">
      <Query q={cal} rows={10}>
        {(c) => {
          const locked = c.periodStatus.every((p) => p.status === 'hard_close');
          const byWd = new Map<string, Task[]>();
          for (const t of c.tasks) byWd.set(t.workdayLabel, [...(byWd.get(t.workdayLabel) ?? []), t]);
          return (
            <>
              <PageHead
                eyebrow={`Close cockpit · today is ${c.todayWorkday}`}
                title={`${period(c.periodKey)} close`}
                sub={
                  <>
                    {plural(c.progress.total, 'task')} across three entities, ordered by the <Term id="ek:CloseCycle">close calendar</Term>. Target {`WD+${c.cycle.targetWorkday}`} ({date(c.cycle.targetDate, 'short')}).
                  </>
                }
                actions={
                  <>
                    {can('agent.orchestrate') && !locked && (
                      <Button variant="primary" icon={<Bot size={16} aria-hidden />} busy={orchestrate.isPending || agents.running} onClick={() => orchestrate.mutate({})} data-testid="run-agents">
                        {c.tasks.some((t) => t.runs > 0) ? 'Continue agents' : 'Run all agents'}
                      </Button>
                    )}
                    {can('period.lock') && !locked && (
                      <Button icon={<Lock size={16} aria-hidden />} onClick={() => setLockOpen(true)} disabled={!ready.data?.ok} title={ready.data?.ok ? 'Every check passes' : 'Clear the checks below first'} data-testid="lock-period">
                        Lock month
                      </Button>
                    )}
                    {locked && can('period.reopen') && (
                      <Button variant="danger" icon={<Unlock size={16} aria-hidden />} onClick={() => setReopenOpen(true)}>
                        Reopen
                      </Button>
                    )}
                  </>
                }
              />

              {locked && (
                <Notice tone="good" title={`${period(c.periodKey)} is locked`}>
                  All entities are hard-closed. The ledger refuses any posting dated in this month.
                </Notice>
              )}

              <div className="grid grid-main">
                <Card title="Progress" hint={`${c.progress.pct}% complete`}>
                  <div className="stack">
                    <Progress done={c.progress.complete} review={c.progress.readyForReview} work={c.progress.inProgress} total={c.progress.total} label={`${c.progress.complete} complete, ${c.progress.readyForReview} ready for review, ${c.progress.inProgress} in progress of ${c.progress.total}`} />
                    <div className="row-wrap small">
                      <Badge tone="good">{c.progress.complete} complete</Badge>
                      <Badge tone="accent">{c.progress.readyForReview} ready for review</Badge>
                      <Badge tone="info">{c.progress.inProgress} in progress</Badge>
                      <Badge>{c.progress.notStarted} not started</Badge>
                      {c.pendingProposals > 0 && (
                        <a href="#/inbox" className="badge t-warn">
                          {plural(c.pendingProposals, 'proposal')} waiting
                        </a>
                      )}
                    </div>
                    <div className="row-wrap small">
                      {c.periodStatus.map((p) => (
                        <span key={p.entityCode} className="row" style={{ gap: 6 }}>
                          <strong>{p.entityCode}</strong> <Status value={p.status} />
                        </span>
                      ))}
                    </div>
                    <WorkdayStrip byWd={byWd} today={c.todayWorkday} target={`WD+${c.cycle.targetWorkday}`} />
                  </div>
                </Card>
                <Card title="Lock readiness" hint={<Term id="AX-CLS-02">What must be true to lock</Term>}>
                  <Query q={ready} rows={4}>
                    {(r) => (
                      <ul className="stack small" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 8 }} data-testid="lock-checks">
                        {r.checks.map((ch) => (
                          <li key={ch.id} className="row" style={{ alignItems: 'flex-start' }}>
                            {ch.ok ? <CheckCircle2 size={16} color="var(--good)" aria-label="Passes" /> : <CircleAlert size={16} color="var(--warn)" aria-label="Not yet" />}
                            <span>
                              <strong>{ch.label}</strong> <span className="ink2">{ch.detail}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Query>
                </Card>
              </div>

              {c.blockers.length > 0 && !locked && (
                <Card title="Waiting on people" hint="Tasks whose inputs are not approved yet">
                  <ul className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
                    {c.blockers.map((b) => (
                      <li key={b.taskCode}>
                        <strong>
                          {b.taskCode} {b.title}
                        </strong>{' '}
                        <span className="ink2">waits on {b.waitingOn.map((w) => `${w.code} (${w.reason})`).join(', ')}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <Card title="Close calendar" hint="Tasks by business day after month end" flush>
                <div className="table-wrap">
                  <table className="table" data-testid="task-table">
                    <thead>
                      <tr>
                        <th className="first" scope="col">
                          Task
                        </th>
                        <th scope="col">Owner → reviewer</th>
                        <th scope="col">Due</th>
                        <th scope="col">Status</th>
                        <th scope="col">Agent</th>
                        <th scope="col" className="last num">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...byWd.entries()].map(([wd, tasks]) => (
                        <FragmentRows key={wd} wd={wd} tasks={tasks} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              {lockOpen && <LockDialog periodKey={c.periodKey} onClose={() => setLockOpen(false)} />}
              {reopenOpen && <ReopenDialog periodKey={c.periodKey} onClose={() => setReopenOpen(false)} />}
            </>
          );
        }}
      </Query>
    </div>
  );
}

/** The close calendar at a glance: each business day's tasks, coloured by status. */
function WorkdayStrip({ byWd, today, target }: { byWd: Map<string, Task[]>; today: string; target: string }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="xs muted strong">Calendar by business day</div>
      <ul className="wd-strip">
        {[...byWd.entries()].map(([wd, tasks]) => (
          <li key={wd} className={`wd-col${wd === today ? ' today' : ''}`}>
            <div className="wd-label">
              {wd}
              {wd === today && <span className="wd-flag">today</span>}
              {wd === target && wd !== today && <span className="wd-flag target">target</span>}
            </div>
            <span className="sr-only">{tasks.map((t) => `${t.code} ${t.title}: ${humanize(t.status)}`).join('; ')}</span>
            <div className="wd-pills" aria-hidden>
              {tasks.map((t) => (
                <span key={t.id} className={`wd-pill s-${t.status}`} title={`${t.code} ${t.title} — ${humanize(t.status)}`}>
                  {t.code}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FragmentRows({ wd, tasks }: { wd: string; tasks: Task[] }) {
  return (
    <>
      <tr className="section">
        <td colSpan={6} className="first">
          {wd}
        </td>
      </tr>
      {tasks.map((t) => (
        <tr key={t.id} data-testid={`task-${t.code}`}>
          <td className="first" style={{ minWidth: 240 }}>
            <div className="strong">
              <span className="mono muted small">{t.code}</span> {t.title}
            </div>
            <div className="xs muted">
              {t.entityCode ?? 'All entities'}
              {t.control ? ` · control ${t.control}` : ''}
              {t.blockedBy.length ? ` · waits on ${t.blockedBy.map((b) => b.code).join(', ')}` : ''}
            </div>
            {t.recs.length > 0 && (
              <div className="row-wrap" style={{ marginTop: 4 }}>
                {t.recs.map((r) => (
                  <a key={r.id} href={href(`/recs/${r.id}`)} className="badge t-outline">
                    {r.title}
                  </a>
                ))}
              </div>
            )}
          </td>
          <td style={{ minWidth: 170 }}>
            <Person name={t.owner?.name} />
            <div className="xs muted" style={{ marginTop: 2 }}>
              → {t.reviewer?.name ?? 'no reviewer'}
            </div>
          </td>
          <td className="nowrap small">
            {t.dueLabel}
            {t.overdue && (
              <div>
                <Badge tone="bad">Overdue</Badge>
              </div>
            )}
          </td>
          <td>
            <Status value={t.status} />
          </td>
          <td style={{ minWidth: 200 }} className="small">
            {t.skillId ? (
              t.lastRun ? (
                <a href={href(`/runs/${t.lastRun.id}`)} className="ink2" style={{ textDecoration: 'none' }}>
                  <span className="row" style={{ gap: 6 }}>
                    <Status value={t.lastRun.status} />
                    {t.pendingProposals > 0 && <Badge tone="warn">{t.pendingProposals} waiting</Badge>}
                  </span>
                  <span className="xs muted">{t.lastRun.summary}</span>
                </a>
              ) : (
                <span className="muted">Not run yet</span>
              )
            ) : (
              <span className="muted">Manual task</span>
            )}
          </td>
          <td className="last">
            <TaskActions t={t} />
          </td>
        </tr>
      ))}
    </>
  );
}

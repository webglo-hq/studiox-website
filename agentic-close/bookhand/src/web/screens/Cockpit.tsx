import { AlertCircle, Bot, CheckCheck, FileText, Lock, Play, RotateCcw, Unlock } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { date, label } from '../lib/format';
import { navigate, useAction, useApi, useCan, useRoute } from '../lib/hooks';
import { Avatar, Badge, Drawer, Empty, ErrorBox, Modal, Progress, ReasonDialog, Skeleton, StatusBadge, Term } from '../components/ui';

interface Task {
  id: string;
  key: string;
  title: string;
  description: string;
  category: string;
  entity: string | null;
  status: string;
  dueWorkday: number;
  dueDate: string;
  overdue: boolean;
  owner: { id: string; name: string; hue: number } | null;
  reviewer: { id: string; name: string; hue: number } | null;
  skillKey: string | null;
  skillName: string | null;
  ready: boolean;
  blockedBy: string[];
  dependsOn: string[];
  blockedReason: string | null;
  pendingProposals: number;
  lastRun: { id: string; status: string; summary: string | null; finishedAt: string | null; mode: string } | null;
  completedAt: string | null;
  completedByAgent: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  canComplete: boolean;
  canReview: boolean;
  signOffBlockedBy: string[];
  canRun: boolean;
}

interface CloseData {
  close: { id: string; name: string; periodEnd: string; status: string; targetWorkday: number; closedAt: string | null };
  businessDate: string;
  currentWorkday: number;
  workdays: Array<{ workday: number; label: string; date: string }>;
  progress: { total: number; done: number; review: number; inProgress: number; blocked: number; pct: number };
  blockers: Array<{ kind: string; message: string; href?: string }>;
  canRunAgents: boolean;
  liveModel: string | null;
  tasks: Task[];
}

export function CockpitScreen({ closeId }: { closeId: string | null }) {
  const route = useRoute();
  const can = useCan();
  const { data, error, reload } = useApi<CloseData>(closeId ? `/api/closes/${closeId}` : '/api/closes/current', { pollMs: 6000 });
  const { run, busy } = useAction();
  const [lockOpen, setLockOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [comment, setComment] = useState('');
  const taskId = route.query.get('task');
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={10} />;
  const { close } = data;
  const open = (id: string | null) => navigate(`/close/${close.id}${id ? `?task=${id}` : ''}`);
  const runAgents = async (mode?: 'offline' | 'live') => {
    const r = await run(() => api.post<{ runId: string; alreadyRunning: boolean }>(`/api/closes/${close.id}/run`, mode ? { mode } : {}), (x) => (x.alreadyRunning ? 'The close agents are already running.' : 'Close agents started.'));
    if (r?.runId) navigate(`/runs/${r.runId}`);
  };
  const reviewable = data.tasks.filter((t) => t.canReview).length;
  const lockBlockers = data.blockers.filter((b) => !b.message.startsWith('Lock the period'));
  const task = data.tasks.find((t) => t.id === taskId) ?? null;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="row-wrap" style={{ marginBottom: 6 }}>
            <StatusBadge status={close.status === 'closed' ? 'locked' : close.status} text={close.status === 'closed' ? 'Locked' : label(close.status)} />
            <span className="small muted">
              Period end {date(close.periodEnd, 'long')} · business date {date(data.businessDate)} · <Term id="bh:Workday">WD{data.currentWorkday}</Term> · target WD{close.targetWorkday}
            </span>
          </div>
          <h1>{close.name}</h1>
        </div>
        <div className="row-wrap">
          {reviewable > 0 && (
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.post<{ reviewed: number }>(`/api/closes/${close.id}/review-all`, {}), (r) => `Signed off ${r.reviewed} task(s).`)}>
              <CheckCheck size={16} aria-hidden="true" /> Sign off {reviewable} ready task{reviewable === 1 ? '' : 's'}
            </button>
          )}
          <a className="btn" href={`#/close/${close.id}/package`}>
            <FileText size={16} aria-hidden="true" /> Close package
          </a>
          {close.status === 'closed' && can('period.reopen') && (
            <button type="button" className="btn btn-danger" onClick={() => setReopenOpen(true)}>
              <Unlock size={16} aria-hidden="true" /> Reopen
            </button>
          )}
          {close.status !== 'closed' && can('period.lock') && (
            <button type="button" className="btn" onClick={() => setLockOpen(true)} disabled={busy}>
              <Lock size={16} aria-hidden="true" /> Lock period
            </button>
          )}
          {data.canRunAgents && (
            <button type="button" className="btn btn-primary" onClick={() => void runAgents()} disabled={busy}>
              <Play size={16} aria-hidden="true" /> Run close agents
            </button>
          )}
        </div>
      </div>

      <section className="card card-pad" aria-label="Progress">
        <div className="row-wrap" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <strong>
            {data.progress.done} of {data.progress.total} tasks signed off
          </strong>
          <span className="small muted">
            {data.progress.review} in review · {data.progress.inProgress} in progress · {data.progress.blocked} waiting on dependencies
          </span>
        </div>
        <Progress value={data.progress.pct} label="Close progress" />
      </section>

      <div className="board" role="list" aria-label="Close calendar by workday">
        {data.workdays.map((wd) => {
          const tasks = data.tasks.filter((t) => t.dueWorkday === wd.workday);
          return (
            <section key={wd.workday} className={`board-col${wd.workday === data.currentWorkday ? ' today' : ''}`} role="listitem" aria-label={`${wd.label}, ${date(wd.date)}`}>
              <header className="board-head">
                <strong>{wd.label}</strong>
                <span className="small muted">{date(wd.date)}</span>
                {wd.workday === data.currentWorkday && <Badge tone="info">Today</Badge>}
              </header>
              <div className="stack" style={{ gap: 8 }}>
                {tasks.map((t) => (
                  <button key={t.id} type="button" className={`task-card status-${t.status}`} onClick={() => open(t.id)}>
                    <span className="row" style={{ alignItems: 'flex-start' }}>
                      <span className="grow" style={{ textAlign: 'left', fontWeight: 600, fontSize: 13 }}>
                        {t.title.replace(/ \((BW-[A-Z]+)\)$/, '')}
                      </span>
                      {t.entity && <Badge>{t.entity}</Badge>}
                    </span>
                    <span className="row-wrap" style={{ marginTop: 8 }}>
                      <StatusBadge status={t.status} />
                      {t.skillKey && (
                        <Badge tone="violet" title={t.skillName ?? undefined}>
                          <Bot size={11} aria-hidden="true" /> Agent
                        </Badge>
                      )}
                      {t.pendingProposals > 0 && <Badge tone="attention">{t.pendingProposals} to approve</Badge>}
                      {t.overdue && <Badge tone="danger">Late</Badge>}
                    </span>
                    {t.owner && (
                      <span className="row tiny muted" style={{ marginTop: 8 }}>
                        <Avatar name={t.owner.name} hue={t.owner.hue} size={18} /> {t.owner.name}
                        {t.reviewer && <> → {t.reviewer.name}</>}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <section className="card" aria-labelledby="blockers-h">
        <div className="card-head">
          <h2 id="blockers-h">
            Before you can <Term id="bh:HardClose">lock the period</Term>
          </h2>
          <span className="small muted">{lockBlockers.length ? `${lockBlockers.length} open item(s)` : 'Nothing left'}</span>
        </div>
        {lockBlockers.length === 0 ? (
          <div className="empty small">Everything is signed off.</div>
        ) : (
          <ul className="list">
            {lockBlockers.slice(0, 14).map((b, i) => (
              <li key={i} className="row small">
                <AlertCircle size={15} className="muted" aria-hidden="true" />
                <span className="grow">{b.message}</span>
                {b.href && (
                  <a href={b.href} className="tiny">
                    Open
                  </a>
                )}
              </li>
            ))}
            {lockBlockers.length > 14 && <li className="small muted">and {lockBlockers.length - 14} more</li>}
          </ul>
        )}
      </section>

      {task && <TaskDrawer task={task} onClose={() => open(null)} />}
      {lockOpen && (
        <Modal
          title={`Lock ${close.name.replace(' close', '')}`}
          onClose={() => setLockOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setLockOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || lockBlockers.length > 0}
                onClick={async () => {
                  const r = await run(() => api.post(`/api/closes/${close.id}/lock`, { comment: comment || undefined }), 'Period locked. Postings to September are now blocked.');
                  if (r) setLockOpen(false);
                }}
              >
                <Lock size={15} aria-hidden="true" /> Lock period
              </button>
            </>
          }
        >
          {lockBlockers.length > 0 ? (
            <div className="callout attention">
              {lockBlockers.length} item(s) still block the lock; resolve them first. The first one: {lockBlockers[0]!.message}
            </div>
          ) : (
            <p className="text-2">Locking moves every entity's period to locked: the database refuses any further posting, and only the CFO can reopen it with a documented reason.</p>
          )}
          <div className="field">
            <label htmlFor="lock-comment">Comment for the audit log (optional)</label>
            <input id="lock-comment" className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
        </Modal>
      )}
      {reopenOpen && <ReasonDialog title="Reopen a locked period" prompt="Why does this period need to reopen?" confirmLabel="Reopen" danger minLength={10} onClose={() => setReopenOpen(false)} onSubmit={(reason) => run(() => api.post(`/api/closes/${close.id}/reopen`, { reason }), 'Period reopened (soft-closed).')} />}
    </div>
  );
}

function TaskDrawer({ task, onClose }: { task: Task; onClose: () => void }) {
  const { run, busy } = useAction();
  const { data: props } = useApi<{ items: Array<{ id: string; title: string; status: string; kind: string }> }>(`/api/proposals?view=all&task=${task.id}&limit=50`);
  const [sendBack, setSendBack] = useState(false);
  return (
    <Drawer
      title={task.title}
      subtitle={
        <span className="row-wrap">
          <StatusBadge status={task.status} /> Due WD{task.dueWorkday} ({date(task.dueDate)}) {task.entity && <Badge>{task.entity}</Badge>}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {task.canRun && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                const r = await run(() => api.post<{ runId: string }>(`/api/tasks/${task.id}/run`, {}), 'Agent started.');
                if (r?.runId) navigate(`/runs/${r.runId}`);
              }}
            >
              <Play size={15} aria-hidden="true" /> Run {task.skillName}
            </button>
          )}
          {task.canComplete && !task.skillKey && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => api.post(`/api/tasks/${task.id}/complete`, {}), 'Task completed.')}>
              <CheckCheck size={15} aria-hidden="true" /> Mark done
            </button>
          )}
          {task.canComplete && task.skillKey && task.pendingProposals === 0 && task.lastRun && (
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.post(`/api/tasks/${task.id}/complete`, {}), 'Task completed.')}>
              Mark done
            </button>
          )}
          {task.canReview && (
            <>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => api.post(`/api/tasks/${task.id}/review`, { decision: 'approve' }), 'Signed off.')}>
                <CheckCheck size={15} aria-hidden="true" /> Sign off
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setSendBack(true)}>
                <RotateCcw size={15} aria-hidden="true" /> Send back
              </button>
            </>
          )}
          <span className="grow" />
          {task.pendingProposals > 0 && (
            <a className="btn" href={`#/inbox?task=${task.id}`}>
              {task.pendingProposals} in inbox
            </a>
          )}
        </>
      }
    >
      <div className="stack">
        <p className="text-2">{task.description}</p>
        <div className="grid grid-2 small">
          <div>
            <div className="label">Owner</div>
            {task.owner ? task.owner.name : 'Unassigned'}
          </div>
          <div>
            <div className="label">Reviewer</div>
            {task.reviewer ? task.reviewer.name : 'No review step'}
          </div>
          <div>
            <div className="label">
              <Term id="bh:TaskDependency">Depends on</Term>
            </div>
            {task.dependsOn.length ? task.dependsOn.join(', ') : 'Nothing'}
          </div>
          <div>
            <div className="label">Agent skill</div>
            {task.skillKey ? <a href={`#/skills/${task.skillKey}`}>{task.skillName}</a> : 'Done by people'}
          </div>
        </div>
        {task.blockedBy.length > 0 && <div className="callout attention small">Waiting on: {task.blockedBy.join(', ')}</div>}
        {task.blockedReason && <div className="callout small">{task.blockedReason}</div>}
        {task.signOffBlockedBy.length > 0 && <div className="callout attention small">Before sign-off: {task.signOffBlockedBy.join(' ')}</div>}
        {task.lastRun && (
          <div className="card card-pad small">
            <div className="row">
              <Bot size={15} aria-hidden="true" />
              <strong className="grow">Last agent run</strong>
              <StatusBadge status={task.lastRun.status} />
            </div>
            <p className="text-2" style={{ marginTop: 6 }}>
              {task.lastRun.summary ?? 'Running...'}
            </p>
            <a href={`#/runs/${task.lastRun.id}`} className="small">
              Open the trace
            </a>
          </div>
        )}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>
            Proposals for this task
          </div>
          {!props ? (
            <Skeleton rows={2} />
          ) : props.items.length === 0 ? (
            <Empty title="No proposals yet" />
          ) : (
            <ul className="list card">
              {props.items.map((p) => (
                <li key={p.id} className="row small">
                  <a href={`#/inbox/${p.id}`} className="grow" style={{ color: 'var(--text)' }}>
                    {p.title}
                  </a>
                  <StatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
        {task.completedAt && (
          <p className="tiny muted">
            Completed {date(task.completedAt, 'time')} {task.completedByAgent ? 'by an agent run' : ''}
            {task.reviewedBy ? ` · signed off by ${task.reviewedBy}` : ''}
          </p>
        )}
      </div>
      {sendBack && <ReasonDialog title="Send back for rework" prompt="What needs to change?" confirmLabel="Send back" onClose={() => setSendBack(false)} onSubmit={(note) => run(() => api.post(`/api/tasks/${task.id}/review`, { decision: 'send_back', note }), 'Sent back.')} />}
    </Drawer>
  );
}

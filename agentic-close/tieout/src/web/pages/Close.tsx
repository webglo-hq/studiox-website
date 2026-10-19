/** Close cockpit: workday timeline, checklist with dependencies, sign-off, package and lock. */
import { Check, FileText, Lock, Play } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, type CloseData, type CloseTask } from '../api';
import { Badge, Dialog, ErrorBox, Loading, Meter, ReasonDialog, Term } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { date, periodName } from '../lib/format';

const STATUS_TONE: Record<string, 'good' | 'info' | 'warn' | 'bad' | 'neutral'> = { done: 'good', skipped: 'neutral', ready_for_review: 'info', in_progress: 'warn', blocked: 'bad', not_started: 'neutral' };

export function Close() {
  const me = useMe();
  const { period, toast, bump } = useApp();
  const { data, error, loading, reload } = useData(() => api<CloseData>(`/close/${period}`), [period]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmLock, setConfirmLock] = useState(false);
  const [reopening, setReopening] = useState<{ entityId: string; code: string } | null>(null);

  async function act(path: string, label: string, body: unknown = {}) {
    setBusy(label);
    try {
      await api(path, { body });
      toast(label);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'That did not work.', 'bad');
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading the checklist" />;
  const byWd = new Map<string, CloseTask[]>();
  for (const t of data.tasks) byWd.set(t.dueLabel, [...(byWd.get(t.dueLabel) ?? []), t]);
  const done = data.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  const latest = data.packages[0];
  const locked = data.periods.length > 0 && data.periods.every((p) => p.status === 'locked');
  return (
    <div className={loading ? 'skeleton' : undefined}>
      <div className="page-head">
        <div>
          <h1>Close cockpit</h1>
          <p className="lede">
            {periodName(period)}: {done} of {data.tasks.length} tasks done. Today is <strong>{data.workday}</strong>. Tasks unlock in dependency order — a task can be prepared early, but it can’t be signed off before
            the tasks it depends on{' '}
            <span style={{ whiteSpace: 'nowrap' }}>
              (<Term id="tie:TaskDependency">AX-CL-01</Term>).
            </span>
          </p>
        </div>
        <div className="actions">
          {can(me, 'agent.run') ? (
            <button className="btn" disabled={!!busy} onClick={() => void act(`/close/${period}/run-agents`, 'Close agents finished. New items are in the inbox.')}>
              <Play className="icon" aria-hidden="true" /> {busy?.startsWith('Close agents') ? 'Running…' : 'Run close agents'}
            </button>
          ) : null}
          {can(me, 'close.package') ? (
            <button className="btn" disabled={!!busy} onClick={() => void act('/runs', 'Close package drafted. It is in the inbox for approval.', { skillKey: 'close-package', entityId: null, periodKey: period })}>
              <FileText className="icon" aria-hidden="true" /> Draft close package
            </button>
          ) : null}
          {can(me, 'close.lock') ? (
            <button className="btn primary" disabled={!!busy || !data.readiness.ready || locked} onClick={() => setConfirmLock(true)} title={locked ? 'Locked for every entity' : data.readiness.ready ? 'Lock the period' : data.readiness.messages.join('; ')}>
              <Lock className="icon" aria-hidden="true" /> {locked ? `${periodName(period)} locked` : `Lock ${periodName(period)}`}
            </button>
          ) : null}
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2>Workday calendar</h2>
          <span style={{ width: 220 }}>
            <Meter value={done} max={data.tasks.length} label="Checklist progress" />
          </span>
        </div>
        <div className="timeline" role="list" aria-label="Tasks by close workday">
          {[...byWd.entries()].map(([wd, tasks]) => (
            <div key={wd} role="listitem" className={`wd-col${wd === data.workday ? ' today' : ''}`}>
              <div className="wd-label">
                {wd} {wd === data.workday ? <span className="badge good" style={{ marginLeft: 4 }}>today</span> : null}
              </div>
              <div className="wd-date">{date(tasks[0]!.due_date)}</div>
              {tasks.map((t) => (
                <div key={t.id} className={`wd-dot ${t.status === 'done' ? 'done' : t.status === 'not_started' ? '' : 'open'}`}>
                  {t.title.split(' ').slice(0, 3).join(' ')}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="grid main-side">
        <section className="card" aria-labelledby="h-check">
          <div className="card-head">
            <h2 id="h-check">Checklist</h2>
          </div>
          {data.tasks.map((t) => {
            const runs = t.skill_key ? (data.bySkill[t.skill_key]?.runs ?? []) : [];
            const open = t.skill_key ? (data.bySkill[t.skill_key]?.open ?? 0) : 0;
            const canComplete = can(me, 'close.manage') && ['not_started', 'in_progress', 'blocked'].includes(t.status) && t.key !== 'lock';
            const canSign = can(me, 'close.signoff') && t.status === 'ready_for_review' && t.completed_by !== me.user.id;
            return (
              <div className="task" key={t.id}>
                <span className={`tick ${t.status === 'done' ? 'done' : t.status === 'ready_for_review' ? 'review' : t.status === 'in_progress' ? 'progress' : t.status === 'blocked' ? 'blocked' : ''}`} aria-hidden="true">
                  {t.status === 'done' ? <Check style={{ width: 14, height: 14 }} /> : null}
                </span>
                <div>
                  <div className="title">{t.title}</div>
                  <div className="meta">
                    {t.dueLabel} · {date(t.due_date)} · {t.ownerName ?? t.owner_role}
                    {t.reviewerName ? ` → ${t.reviewerName}` : ''}
                    {t.skill_key ? (
                      <>
                        {' '}
                        · skill <a href={`#/skills/${t.skill_key}`}>{t.skill_key}</a>
                      </>
                    ) : null}
                    {t.dependsOn.length ? ` · after ${t.dependsOn.join(', ')}` : ''}
                  </div>
                  {t.notes ? <div className="meta" style={{ color: 'var(--ink-2)' }}>{t.notes}</div> : null}
                  {runs.length || open ? (
                    <div className="meta">
                      {runs.map((r) => (
                        <a key={r.id} href={`#/runs/${r.id}`} style={{ marginRight: 8 }}>
                          {r.ref}
                        </a>
                      ))}
                      {open ? <a href={`#/inbox?skill=${t.skill_key}`}>{open} waiting in the inbox</a> : null}
                    </div>
                  ) : null}
                  {canComplete || canSign ? (
                    <div className="row" style={{ marginTop: 8 }}>
                      {canComplete ? (
                        <button className="btn small" disabled={!!busy} onClick={() => void act(`/close/tasks/${t.id}/complete`, `${t.title}: marked ${t.reviewer_role ? 'ready for review' : 'done'}.`)}>
                          {t.reviewer_role ? 'Mark ready for review' : 'Mark done'}
                        </button>
                      ) : null}
                      {canSign ? (
                        <button className="btn small primary" disabled={!!busy} onClick={() => void act(`/close/tasks/${t.id}/signoff`, `${t.title}: signed off.`)}>
                          Sign off
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <Badge tone={t.overdue ? 'bad' : STATUS_TONE[t.status]}>{t.overdue ? 'overdue' : t.status.replace(/_/g, ' ')}</Badge>
              </div>
            );
          })}
        </section>
        <div className="stack">
          <section className="card card-pad" aria-labelledby="h-lock">
            <h2 id="h-lock" style={{ marginBottom: 8 }}>
              {locked ? 'Period locked' : 'Ready to lock?'}
            </h2>
            {locked ? (
              <p>
                <Badge tone="good">Locked</Badge> {periodName(period)} is closed for every entity. Nothing more posts to it; reopening needs a documented reason.
              </p>
            ) : data.readiness.ready ? (
              <p>
                <Badge tone="good">Ready</Badge> Every condition holds.
              </p>
            ) : (
              <ul className="checks">
                {data.readiness.messages.map((m) => (
                  <li key={m}>
                    <Badge tone="warn" icon={false}>
                      Open
                    </Badge>
                    {m}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
              Rule <a href="#/ontology?axiom=AX-CL-02">AX-CL-02</a>: no pending proposals, every reconciliation reviewed, significant variances explained, all tasks done and a final close package.
            </p>
            <ul className="checks" style={{ marginTop: 8 }}>
              {data.periods.map((p) => {
                const code = me.entities.find((e) => e.id === p.entityId)?.code ?? p.entityId;
                return (
                  <li key={p.entityId}>
                    <Badge tone={p.status === 'locked' ? 'good' : p.status === 'open' ? 'neutral' : 'info'} icon={false}>
                      {p.status.replace('_', ' ')}
                    </Badge>
                    {code}
                    {p.status === 'locked' && can(me, 'close.lock') ? (
                      <button className="linklike" style={{ marginLeft: 'auto' }} onClick={() => setReopening({ entityId: p.entityId, code })}>
                        Reopen
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="card card-pad" aria-labelledby="h-pkg">
            <h2 id="h-pkg" style={{ marginBottom: 8 }}>
              <Term id="tie:ClosePackage">Close package</Term>
            </h2>
            {latest ? (
              <div className="stack" style={{ gap: 8 }}>
                <p>
                  Version {latest.version} · <Badge tone={latest.status === 'final' ? 'good' : 'info'}>{latest.status}</Badge> · {date(latest.generatedAt)}
                </p>
                <div className="row">
                  <a className="btn small" href={`#/package/${latest.id}`}>
                    Open package
                  </a>
                  {latest.status === 'draft' && can(me, 'close.package') ? (
                    <button className="btn small primary" disabled={!!busy} onClick={() => void act(`/packages/${latest.id}/finalize`, 'Close package finalized and signed.')}>
                      Finalize & sign
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="muted">No package yet. Draft it when the checklist is nearly done; approving the draft in the inbox creates version 1.</p>
            )}
          </section>
        </div>
      </div>
      <Dialog
        open={confirmLock}
        onClose={() => setConfirmLock(false)}
        title={`Lock ${periodName(period)}?`}
        actions={
          <>
            <button className="btn" onClick={() => setConfirmLock(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => { setConfirmLock(false); void act(`/close/${period}/lock`, `${periodName(period)} is locked.`); }}>
              Lock period
            </button>
          </>
        }
      >
        <p>Locking stops all posting to {periodName(period)} for every entity. Reopening later needs a Controller or CFO and a documented reason.</p>
      </Dialog>
      <ReasonDialog
        open={!!reopening}
        title={`Reopen ${periodName(period)} for ${reopening?.code ?? ''}?`}
        label="Why does the period need to reopen? (for the audit log and the auditors)"
        min={10}
        confirm="Reopen to soft-close"
        onCancel={() => setReopening(null)}
        onConfirm={(reason) => {
          const r = reopening;
          setReopening(null);
          if (r) void act(`/close/${period}/reopen`, `${periodName(period)} reopened for ${r.code} (soft-closed: adjusting entries only).`, { entityId: r.entityId, reason });
        }}
      />
    </div>
  );
}

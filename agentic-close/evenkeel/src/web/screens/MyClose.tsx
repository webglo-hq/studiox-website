import { ArrowRight, Bot, CheckCircle2, CircleDashed, GitCompareArrows, Inbox, Lock, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { useAgents } from '../lib/agents';
import { useAction, useApi } from '../lib/api';
import { date, money, plural } from '../lib/format';
import { href, navigate } from '../lib/router';
import { useSession } from '../lib/session';
import { safeStorage } from '../storage';
import { Badge, Button, Card, Confidence, Empty, LinkButton, Money, PageHead, Query, Status } from '../ui/kit';
import { Term } from '../ui/term';

const GUIDE_KEY = 'evenkeel.guide.hidden';

function OrchestrateButton({ label = 'Run the close agents', size }: { label?: string; size?: 'l' | 's' }) {
  const agents = useAgents();
  const run = useAction('close.orchestrate', { success: (o) => (o.background ? 'The agents are working. This page updates as each task finishes.' : (o.summary ?? 'The agents finished.')), onSuccess: (o) => o.background && agents.expect() });
  return (
    <Button variant="primary" size={size} busy={run.isPending || agents.running} icon={<Bot size={18} aria-hidden />} onClick={() => run.mutate({})} data-testid="run-agents">
      {label}
    </Button>
  );
}

export function MyClose() {
  const { info, can } = useSession();
  const q = useApi('home.myClose', {});
  const [guideHidden, setGuideHidden] = useState(() => safeStorage.get('local', GUIDE_KEY) === '1');
  const first = info.user.name.split(' ')[0];

  return (
    <div className="page">
      <Query q={q} rows={8}>
        {(d) => {
          const steps = [
            { title: 'Run the agents', body: 'They prepare coding, reconciliations, accruals, schedules and reviews in dependency order.', done: d.agentsRan, href: '#/cockpit' },
            { title: 'Review proposals', body: 'Approve or reject what the agents could not post on their own. Each shows why and how sure it is.', done: d.agentsRan && d.approvals.waiting === 0, href: '#/inbox' },
            { title: 'Certify and explain', body: 'Sign off reconciliations and approve variance explanations for material movements.', done: d.recs.total > 0 && d.recs.reviewed === d.recs.total && d.flux.toApprove === 0, href: '#/recs' },
            { title: 'Package and lock', body: 'The CFO signs the close package; the controller locks the month.', done: d.locked, href: '#/package' },
          ];
          const currentStep = steps.findIndex((s) => !s.done);
          return (
            <>
              <PageHead eyebrow={`${d.periodLabel} close · ${d.todayWorkday} · ${date(d.today, 'long')}`} title={`Good morning, ${first}`} sub={<>Target: books closed by {d.target.workday} ({date(d.target.date, 'short')}). {d.headline ? <>Consolidated revenue this month {money(d.headline.revenue.current, d.headline.currency, { compact: true })}.</> : null}</>} />

              <section className={`hero ${d.next.tone === 'done' ? 'done' : ''}`} aria-labelledby="next-title">
                <div>
                  <div className="kicker">{d.next.tone === 'done' ? 'All set' : 'What to do next'}</div>
                  <h2 id="next-title" data-testid="next-action">
                    {d.next.title}
                  </h2>
                  <p>{d.next.detail}</p>
                  <div className="row-wrap" style={{ marginTop: 18 }}>
                    {d.next.action === 'orchestrate' && can('agent.orchestrate') ? (
                      <OrchestrateButton label={d.agentsRan ? 'Continue the close' : 'Run the close agents'} size="l" />
                    ) : d.next.action !== 'none' ? (
                      <LinkButton href={d.next.href} variant="primary" size="l" icon={<ArrowRight size={18} aria-hidden />}>
                        {d.next.action === 'approve' ? 'Open the inbox' : d.next.action === 'certify' || d.next.action === 'review' ? 'Open reconciliations' : d.next.action === 'package' ? 'Open the package' : d.next.action === 'lock' ? 'Go to lock' : 'Open'}
                      </LinkButton>
                    ) : (
                      <LinkButton href={d.next.href} size="l">
                        Open the cockpit
                      </LinkButton>
                    )}
                    <LinkButton href="#/cockpit" variant="quiet">
                      See the whole calendar
                    </LinkButton>
                  </div>
                </div>
                <div className="ring" style={{ ['--value' as string]: d.progress.pct }} role="img" aria-label={`${d.progress.pct}% of close tasks complete`}>
                  <div>
                    <div>
                      <div className="big">{d.progress.pct}%</div>
                      <div className="lbl">
                        {d.progress.complete} of {d.progress.total} tasks
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {!guideHidden && !d.locked && (
                <Card
                  title="Getting started"
                  hint="Four steps from open month to locked books. Follow the highlighted one."
                  actions={
                    <Button
                      variant="quiet"
                      size="s"
                      icon={<X size={14} aria-hidden />}
                      onClick={() => {
                        safeStorage.set('local', GUIDE_KEY, '1');
                        setGuideHidden(true);
                      }}
                    >
                      Hide guide
                    </Button>
                  }
                >
                  <ol className="steps" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {steps.map((s, i) => (
                      <li key={s.title} className={`step ${s.done ? 'done' : ''} ${i === currentStep ? 'current' : ''}`} aria-current={i === currentStep ? 'step' : undefined}>
                        <div className="row">
                          <span className="n" aria-hidden>
                            {s.done ? '✓' : i + 1}
                          </span>
                          <a href={s.href} className="strong" style={{ color: 'var(--ink)' }}>
                            {s.title}
                          </a>
                          {s.done && <span className="sr-only">(done)</span>}
                        </div>
                        <p className="small ink2">{s.body}</p>
                      </li>
                    ))}
                  </ol>
                </Card>
              )}

              <div className="grid grid-4">
                <a className="card stat" href="#/inbox" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <span className="label">
                    <Inbox size={15} aria-hidden /> Waiting for you
                  </span>
                  <span className="value">{d.approvals.count}</span>
                  <span className="small muted">{d.approvals.material ? `${d.approvals.material} material · ` : ''}{plural(d.approvals.waiting, 'proposal')} open in total</span>
                </a>
                <a className="card stat" href="#/recs" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <span className="label">
                    <GitCompareArrows size={15} aria-hidden /> <Term id="ek:Reconciliation">Reconciliations</Term>
                  </span>
                  <span className="value">
                    {d.recs.reviewed}/{d.recs.total}
                  </span>
                  <span className="small muted">signed off{d.recs.toCertify ? ` · ${d.recs.toCertify} ready to certify` : ''}{d.recs.blocked ? ` · ${d.recs.blocked} still open` : ''}</span>
                </a>
                <a className="card stat" href="#/issues" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <span className="label">
                    <ShieldAlert size={15} aria-hidden /> <Term id="ek:Exception">Exceptions</Term>
                  </span>
                  <span className="value">{d.issues.open}</span>
                  <span className="small muted">{d.issues.high ? `${d.issues.high} high or critical` : 'none high'}</span>
                </a>
                <a className="card stat" href="#/cockpit" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <span className="label">
                    <Lock size={15} aria-hidden /> Ready to lock
                  </span>
                  <span className="value">{d.lock.ok ? 'Yes' : 'Not yet'}</span>
                  <span className="small muted">{d.lock.ok ? 'every check passes' : `${plural(d.lock.failing.length, 'check')} to clear`}</span>
                </a>
              </div>

              <div className="grid grid-main">
                <div className="stack-l">
                  <Card title="Waiting for your approval" hint="Highest risk first" actions={<LinkButton href="#/inbox" size="s" variant="quiet">Open inbox</LinkButton>} flush>
                    {d.approvals.top.length ? (
                      <div className="list">
                        {d.approvals.top.map((p) => (
                          <a key={p.id} className="list-item" href={href(`/inbox/${p.id}`)}>
                            <Bot size={18} aria-hidden className="muted" />
                            <span className="grow stack" style={{ gap: 2 }}>
                              <span className="strong small">{p.title}</span>
                              <span className="row-wrap">
                                <Badge>{p.kindLabel}</Badge>
                                {p.materiality === 'material' && <Status value="material" label="Material" />}
                                <Confidence value={p.confidence} />
                              </span>
                            </span>
                            {p.amount !== null && <Money cents={p.amount} currency={p.currency ?? 'USD'} />}
                          </a>
                        ))}
                      </div>
                    ) : (
                      <Empty icon={<CheckCircle2 size={22} />} title="Nothing waiting for you">
                        {d.approvals.waiting ? `${plural(d.approvals.waiting, 'proposal')} need someone else (maker-checker).` : d.agentsRan ? 'Every agent proposal has been decided.' : 'Run the agents to start the close.'}
                      </Empty>
                    )}
                  </Card>

                  <Card title="Your tasks" hint="Tasks you own this close" flush>
                    {d.myTasks.length ? (
                      <div className="list">
                        {d.myTasks.map((t) => (
                          <a key={t.id} className="list-item" href="#/cockpit">
                            <CircleDashed size={18} aria-hidden className="muted" />
                            <span className="grow stack" style={{ gap: 2 }}>
                              <span className="strong small">
                                <span className="mono muted">{t.code}</span> {t.title}
                              </span>
                              <span className="xs muted">
                                Due {t.dueLabel} ({t.workdayLabel}){t.blockedBy.length ? ` · waiting on ${t.blockedBy.map((b) => b.code).join(', ')}` : ''}
                                {t.pending ? ` · ${plural(t.pending, 'proposal')} pending` : ''}
                              </span>
                            </span>
                            <Status value={t.overdue ? 'blocked' : t.status} label={t.overdue ? 'Overdue' : undefined} />
                          </a>
                        ))}
                      </div>
                    ) : (
                      <Empty icon={<CheckCircle2 size={22} />} title="No open tasks">
                        {d.toReview.length ? `${plural(d.toReview.length, 'task')} wait for your review in the cockpit.` : 'Nothing assigned to you is open.'}
                      </Empty>
                    )}
                  </Card>
                </div>

                <div className="stack-l">
                  {d.headline && (
                    <Card title="This month at a glance" hint="Consolidated, USD, vs prior month">
                      <div className="stack">
                        {(
                          [
                            ['Revenue', d.headline.revenue],
                            ['Net income', d.headline.netIncome],
                            ['Cash', d.headline.cash],
                          ] as const
                        ).map(([label, v]) => (
                          <div key={label} className="spread">
                            <span className="ink2">{label}</span>
                            <span className="stack" style={{ gap: 0, alignItems: 'flex-end' }}>
                              <span className="strong">
                                <Money cents={v.current} currency={d.headline!.currency} compact />
                              </span>
                              <span className="xs muted">
                                prior <Money cents={v.prior} currency={d.headline!.currency} compact />
                              </span>
                            </span>
                          </div>
                        ))}
                        {d.headline.gbpUsdClosing && <div className="xs muted">GBP/USD closing rate {d.headline.gbpUsdClosing}</div>}
                      </div>
                    </Card>
                  )}

                  <Card title="Open exceptions" actions={<LinkButton href="#/issues" size="s" variant="quiet">All</LinkButton>} flush>
                    {d.issues.top.length ? (
                      <div className="list">
                        {d.issues.top.map((i) => (
                          <a key={i.id} className="list-item" href="#/issues">
                            <ShieldAlert size={18} aria-hidden className="muted" />
                            <span className="grow small">{i.title}</span>
                            <Status value={i.severity} />
                          </a>
                        ))}
                      </div>
                    ) : (
                      <Empty icon={<CheckCircle2 size={22} />} title="No open exceptions" />
                    )}
                  </Card>

                  {!d.lock.ok && d.lock.failing.length > 0 && (
                    <Card title="Before the month can lock" hint={<Term id="AX-CLS-02">Lock readiness</Term>}>
                      <ul className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
                        {d.lock.failing.slice(0, 5).map((c) => (
                          <li key={c.label}>
                            <strong>{c.label}.</strong> <span className="ink2">{c.detail}</span>
                          </li>
                        ))}
                      </ul>
                      <div style={{ marginTop: 12 }}>
                        <Button size="s" onClick={() => navigate('#/cockpit')}>
                          Open the cockpit
                        </Button>
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

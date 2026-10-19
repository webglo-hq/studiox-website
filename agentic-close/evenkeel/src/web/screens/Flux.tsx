import { Check, PenLine, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import type { MethodOutput } from '../../app/methods';
import { useAction, useApi } from '../lib/api';
import { money, pct, period, when } from '../lib/format';
import { href, setQuery, type Route } from '../lib/router';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Dialog, Drawer, Empty, ErrorState, Field, Loading, Money, Notice, PageHead, Query, Seg, Status } from '../ui/kit';
import { Term } from '../ui/term';

type View = MethodOutput<'flux.view'>;
type Line = View['lines'][number];

function ExplainDialog({ view, line, onClose }: { view: View; line: Line; onClose: () => void }) {
  const drivers = useApi('flux.drivers', { entityId: view.entityId, accountId: line.accountId, comparison: view.comparison });
  const [narrative, setNarrative] = useState(line.explanation?.narrative ?? '');
  const explain = useAction('flux.explain', { success: 'Explanation submitted for approval.', onSuccess: onClose });
  const d = drivers.data;
  return (
    <Dialog
      title={`Explain ${line.code} ${line.name}`}
      description="Say what drove the movement in plain words. Evenkeel suggests drivers from the transactions behind the variance."
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={narrative.trim().length < 10 || !d} busy={explain.isPending} onClick={() => d && explain.mutate({ entityId: view.entityId, accountId: line.accountId, periodKey: view.periodKey, comparison: view.comparison, variance: line.variance, narrative, drivers: d.drivers, coverage: d.coverage })}>
            Submit explanation
          </Button>
        </>
      }
    >
      {drivers.isLoading && <Loading rows={3} />}
      {d && (
        <div className="sunken small stack" style={{ gap: 6 }}>
          <strong>
            Suggested drivers · cover {Math.round(d.coverage * 100)}% of {money(d.variance, view.currency, { signed: true })}
          </strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {d.drivers.map((x, i) => (
              <li key={i}>
                {x.label} <span className="muted">({x.kind.replace(/_/g, ' ')})</span> {money(x.amount, view.currency, { signed: true })}
              </li>
            ))}
          </ul>
          <Button size="s" variant="quiet" icon={<Sparkles size={14} aria-hidden />} onClick={() => setNarrative(d.narrative)}>
            Use the suggested wording
          </Button>
        </div>
      )}
      <Field label="Explanation" htmlFor="flux-narrative" help="At least 10 characters. Reviewers see this in the close package.">
        <textarea id="flux-narrative" className="textarea" value={narrative} onChange={(e) => setNarrative(e.target.value)} maxLength={2000} rows={5} />
      </Field>
    </Dialog>
  );
}

function LineDrawer({ view, line, onClose }: { view: View; line: Line; onClose: () => void }) {
  const { info, can } = useSession();
  const drivers = useApi('flux.drivers', { entityId: view.entityId, accountId: line.accountId, comparison: view.comparison });
  const approve = useAction('flux.approve', { success: 'Explanation approved.' });
  const [rejecting, setRejecting] = useState(false);
  const [writing, setWriting] = useState(false);
  const e = line.explanation;
  const mine = e?.author?.id === info.user.id;
  return (
    <Drawer
      label="Variance"
      title={`${line.code} ${line.name}`}
      sub={
        <span className="row-wrap">
          {line.material ? <Status value="material" label="Material" /> : <Badge>Below threshold</Badge>}
          <Status value={line.status} />
          {line.stale && <Badge tone="warn">Numbers changed since explained</Badge>}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {e && e.status === 'submitted' && can('flux.approve') && (
            <>
              <Button variant="good" icon={<Check size={16} aria-hidden />} disabled={mine} title={mine ? 'You wrote this, so someone else approves it (SOD-01).' : undefined} busy={approve.isPending} onClick={() => approve.mutate({ explanationId: e.id })} data-testid="approve-flux">
                Approve explanation
              </Button>
              <Button variant="danger" icon={<X size={16} aria-hidden />} onClick={() => setRejecting(true)}>
                Send back…
              </Button>
            </>
          )}
          {can('flux.explain') && line.status !== 'approved' && (
            <Button icon={<PenLine size={16} aria-hidden />} onClick={() => setWriting(true)}>
              {e ? 'Rewrite' : 'Write explanation'}
            </Button>
          )}
        </>
      }
    >
      <div className="grid grid-3">
        <div className="stack" style={{ gap: 2 }}>
          <span className="small muted">{period(view.periodKey)}</span>
          <strong className="num" style={{ textAlign: 'left' }}>
            {money(line.current, view.currency)}
          </strong>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="small muted">{view.comparisonLabel}</span>
          <strong className="num" style={{ textAlign: 'left' }}>
            {money(line.comparison, view.currency)}
          </strong>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <span className="small muted">Variance</span>
          <strong className="num" style={{ textAlign: 'left' }}>
            {money(line.variance, view.currency, { signed: true })} <span className="muted small">{pct(line.variancePct)}</span>
          </strong>
        </div>
      </div>

      {e ? (
        <section className="stack">
          <h3>Explanation</h3>
          <p>{e.narrative}</p>
          <div className="small ink2">
            By {e.authorType === 'agent' ? 'the flux agent' : 'a person'} {e.author ? <>on behalf of {e.author.name}</> : null} · {when(e.createdAt)} · drivers cover {Math.round(e.coverage * 100)}%
          </div>
          {e.approvedBy && <Notice tone="good">Approved by {e.approvedBy.name}.</Notice>}
          {e.rejectionReason && <Notice tone="warn">Sent back: {e.rejectionReason}</Notice>}
        </section>
      ) : (
        <Notice tone={line.material ? 'warn' : 'info'}>{line.material ? 'This movement is above the threshold and needs an explanation before the month can lock.' : 'Below the threshold; an explanation is optional.'}</Notice>
      )}

      <section className="stack">
        <h3>
          <Term id="ek:VarianceDriver">Drivers</Term> behind the movement
        </h3>
        {drivers.isLoading && <Loading rows={4} />}
        {drivers.isError && <ErrorState error={drivers.error} />}
        {drivers.data && (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Driver</th>
                    <th scope="col">Kind</th>
                    <th scope="col" className="num">
                      Effect
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {drivers.data.drivers.map((d, i) => (
                    <tr key={i}>
                      <td>
                        {d.label}
                        {d.evidence.length > 0 && (
                          <div className="xs">
                            {d.evidence.slice(0, 3).map((ev, j) => (
                              <a key={j} href={ev.type === 'journal_entry' ? href(`/journals/${ev.id}`) : href(`/records/${ev.type}/${ev.id}`)} style={{ marginRight: 8 }}>
                                {ev.label ?? ev.type}
                              </a>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="small">{d.kind.replace(/_/g, ' ')}</td>
                      <td className="num">{money(d.amount, view.currency, { signed: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">Listed drivers explain {Math.round(drivers.data.coverage * 100)}% of the variance.</p>
          </>
        )}
      </section>
      {writing && <ExplainDialog view={view} line={line} onClose={() => setWriting(false)} />}
      {rejecting && e && <RejectFlux id={e.id} onClose={() => setRejecting(false)} />}
    </Drawer>
  );
}

function RejectFlux({ id, onClose }: { id: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const reject = useAction('flux.reject', { success: 'Sent back to the author.', onSuccess: onClose });
  return (
    <Dialog
      title="Send the explanation back"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={reason.trim().length < 3} busy={reject.isPending} onClick={() => reject.mutate({ explanationId: id, reason })}>
            Send back
          </Button>
        </>
      }
    >
      <Field label="What is missing?" htmlFor="flux-reject">
        <textarea id="flux-reject" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} data-autofocus />
      </Field>
    </Dialog>
  );
}

export function FluxReview({ route }: { route: Route }) {
  const entity = (route.query.get('entity') as 'US' | 'UK' | null) ?? 'US';
  const comparison = (route.query.get('cmp') as 'prior_month' | 'budget' | null) ?? 'prior_month';
  const showAll = route.query.get('all') === '1';
  const q = useApi('flux.view', { entityCode: entity, comparison }, { keepPrevious: true });
  const [openLine, setOpenLine] = useState<string | null>(null);

  return (
    <div className="page">
      <PageHead
        eyebrow="Flux review"
        title="What moved, and why"
        sub={
          <>
            <Term id="ek:FluxAnalysis">Flux analysis</Term> compares this month with the prior month and the budget. Movements above the <Term id="ek:VarianceThreshold">threshold</Term> need an explanation that someone other than its author approves.
          </>
        }
        actions={
          <div className="row-wrap">
            <Seg label="Entity" value={entity} onChange={(v) => setQuery(route, 'entity', v)} items={[{ value: 'US', label: 'Kitewell US' }, { value: 'UK', label: 'Kitewell UK' }]} />
            <Seg label="Compare with" value={comparison} onChange={(v) => setQuery(route, 'cmp', v)} items={[{ value: 'prior_month', label: 'Prior month' }, { value: 'budget', label: 'Budget' }]} />
          </div>
        }
      />
      <Query q={q} rows={10}>
        {(v) => {
          const lines = v.lines.filter((l) => showAll || l.material || Math.abs(l.variance) >= v.threshold.abs / 2);
          const material = v.lines.filter((l) => l.material);
          const open = material.filter((l) => l.status === 'unexplained' || l.stale);
          const line = v.lines.find((l) => l.accountId === openLine) ?? null;
          return (
            <>
              <div className="grid grid-4">
                {(
                  [
                    ['Revenue', v.totals.revenue],
                    ['Expenses', v.totals.expenses],
                    ['Net income', v.totals.netIncome],
                  ] as const
                ).map(([label, t]) => (
                  <div key={label} className="card stat">
                    <span className="label">{label}</span>
                    <span className="value">
                      <Money cents={t.current} currency={v.currency} compact />
                    </span>
                    <span className={`delta small ${t.current - t.comparison >= 0 ? 'up' : 'down'}`}>
                      {money(t.current - t.comparison, v.currency, { signed: true, compact: true })} vs {v.comparisonLabel.toLowerCase()}
                    </span>
                  </div>
                ))}
                <div className="card stat">
                  <span className="label">Material lines</span>
                  <span className="value">{material.length}</span>
                  <span className="small muted">{open.length ? `${open.length} still need an explanation` : 'all explained'}</span>
                </div>
              </div>
              <Notice tone="info">
                Threshold: {money(v.threshold.abs, v.currency, { whole: true })} {v.threshold.mode} {Math.round(v.threshold.pct * 100)}% · status {v.status.replace(/_/g, ' ')}
              </Notice>
              <Card
                title={`${v.entityCode} · ${period(v.periodKey)} vs ${v.comparisonLabel}`}
                hint={showAll ? 'All income-statement lines' : 'Material lines and larger movements'}
                actions={
                  <Button size="s" variant="quiet" onClick={() => setQuery(route, 'all', showAll ? null : '1')}>
                    {showAll ? 'Show fewer lines' : 'Show every line'}
                  </Button>
                }
                flush
              >
                {lines.length ? (
                  <div className="table-wrap">
                    <table className="table" data-testid="flux-table">
                      <thead>
                        <tr>
                          <th className="first" scope="col">
                            Account
                          </th>
                          <th scope="col" className="num">
                            {period(v.periodKey, 'short')}
                          </th>
                          <th scope="col" className="num">
                            {v.comparisonLabel}
                          </th>
                          <th scope="col" className="num">
                            Variance
                          </th>
                          <th scope="col" className="num">
                            %
                          </th>
                          <th scope="col" className="last">
                            Explanation
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((l) => (
                          <tr key={l.accountId} className="clickable" onClick={() => setOpenLine(l.accountId)} data-testid={`flux-${l.code}`}>
                            <td className="first" style={{ minWidth: 200 }}>
                              <button type="button" className="strong" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => setOpenLine(l.accountId)}>
                                {l.code} {l.name}
                              </button>
                              <div className="row-wrap" style={{ marginTop: 2 }}>
                                {l.material && <Status value="material" label="Material" />}
                              </div>
                            </td>
                            <td className="num">{money(l.current, v.currency)}</td>
                            <td className="num">{money(l.comparison, v.currency)}</td>
                            <td className={`num strong ${l.material ? '' : 'ink2'}`}>{money(l.variance, v.currency, { signed: true })}</td>
                            <td className="num small">{pct(l.variancePct)}</td>
                            <td className="last" style={{ minWidth: 260 }}>
                              {l.explanation ? (
                                <div className="stack" style={{ gap: 2 }}>
                                  <span className="row-wrap">
                                    <Status value={l.explanation.status === 'submitted' ? 'submitted' : l.explanation.status} label={l.explanation.status === 'submitted' ? 'Waiting for approval' : undefined} />
                                    {l.explanation.authorType === 'agent' && <Badge tone="info">agent</Badge>}
                                  </span>
                                  <span className="xs ink2">{l.explanation.narrative.length > 120 ? `${l.explanation.narrative.slice(0, 117)}…` : l.explanation.narrative}</span>
                                </div>
                              ) : l.material ? (
                                <Status value="unexplained" label="Needs explanation" />
                              ) : (
                                <span className="xs muted">Not required</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title="No large movements">Nothing moved past half the threshold. Show every line to browse.</Empty>
                )}
              </Card>
              {line && <LineDrawer view={v} line={line} onClose={() => setOpenLine(null)} />}
            </>
          );
        }}
      </Query>
    </div>
  );
}

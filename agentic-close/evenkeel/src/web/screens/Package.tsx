import { FileCheck2, Printer, RefreshCw, Signature } from 'lucide-react';
import { useState } from 'react';
import { useAgents } from '../lib/agents';
import { useAction, useApi } from '../lib/api';
import { humanize, money, pct, period, plural, when } from '../lib/format';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Dialog, Empty, Field, Kv, Notice, PageHead, Query, Seg, Status } from '../ui/kit';
import { StatementTable } from '../ui/statement';
import { Term } from '../ui/term';

function ApproveDialog({ id, version, periodKey, onClose }: { id: string; version: number; periodKey: string; onClose: () => void }) {
  const [statement, setStatement] = useState(`I approve the ${period(periodKey)} close package (version ${version}).`);
  const approve = useAction('package.approve', { success: 'Package approved and signed. The reporting task is complete.', onSuccess: onClose });
  return (
    <Dialog
      title="Approve the close package"
      description="Your approval signs this exact version (by content hash). If any number changes later, a new version is needed."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Signature size={16} aria-hidden />} busy={approve.isPending} onClick={() => approve.mutate({ id, statement })} data-testid="confirm-package">
            Approve and sign
          </Button>
        </>
      }
    >
      <Field label="Statement" htmlFor="pkg-statement">
        <textarea id="pkg-statement" className="textarea" value={statement} onChange={(e) => setStatement(e.target.value)} maxLength={500} />
      </Field>
    </Dialog>
  );
}

function PackageView({ id }: { id: string }) {
  const { info, can } = useSession();
  const q = useApi('package.get', { id });
  const [view, setView] = useState<'is' | 'bs'>('is');
  const [approving, setApproving] = useState(false);
  return (
    <Query q={q} rows={12}>
      {({ summary: s, content: c, stale }) => (
        <>
          <Card
            title={
              <span className="row-wrap">
                {c.title} <Status value={s.status} label={s.status === 'final' ? 'Approved' : 'Draft'} />
              </span>
            }
            hint={`Version ${s.version} · generated ${when(s.generatedAt)} by ${s.generatedBy?.name ?? 'the close-package agent'}${s.approvedBy ? ` · approved by ${s.approvedBy.name} ${when(s.approvedAt)}` : ''}`}
            actions={
              <>
                <Button size="s" variant="quiet" icon={<Printer size={14} aria-hidden />} onClick={() => window.print()}>
                  Print / PDF
                </Button>
                {s.status === 'draft' && can('package.approve') && (
                  <Button variant="primary" size="s" icon={<Signature size={14} aria-hidden />} disabled={stale || s.generatedBy?.id === info.user.id} title={s.generatedBy?.id === info.user.id ? 'You generated this version; someone else approves it.' : stale ? 'Numbers changed; generate a new version.' : undefined} onClick={() => setApproving(true)} data-testid="approve-package">
                    Approve and sign
                  </Button>
                )}
              </>
            }
          >
            {stale && s.status === 'draft' && (
              <Notice tone="warn" title="Numbers changed since this version was generated">
                Generate a new version so the package matches the ledger.
              </Notice>
            )}
            {c.fictional && <p className="xs muted">Fictional company; all figures invented for the demo.</p>}
            <Kv items={[['Content hash', <span key="h" className="mono xs">{s.contentHash.slice(0, 32)}…</span>], ['Trial balance', c.consolidated.balanced ? `balanced (${money(c.consolidated.tbTotals.debit, c.currency)} each side)` : 'NOT balanced'], ['Exchange rates', c.fxRates.map((r) => `${r.pair} closing ${r.closing} · average ${r.average}`).join('; ') || '—']]} />
          </Card>

          {c.commentary && (
            <Card title="Controller's commentary">
              <p style={{ whiteSpace: 'pre-line', fontFamily: 'var(--font-display)', fontSize: '1.08rem', lineHeight: 1.6 }}>{c.commentary}</p>
            </Card>
          )}

          <Card title="Consolidated statements" actions={<Seg label="Statement" value={view} onChange={setView} items={[{ value: 'is', label: 'Income statement' }, { value: 'bs', label: 'Balance sheet' }]} />} flush>
            <StatementTable st={view === 'is' ? c.consolidated.incomeStatement : c.consolidated.balanceSheet} drill={false} />
          </Card>

          <div className="grid grid-2">
            <Card title="Reconciliations" hint={`${c.reconciliations.filter((r) => r.status === 'reviewed').length} of ${c.reconciliations.length} signed off`} flush>
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {c.reconciliations.map((r) => (
                      <tr key={r.title}>
                        <td className="first small">
                          {r.title}
                          <div className="xs muted">
                            {r.preparedBy ?? '—'} → {r.reviewedBy ?? '—'}
                          </div>
                        </td>
                        <td className="num small">{money(r.unexplained, c.currency)}</td>
                        <td className="last">
                          <Status value={r.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title="Close checklist" hint={`${c.checklist.filter((t) => t.status === 'complete').length} of ${c.checklist.length} complete`} flush>
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {c.checklist.map((t) => (
                      <tr key={t.code}>
                        <td className="first small">
                          <span className="mono muted">{t.code}</span> {t.title}
                        </td>
                        <td className="last">
                          <Status value={t.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          <Card title="Material variances" hint={<Term id="ek:VarianceExplanation">Approved explanations</Term>} flush>
            {c.flux.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="first" scope="col">
                        Line
                      </th>
                      <th scope="col" className="num">
                        Variance
                      </th>
                      <th scope="col" className="last">
                        Explanation
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.flux.map((f, i) => (
                      <tr key={i}>
                        <td className="first small">
                          {f.entity} · {f.account}
                          <div className="xs muted">vs {f.comparison.replace(/_/g, ' ')}</div>
                        </td>
                        <td className="num small">
                          {money(f.variance, c.currency, { signed: true })} <span className="muted">{pct(f.variancePct)}</span>
                        </td>
                        <td className="last small">
                          {f.narrative ?? <span className="muted">—</span>}
                          <div className="xs muted">
                            {humanize(f.status)}
                            {f.approvedBy ? ` · ${f.approvedBy}` : ''}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No material variances" />
            )}
          </Card>

          <div className="grid grid-2">
            <Card title="Exceptions" hint={plural(c.exceptions.length, 'exception')} flush>
              <div className="list">
                {c.exceptions.map((e, i) => (
                  <div key={i} className="list-item">
                    <span className="grow small">
                      {e.title}
                      {e.resolution && <div className="xs muted">{e.resolution}</div>}
                    </span>
                    <Status value={e.severity} />
                    <Status value={e.status} />
                  </div>
                ))}
                {!c.exceptions.length && <Empty title="None" />}
              </div>
            </Card>
            <Card title="Agent activity this close">
              <Kv
                items={[
                  ['Runs', String(c.agentActivity.runs)],
                  ['Proposals', String(c.agentActivity.proposals)],
                  ['Posted automatically under policy', String(c.agentActivity.autoApplied)],
                  ['Approved by people', String(c.agentActivity.approvedByPeople)],
                  ['Rejected', String(c.agentActivity.rejected)],
                  ['Still pending', String(c.agentActivity.pending)],
                  ['Model cost', `$${c.agentActivity.costUsd.toFixed(2)} (${c.agentActivity.tokens.toLocaleString()} tokens)`],
                ]}
              />
            </Card>
          </div>

          <Card title="Adjusting entries" hint={`${plural(c.adjustments.length, 'entry', 'entries')} this month, with who prepared and approved each`} flush>
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th className="first" scope="col">
                      Entry
                    </th>
                    <th scope="col">Type</th>
                    <th scope="col" className="num">
                      Amount
                    </th>
                    <th scope="col" className="last">
                      Prepared → approved
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {c.adjustments.map((a) => (
                    <tr key={a.entryNumber}>
                      <td className="first small">
                        <span className="mono">{a.entryNumber}</span> · {a.entity}
                        <div className="xs muted">{a.memo}</div>
                      </td>
                      <td className="small">{humanize(a.type)}</td>
                      <td className="num small">{money(a.amount, c.currency)}</td>
                      <td className="last xs">
                        {a.preparedBy ?? '—'} → {a.approvedBy ?? a.policy ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {approving && <ApproveDialog id={s.id} version={s.version} periodKey={s.periodKey} onClose={() => setApproving(false)} />}
        </>
      )}
    </Query>
  );
}

export function ClosePackage() {
  const { can } = useSession();
  const agents = useAgents();
  const list = useApi('package.list', {});
  const generate = useAction('package.generate', { success: (o) => `Version ${o.version} generated.` });
  const [selected, setSelected] = useState<string | null>(null);
  const [periodSel, setPeriodSel] = useState<string | null>(null);
  const readiness = useApi('close.lockReadiness', {});
  const locked = !!readiness.data && readiness.data.periodStatus.every((p) => p.status === 'hard_close');
  return (
    <div className="page">
      <PageHead
        eyebrow="Close package"
        title="The month, signed"
        sub={
          <>
            The <Term id="ek:ClosePackage">close package</Term> bundles the statements, reconciliations, variance explanations, exceptions and every adjusting entry, sealed with a content hash. The CFO's approval completes reporting.
          </>
        }
        actions={
          can('package.generate') && !locked ? (
            <Button icon={<RefreshCw size={16} aria-hidden />} busy={generate.isPending} onClick={() => generate.mutate({})}>
              Generate new version
            </Button>
          ) : null
        }
      />
      <Query
        q={list}
        rows={4}
        empty={(d) =>
          d.length ? null : (
            <Empty icon={<FileCheck2 size={22} />} title="No package yet">
              The close-package agent prepares it once reconciliations, variances and exceptions are settled. You can also generate one now.
            </Empty>
          )
        }
      >
        {(pkgs) => {
          const periods = [...new Set(pkgs.map((p) => p.periodKey))];
          const defaultPeriod = agents.periodKey && periods.includes(agents.periodKey) ? agents.periodKey : periods[0]!;
          const periodKey = periodSel && periods.includes(periodSel) ? periodSel : defaultPeriod;
          const versions = pkgs.filter((p) => p.periodKey === periodKey);
          const current = selected && versions.some((v) => v.id === selected) ? selected : versions[0]!.id;
          return (
            <>
              <div className="row-wrap">
                <label className="row small" style={{ gap: 6 }}>
                  <span>Period</span>
                  <select className="select" style={{ width: 'auto', minHeight: 34 }} value={periodKey} onChange={(e) => (setPeriodSel(e.target.value), setSelected(null))}>
                    {periods.map((p) => (
                      <option key={p} value={p}>
                        {period(p)}
                      </option>
                    ))}
                  </select>
                </label>
                {versions.map((p) => (
                  <button key={p.id} type="button" className={`badge ${p.id === current ? 't-accent' : 't-outline'}`} style={{ cursor: 'pointer', minHeight: 28 }} onClick={() => setSelected(p.id)} aria-pressed={p.id === current}>
                    v{p.version} · {p.status === 'final' ? 'approved' : 'draft'}
                  </button>
                ))}
                {versions.some((p) => p.status === 'final') && <Badge tone="good">Signed</Badge>}
              </div>
              <PackageView key={current} id={current} />
            </>
          );
        }}
      </Query>
    </div>
  );
}

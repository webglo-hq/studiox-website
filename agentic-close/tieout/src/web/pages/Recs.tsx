/** Reconciliations: bank recs and subledger tie-outs, and the bank reconciliation workbench. */
import { ArrowLeft, CircleCheck, CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, qs, type BankWorkbench, type RecsData } from '../api';
import { Badge, ErrorBox, Loading, Money, ProposalStatus, ReasonDialog, Segmented, Term } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { date, periodName } from '../lib/format';
import { useRoute } from '../lib/router';

const REC_TONE: Record<string, 'good' | 'info' | 'warn' | 'neutral'> = { reviewed: 'good', prepared: 'info', in_progress: 'warn', not_started: 'neutral', reopened: 'warn' };

export function Recs() {
  const route = useRoute();
  if (route.path[1] === 'bank' && route.path[2]) return <BankRec id={route.path[2]} />;
  return <RecList />;
}

function RecList() {
  const me = useMe();
  const { period, toast, bump } = useApp();
  const { data, error, loading, reload } = useData(() => api<RecsData>(`/recs?period=${period}`), [period]);
  const [note, setNote] = useState<{ path: string; label: string } | null>(null);

  async function act(path: string, label: string, body: unknown = {}) {
    try {
      await api(path, { body });
      toast(label);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'That did not work.', 'bad');
    }
  }
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className={loading ? 'skeleton' : undefined}>
      <div className="page-head">
        <div>
          <h1>Reconciliations</h1>
          <p className="lede">
            Every balance-sheet account that has an outside source of truth is <Term id="tie:Reconciliation">reconciled</Term> to it: bank statements to cash, the AP and AR agings to their control accounts. A
            preparer certifies; a different person reviews (<Term id="tie:SegregationOfDuties">AX-SOD-03</Term>).
          </p>
        </div>
      </div>
      <section className="card" aria-labelledby="h-bank" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2 id="h-bank">Bank accounts · {periodName(period)}</h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" className="r">
                  Statement
                </th>
                <th scope="col" className="r">
                  Ledger
                </th>
                <th scope="col" className="r">
                  Unreconciled
                </th>
                <th scope="col">Matched</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.bank.map((b) => (
                <tr key={b.bankAccountId}>
                  <td>
                    <a className="row-link" href={`#/recs/bank/${b.bankAccountId}`}>
                      {b.name}
                    </a>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {b.entityCode} · GL {b.glAccount} · {b.currency}
                    </div>
                  </td>
                  <td className="r">
                    <Money minor={b.externalBalanceMinor} currency={b.currency} />
                  </td>
                  <td className="r">
                    <Money minor={b.glBalanceMinor} currency={b.currency} />
                  </td>
                  <td className="r">
                    {b.tiesOut ? (
                      <Badge tone="good">Ties out</Badge>
                    ) : (
                      <span style={{ color: 'var(--danger)' }}>
                        <Money minor={b.unreconciledMinor} currency={b.currency} />
                      </span>
                    )}
                  </td>
                  <td>
                    {b.matched} matched{b.unmatchedBank + b.unmatchedLedger ? `, ${b.unmatchedBank + b.unmatchedLedger} open` : ''}
                    {b.openItems ? ` · ${b.openItems} reconciling` : ''}
                  </td>
                  <td>
                    <Badge tone={REC_TONE[b.status] ?? 'neutral'}>{b.status.replace('_', ' ')}</Badge>
                    {b.preparer ? <div className="muted" style={{ fontSize: 12 }}>Prepared: {b.preparer}{b.reviewer ? ` · Reviewed: ${b.reviewer}` : ''}</div> : null}
                  </td>
                  <td>
                    <a className="btn small" href={`#/recs/bank/${b.bankAccountId}`}>
                      Open workbench
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card" aria-labelledby="h-sub">
        <div className="card-head">
          <h2 id="h-sub">
            <Term id="tie:SubledgerTieOut">Subledger tie-outs</Term>
          </h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Subledger</th>
                <th scope="col" className="r">
                  Aging
                </th>
                <th scope="col" className="r">
                  GL
                </th>
                <th scope="col" className="r">
                  Difference
                </th>
                <th scope="col">Notes</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.subledgers.map((s) => (
                <tr key={`${s.entityId}-${s.kind}`}>
                  <td>
                    <strong>{s.kind === 'ap' ? 'Accounts payable' : 'Accounts receivable'}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {s.entityCode} · GL {s.accountCode} · {s.counterparties} {s.kind === 'ap' ? 'vendors' : 'customers'}
                    </div>
                  </td>
                  <td className="r">
                    <Money minor={s.subledgerMinor} currency={s.currency} />
                  </td>
                  <td className="r">
                    <Money minor={s.glMinor} currency={s.currency} />
                  </td>
                  <td className="r">{s.differenceMinor === 0 ? <Badge tone="good">Agrees</Badge> : <Money minor={s.differenceMinor} currency={s.currency} />}</td>
                  <td style={{ fontSize: 13 }}>{s.wrongSign.length ? s.wrongSign.map((w) => `${w.name} has a debit balance (${(Math.abs(w.openMinor) / 100).toLocaleString('en-US', { style: 'currency', currency: s.currency })})`).join('; ') : '—'}</td>
                  <td>
                    <Badge tone={REC_TONE[s.status] ?? 'neutral'}>{s.status.replace('_', ' ')}</Badge>
                    {s.preparer ? <div className="muted" style={{ fontSize: 12 }}>Prepared: {s.preparer}{s.reviewer ? ` · Reviewed: ${s.reviewer}` : ''}</div> : null}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {(s.status === 'not_started' || s.status === 'in_progress') && can(me, 'recon.prepare') ? (
                        <button className="btn small" onClick={() => (s.differenceMinor ? setNote({ path: `/recs/subledger/${s.entityId}/${s.kind}/certify${qs({ period })}`, label: 'Tie-out prepared.' }) : void act(`/recs/subledger/${s.entityId}/${s.kind}/certify${qs({ period })}`, 'Tie-out prepared.'))}>
                          Certify
                        </button>
                      ) : null}
                      {s.status === 'prepared' && s.recId && can(me, 'recon.review') ? (
                        <button className="btn small primary" onClick={() => void act(`/recs/${s.recId}/review`, 'Tie-out reviewed.')}>
                          Review
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <ReasonDialog open={!!note} title="Certify with a difference" label="Explain the difference and the follow-up" min={20} confirm="Certify" tone="primary" onCancel={() => setNote(null)} onConfirm={(r) => { const n = note!; setNote(null); void act(n.path, n.label, { note: r }); }} />
    </div>
  );
}

function BankRec({ id }: { id: string }) {
  const me = useMe();
  const { period, toast, bump } = useApp();
  const { data, error, loading, reload } = useData(() => api<BankWorkbench>(`/recs/bank/${id}?period=${period}`), [id, period]);
  const [side, setSide] = useState<'bank' | 'ledger'>('bank');
  const [justify, setJustify] = useState(false);

  async function act(path: string, label: string, body: unknown = {}) {
    try {
      await api(path, { body });
      toast(label);
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'That did not work.', 'bad');
    }
  }
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading the reconciliation" />;
  const ccy = data.account.currency;
  const s = data.state;
  const ext = data.items.filter((i) => i.status === 'open' && i.side === 'external');
  const led = data.items.filter((i) => i.status === 'open' && i.side === 'ledger');
  const rec = data.reconciliation;
  const needsNote = s.unexplainedMinor !== 0 || s.unmatchedBank > 0;
  return (
    <div className={loading ? 'skeleton' : undefined}>
      <a href="#/recs" className="row" style={{ gap: 6, marginBottom: 10 }}>
        <ArrowLeft className="icon" aria-hidden="true" /> All reconciliations
      </a>
      <div className="page-head">
        <div>
          <h1>{data.account.name}</h1>
          <p className="lede">
            {data.account.bank} ••{data.account.last4} · {ccy} · statement format {data.account.format.toUpperCase()} · {periodName(period)}
            {data.statement?.sourceDocumentId ? (
              <>
                {' '}
                · <a href={`#/documents/${data.statement.sourceDocumentId}`}>view the imported statement file</a>
              </>
            ) : null}
          </p>
        </div>
        <div className="actions">
          {(!rec || rec.status === 'in_progress' || rec.status === 'not_started') && can(me, 'recon.prepare') ? (
            <button className="btn primary" disabled={!s.tiesOut} title={s.tiesOut ? 'Certify as preparer' : 'It must tie out first (AX-REC-01)'} onClick={() => (needsNote ? setJustify(true) : void act(`/recs/bank/${id}/certify?period=${period}`, 'Reconciliation certified.'))}>
              Certify as preparer
            </button>
          ) : null}
          {rec?.status === 'prepared' && can(me, 'recon.review') ? (
            <button className="btn primary" onClick={() => void act(`/recs/${rec.id}/review`, 'Reconciliation reviewed.')}>
              Review & sign
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <section className="card card-pad" aria-labelledby="h-tie">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 id="h-tie">Tie-out</h2>
            {s.tiesOut ? (
              <Badge tone="good">Ties out</Badge>
            ) : (
              <Badge tone="bad">
                Out by <Money minor={s.unreconciledMinor} currency={ccy} />
              </Badge>
            )}
          </div>
          <table className="data" style={{ marginTop: 8 }}>
            <tbody>
              <tr>
                <td>Balance per bank statement</td>
                <td className="r">
                  <Money minor={s.statementBalanceMinor} currency={ccy} />
                </td>
              </tr>
              {ext.map((i) => (
                <tr key={i.id}>
                  <td style={{ paddingLeft: 24 }}>
                    {i.kind === 'deposit_in_transit' ? <Term id="tie:DepositInTransit">Deposit in transit</Term> : i.kind === 'outstanding_check' ? <Term id="tie:OutstandingCheck">Outstanding check</Term> : i.kind.replace('_', ' ')}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {i.description}
                    </div>
                  </td>
                  <td className="r">
                    <Money minor={i.amountMinor} currency={ccy} signed />
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Adjusted bank balance</strong>
                </td>
                <td className="r">
                  <strong>
                    <Money minor={s.adjustedExternalMinor} currency={ccy} />
                  </strong>
                </td>
              </tr>
              <tr>
                <td>Balance per general ledger</td>
                <td className="r">
                  <Money minor={s.glBalanceMinor} currency={ccy} />
                </td>
              </tr>
              {led.map((i) => (
                <tr key={i.id}>
                  <td style={{ paddingLeft: 24 }}>
                    {i.kind === 'unexplained' ? <Term id="tie:UnexplainedDifference">Unexplained</Term> : i.kind.replace('_', ' ')}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {i.description}
                    </div>
                  </td>
                  <td className="r">
                    <Money minor={i.amountMinor} currency={ccy} signed />
                  </td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Adjusted book balance</strong>
                </td>
                <td className="r">
                  <strong>
                    <Money minor={s.adjustedLedgerMinor} currency={ccy} />
                  </strong>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            <a href="#/ontology?axiom=AX-REC-01">AX-REC-01</a>: adjusted bank must equal adjusted book. {s.matched} lines matched; {s.unmatchedBank} bank and {s.unmatchedLedger} ledger lines still open.
          </p>
        </section>
        <section className="card" aria-labelledby="h-pend">
          <div className="card-head">
            <h2 id="h-pend">Waiting for a decision</h2>
            <span className="right">
              {rec ? <Badge tone={REC_TONE[rec.status] ?? 'neutral'}>{rec.status.replace('_', ' ')}</Badge> : <Badge>not started</Badge>}
            </span>
          </div>
          {data.proposals.length ? (
            data.proposals.map((p) => (
              <div className="prop" key={p.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <div>
                  <a className="title" href={`#/inbox?open=${p.id}`}>
                    <span className="mono muted">{p.ref}</span> {p.title}
                  </a>
                  <div className="meta">
                    <ProposalStatus status={p.status} route={p.route} />
                    {p.flags.includes('injection_suspected') ? <Badge tone="bad">Instruction-like text in the bank memo</Badge> : null}
                  </div>
                </div>
                <Money minor={p.amountMinor} currency={p.currency} />
              </div>
            ))
          ) : (
            <div className="empty">
              <CircleCheck className="icon" aria-hidden="true" /> Nothing waiting.
            </div>
          )}
          {data.signoffs.length ? (
            <ul className="checks" style={{ padding: '8px 16px' }}>
              {data.signoffs.map((x, i) => (
                <li key={i}>
                  <Badge tone="good" icon={false}>
                    {x.role}
                  </Badge>
                  {x.name} · {date(x.at)}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      <section className="card" aria-labelledby="h-lines">
        <div className="card-head">
          <h2 id="h-lines">Lines</h2>
          <span className="right">
            <Segmented<'bank' | 'ledger'> label="Show lines from" value={side} onChange={setSide} options={[{ value: 'bank', label: `Bank (${data.bankLines.length})` }, { value: 'ledger', label: `Ledger (${data.ledgerLines.length})` }]} />
          </span>
        </div>
        <div className="table-wrap" style={{ maxHeight: 560 }}>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">{side === 'bank' ? 'Description (from the bank)' : 'Entry'}</th>
                <th scope="col" className="r">
                  Amount
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {(side === 'bank' ? data.bankLines : data.ledgerLines).map((l) => (
                <tr key={l.id}>
                  <td className="num">{date(l.date)}</td>
                  <td style={{ maxWidth: 520 }}>
                    {'entryRef' in l ? (
                      <>
                        <a href={`#/journal/${l.entryId}`} className="mono">
                          {l.entryRef}
                        </a>{' '}
                        {l.memo}
                      </>
                    ) : (
                      <span style={{ overflowWrap: 'anywhere' }}>{l.description}</span>
                    )}
                  </td>
                  <td className="r">
                    <Money minor={l.amountMinor} currency={ccy} signed />
                  </td>
                  <td>
                    {l.matchId ? (
                      <Badge tone="good">Matched</Badge>
                    ) : l.proposal ? (
                      <a href={`#/inbox?open=${l.proposal.id}`}>
                        <Badge tone="warn" icon={<CircleAlert className="icon" aria-hidden="true" />}>
                          {l.proposal.ref} {l.proposal.status === 'applied' ? 'applied' : 'proposed'}
                        </Badge>
                      </a>
                    ) : (
                      <Badge>Open</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <ReasonDialog open={justify} title="Certify with open items" label="Justify certifying now and describe the follow-up (AX-REC-04)" min={20} confirm="Certify" tone="primary" onCancel={() => setJustify(false)} onConfirm={(r) => { setJustify(false); void act(`/recs/bank/${id}/certify?period=${period}`, 'Reconciliation certified with a documented justification.', { note: r }); }} />
    </div>
  );
}

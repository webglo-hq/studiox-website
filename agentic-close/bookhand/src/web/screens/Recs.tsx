import { ArrowLeft, CheckCircle2, Link2, RotateCcw, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { date, label, money, recTypeLabel } from '../lib/format';
import { navigate, useAction, useApi } from '../lib/hooks';
import { Badge, Empty, ErrorBox, Money, ReasonDialog, Skeleton, StatusBadge, Term } from '../components/ui';

interface RecRow {
  id: string | null;
  entity: string;
  entityId: string;
  periodId: string;
  account: string;
  accountNumber: string;
  type: string | null;
  required: boolean;
  status: string;
  gl: number | null;
  external: number | null;
  items: number | null;
  difference: number | null;
  risk: string | null;
  currency?: string;
  preparedBy: string | null;
  reviewedBy: string | null;
  pending: number;
}

const TYPE_TERMS: Record<string, string> = { bank: 'bh:BankReconciliation', subledger_ap: 'bh:SubledgerTieOut', subledger_ar: 'bh:SubledgerTieOut', intercompany: 'bh:IntercompanyReconciliation' };

export function RecsScreen() {
  const { data, error, reload } = useApi<{ close: { id: string; name: string; periodEnd: string }; recs: RecRow[] }>('/api/recs', { pollMs: 8000 });
  const { run, busy } = useAction();
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={8} />;
  const required = data.recs.filter((r) => r.required);
  const reviewed = required.filter((r) => r.status === 'reviewed').length;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Reconciliations</h1>
          <div className="sub">
            {data.close.name}: {reviewed} of {required.length} required reconciliations reviewed. A <Term id="bh:Reconciliation">reconciliation</Term> is certified when the GL agrees to the external balance after listing every <Term id="bh:ReconcilingItem">reconciling item</Term>.
          </div>
        </div>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Entity</th>
              <th>Account</th>
              <th>Type</th>
              <th className="num">GL balance</th>
              <th className="num">External</th>
              <th className="num">Items</th>
              <th className="num">Difference</th>
              <th>Status</th>
              <th>Sign-offs</th>
            </tr>
          </thead>
          <tbody>
            {data.recs.map((r) => (
              <tr key={`${r.entity}-${r.account}-${r.id}`} className={r.id ? 'clickable' : ''} onClick={() => r.id && navigate(`/recs/${r.id}`)}>
                <td>
                  <Badge>{r.entity}</Badge>
                </td>
                <td>
                  {r.id ? (
                    <a href={`#/recs/${r.id}`} onClick={(e) => e.stopPropagation()}>
                      {r.account}
                    </a>
                  ) : (
                    r.account
                  )}
                  {r.required && <div className="tiny muted">Required to lock</div>}
                </td>
                <td>{r.type ? <Term id={TYPE_TERMS[r.type] ?? 'bh:Reconciliation'}>{recTypeLabel(r.type)}</Term> : '—'}</td>
                <td className="num">{r.gl === null ? '—' : <Money minor={r.gl} currency={r.currency} />}</td>
                <td className="num">{r.external === null ? '—' : <Money minor={r.external} currency={r.currency} />}</td>
                <td className="num">{r.items ?? '—'}</td>
                <td className="num">{r.difference === null ? '—' : r.difference === 0 ? <span className="pos">0.00</span> : <Money minor={r.difference} currency={r.currency} className="neg" />}</td>
                <td>
                  <StatusBadge status={r.status} />
                  {r.pending > 0 && <div className="tiny" style={{ color: 'var(--attention)' }}>{r.pending} pending</div>}
                  {r.risk === 'high' && <div className="tiny neg">High risk</div>}
                </td>
                <td className="tiny">
                  {r.preparedBy && <div>Prepared: {r.preparedBy}</div>}
                  {r.reviewedBy && <div>Reviewed: {r.reviewedBy}</div>}
                  {!r.id && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); void run(() => api.post('/api/recs/start', { entityId: r.entityId, periodId: r.periodId, account: r.accountNumber }), 'Reconciliation started.'); }}>
                      Start
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RecDetail {
  rec: { id: string; type: string; status: string; risk: string; currency: string; gl: number; external: number; reconcilingTotal: number; difference: number; unexplained: number; notes: string | null; preparedBy: string | null; preparedAt: string | null; reviewedBy: string | null; reviewedAt: string | null };
  entity: string;
  period: { id: string; name: string; start: string; end: string; status: string };
  account: { number: string; name: string; subtype: string };
  bankAccount: { id: string; name: string; institution: string; last4: string } | null;
  statement: { opening: number; closing: number; start: string; end: string } | null;
  matches: Array<{ id: string; type: string; status: string; confidence: number; rule: string; explanation: string; proposalId: string | null; acceptedBy: string | null; bank: Array<{ id: string; date: string; amount: number; description: string }>; ledger: Array<{ id: string; date: string; amount: number; entryNumber?: string; entryId?: string; description?: string }> }>;
  items: Array<{ id: string; kind: string; description: string; amount: number; itemDate: string; expectedClearDate: string | null; clearedDate: string | null; status: string; ageDays: number }>;
  openBank: Array<{ id: string; date: string; amount: number; description: string; reference: string | null }>;
  openLedger: Array<{ id: string; date: string; amount: number; entryNumber?: string; entryId: string; description?: string; memo: string | null }>;
  pendingProposals: Array<{ id: string; kind: string; title: string; confidence: number }>;
  signoffs: Array<{ role: string; action: string; user: string; at: string; comment: string | null }>;
  certification: { problems: string[]; needsNote: boolean; canPrepare: boolean; canReview: boolean; canReopen: boolean };
}

export function RecWorkbench({ id }: { id: string }) {
  const { data, error, reload } = useApi<RecDetail>(`/api/recs/${id}`);
  const { run, busy } = useAction();
  const [pickBank, setPickBank] = useState<Set<string>>(new Set());
  const [pickLedger, setPickLedger] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [reopen, setReopen] = useState(false);
  const [certifyNote, setCertifyNote] = useState(false);
  const [showAccepted, setShowAccepted] = useState(false);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={10} />;
  const { rec } = data;
  const cur = rec.currency;
  const accepted = data.matches.filter((m) => m.status === 'accepted');
  const proposed = data.matches.filter((m) => m.status === 'proposed');
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const n = new Set(set);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    setter(n);
  };
  const bankSum = data.openBank.filter((b) => pickBank.has(b.id)).reduce((s, b) => s + b.amount, 0);
  const ledgerSum = data.openLedger.filter((l) => pickLedger.has(l.id)).reduce((s, l) => s + l.amount, 0);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <a href="#/recs" className="small row">
        <ArrowLeft size={14} aria-hidden="true" /> All reconciliations
      </a>
      <div className="page-head">
        <div>
          <div className="row-wrap" style={{ marginBottom: 6 }}>
            <Badge>{data.entity}</Badge>
            <StatusBadge status={rec.status} />
            {rec.risk === 'high' && <Badge tone="danger">High risk</Badge>}
            <span className="small muted">{data.period.name}</span>
          </div>
          <h1>
            {data.account.number} {data.account.name}
          </h1>
          {data.bankAccount && (
            <div className="sub">
              {data.bankAccount.institution} · {data.bankAccount.name} ····{data.bankAccount.last4}
            </div>
          )}
        </div>
        <div className="row-wrap">
          {data.certification.canReopen && (
            <button type="button" className="btn" onClick={() => setReopen(true)}>
              <RotateCcw size={15} aria-hidden="true" /> Reopen
            </button>
          )}
          {data.certification.canPrepare && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => (data.certification.needsNote ? setCertifyNote(true) : void run(() => api.post(`/api/recs/${id}/sign`, { role: 'preparer' }), 'Certified as preparer.'))}>
              <ShieldCheck size={15} aria-hidden="true" /> Certify as preparer
            </button>
          )}
          {data.certification.canReview && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => api.post(`/api/recs/${id}/sign`, { role: 'reviewer' }), 'Reviewed.')}>
              <ShieldCheck size={15} aria-hidden="true" /> Certify as reviewer
            </button>
          )}
        </div>
      </div>

      <section className="grid grid-4" aria-label="Reconciliation summary">
        <div className="card stat">
          <div className="label">GL balance</div>
          <div className="value">
            <Money minor={rec.gl} currency={cur} />
          </div>
          <div className="delta">at {date(data.period.end)}</div>
        </div>
        <div className="card stat">
          <div className="label">{data.bankAccount ? 'Bank statement' : 'Subledger'}</div>
          <div className="value">
            <Money minor={rec.external} currency={cur} />
          </div>
          <div className="delta">{data.statement ? `closing ${date(data.statement.end)}` : 'open items total'}</div>
        </div>
        <div className="card stat">
          <div className="label">
            <Term id="bh:ReconcilingItem">Reconciling items</Term>
          </div>
          <div className="value">
            <Money minor={rec.reconcilingTotal} currency={cur} />
          </div>
          <div className="delta">{data.items.filter((i) => !i.clearedDate || i.clearedDate > data.period.end).length} open</div>
        </div>
        <div className={`card stat${rec.unexplained === 0 ? ' ok' : ' bad'}`}>
          <div className="label">Unexplained difference</div>
          <div className="value">{rec.unexplained === 0 ? <span className="pos">0.00</span> : <Money minor={rec.unexplained} currency={cur} className="neg" />}</div>
          <div className="delta">{rec.unexplained !== 0 && rec.difference === 0 ? 'listed as unexplained: needs a note to certify' : 'GL − external − explained items'}</div>
        </div>
      </section>

      {data.certification.problems.length > 0 && rec.status !== 'reviewed' && (
        <div className="callout attention small">
          <strong>Not ready to certify:</strong> {data.certification.problems.join(' ')}
        </div>
      )}

      {data.pendingProposals.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Waiting for a decision</h2>
            <a href="#/inbox?view=pending" className="small">
              Open inbox
            </a>
          </div>
          <ul className="list">
            {data.pendingProposals.map((p) => (
              <li key={p.id} className="row small">
                <a href={`#/inbox/${p.id}`} className="grow">
                  {p.title}
                </a>
                <Badge>{(p.confidence * 100).toFixed(0)}%</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>
            <Term id="bh:ReconcilingItem">Reconciling items</Term>
          </h2>
          <span className="small muted">Timing differences clear next period; unexplained items need investigation</span>
        </div>
        {data.items.length === 0 ? (
          <div className="empty small">No reconciling items.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Description</th>
                  <th>Dated</th>
                  <th>Clears</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Badge tone={i.kind === 'unexplained' ? 'danger' : i.kind.includes('transit') || i.kind.includes('check') || i.kind.includes('timing') ? 'info' : ''}>{label(i.kind)}</Badge>
                    </td>
                    <td>{i.description}</td>
                    <td>{date(i.itemDate)}</td>
                    <td>{i.clearedDate ? `Cleared ${date(i.clearedDate)}` : i.expectedClearDate ? `Expected ${date(i.expectedClearDate)}` : <span className="neg">Unknown</span>}</td>
                    <td className="num">
                      <Money minor={i.amount} currency={cur} />
                    </td>
                    <td>
                      <StatusBadge status={i.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.bankAccount && (
        <section className="card">
          <div className="card-head">
            <h2>Match lines by hand</h2>
            <span className="small muted">Pick bank and ledger lines that belong together; totals must agree</span>
          </div>
          <div className="grid grid-2" style={{ padding: 12 }}>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Unmatched bank lines ({data.openBank.length})
              </div>
              {data.openBank.length === 0 ? (
                <div className="muted small">All bank lines are matched or explained.</div>
              ) : (
                <ul className="list card pick-list">
                  {data.openBank.map((b) => (
                    <li key={b.id}>
                      <label className="row small">
                        <input type="checkbox" checked={pickBank.has(b.id)} onChange={() => toggle(pickBank, setPickBank, b.id)} />
                        <span className="grow">
                          {date(b.date)} · {b.description}
                        </span>
                        <Money minor={b.amount} currency={cur} />
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Unmatched ledger lines ({data.openLedger.length})
              </div>
              {data.openLedger.length === 0 ? (
                <div className="muted small">All ledger lines are matched or explained.</div>
              ) : (
                <ul className="list card pick-list">
                  {data.openLedger.map((l) => (
                    <li key={l.id}>
                      <label className="row small">
                        <input type="checkbox" checked={pickLedger.has(l.id)} onChange={() => toggle(pickLedger, setPickLedger, l.id)} />
                        <span className="grow">
                          {date(l.date)} · {l.entryNumber} {l.description}
                        </span>
                        <Money minor={l.amount} currency={cur} />
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {(pickBank.size > 0 || pickLedger.size > 0) && (
            <div className="drawer-foot">
              <span className="small">
                Bank {money(bankSum, cur)} · Ledger {money(ledgerSum, cur)} {bankSum === ledgerSum ? <CheckCircle2 size={14} className="pos" aria-label="agree" /> : <XCircle size={14} className="neg" aria-label="differ" />}
              </span>
              <input className="input" style={{ maxWidth: 320 }} placeholder="Why do these belong together?" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Match note" />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || bankSum !== ledgerSum || !pickBank.size || !pickLedger.size || note.trim().length < 5}
                onClick={async () => {
                  const r = await run(() => api.post(`/api/recs/${id}/match`, { bankIds: [...pickBank], ledgerIds: [...pickLedger], note }), 'Matched.');
                  if (r) {
                    setPickBank(new Set());
                    setPickLedger(new Set());
                    setNote('');
                  }
                }}
              >
                <Link2 size={14} aria-hidden="true" /> Match
              </button>
            </div>
          )}
        </section>
      )}

      {data.matches.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>
              <Term id="bh:ReconciliationMatch">Matches</Term>: {accepted.length} accepted{proposed.length ? `, ${proposed.length} proposed` : ''}
            </h2>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAccepted(!showAccepted)} aria-expanded={showAccepted}>
              {showAccepted ? 'Hide' : 'Show'} all
            </button>
          </div>
          {(showAccepted ? data.matches : proposed).length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Bank</th>
                    <th>Ledger</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAccepted ? data.matches : proposed).map((m) => (
                    <tr key={m.id}>
                      <td>
                        <Badge>{label(m.type)}</Badge>
                        <div className="tiny muted">{m.rule}</div>
                      </td>
                      <td className="small">{m.bank.map((b) => <div key={b.id}>{date(b.date)} {b.description.slice(0, 48)}</div>)}</td>
                      <td className="small">
                        {m.ledger.map((l) => (
                          <div key={l.id}>
                            {l.entryId ? <a href={`#/ledger/${l.entryId}`}>{l.entryNumber}</a> : l.entryNumber} {date(l.date)}
                          </div>
                        ))}
                      </td>
                      <td className="num">{money(m.bank.reduce((s, b) => s + b.amount, 0), cur)}</td>
                      <td>
                        <StatusBadge status={m.status === 'accepted' ? 'approved' : m.status === 'proposed' ? 'pending' : 'rejected'} text={label(m.status)} />
                        {m.acceptedBy && <div className="tiny muted">{m.acceptedBy}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>
            <Term id="bh:Certification">Sign-offs</Term>
          </h2>
        </div>
        {data.signoffs.length === 0 ? (
          <Empty title="Not certified yet" />
        ) : (
          <ul className="list">
            {data.signoffs.map((s, i) => (
              <li key={i} className="row small">
                <Badge tone={s.action === 'revoke' ? 'danger' : 'success'}>{s.action === 'revoke' ? 'Reopened' : label(s.role)}</Badge>
                <span className="grow">
                  {s.user} · {date(s.at, 'time')} {s.comment && <span className="text-2">"{s.comment}"</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {certifyNote && (
        <ReasonDialog
          title="Certify with an unexplained difference"
          prompt={`${money(rec.unexplained, cur)} is still unexplained. Say what it is, why it is acceptable and what happens next (your note is kept with the certification).`}
          confirmLabel="Certify as preparer"
          minLength={15}
          onClose={() => setCertifyNote(false)}
          onSubmit={(comment) => run(() => api.post(`/api/recs/${id}/sign`, { role: 'preparer', comment }), 'Certified as preparer, with your note.')}
        />
      )}
      {reopen && <ReasonDialog title="Reopen reconciliation" prompt="What needs another look?" confirmLabel="Reopen" onClose={() => setReopen(false)} onSubmit={(reason) => run(() => api.post(`/api/recs/${id}/reopen`, { reason }), 'Reopened.')} />}
    </div>
  );
}

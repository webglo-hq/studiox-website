import { ArrowLeft, BadgeCheck, CheckCircle2, CircleAlert, FileText, Link2, Link2Off, Plus, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MethodOutput } from '../../app/methods';
import { useAction, useApi } from '../lib/api';
import { date, money, period, plural, when } from '../lib/format';
import { href, navigate, type Route } from '../lib/router';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Dialog, Empty, Field, Kv, LinkButton, Money, Notice, PageHead, Person, Query, Status } from '../ui/kit';
import { Term } from '../ui/term';

type Detail = MethodOutput<'recs.get'>;

const REC_TERM: Record<string, string> = { bank: 'ek:BankReconciliation', subledger: 'ek:SubledgerTieOut', intercompany: 'ek:IntercompanyReconciliation', balance_sheet: 'ek:BalanceSheetSubstantiation' };
const ITEM_TERM: Record<string, string> = { deposit_in_transit: 'ek:DepositInTransit', outstanding_check: 'ek:OutstandingCheck', unexplained: 'ek:UnexplainedDifference', bank_fee: 'ek:BankOnlyItem', bank_interest: 'ek:BankOnlyItem', timing: 'ek:TimingDifference' };

export function Reconciliations({ route, openId }: { route: Route; openId: string | null }) {
  if (openId) return <Workbench id={openId} />;
  return <RecList route={route} />;
}

function RecList({ route }: { route: Route }) {
  const q = useApi('recs.list', {});
  void route;
  return (
    <div className="page">
      <PageHead
        eyebrow="Reconciliations"
        title="Does every balance tie out?"
        sub={
          <>
            Each <Term id="ek:Reconciliation">reconciliation</Term> compares the ledger with an independent source: the bank statement, a subledger, the other entity or a schedule. Differences must be explained by <Term id="ek:ReconcilingItem">reconciling items</Term> before someone certifies and someone else reviews.
          </>
        }
      />
      <Query q={q} rows={8} empty={(d) => (d.length ? null : <Empty title="No reconciliations for this period" />)}>
        {(recs) => {
          const done = recs.filter((r) => r.status === 'reviewed').length;
          return (
            <Card title={`${done} of ${recs.length} signed off`} hint="Ledger minus comparison equals the difference; items explain it; what is left is unexplained." flush>
              <div className="table-wrap">
                <table className="table" data-testid="rec-table">
                  <thead>
                    <tr>
                      <th className="first" scope="col">
                        Reconciliation
                      </th>
                      <th scope="col" className="num">
                        Ledger
                      </th>
                      <th scope="col" className="num">
                        Comparison
                      </th>
                      <th scope="col" className="num">
                        Difference
                      </th>
                      <th scope="col" className="num">
                        Unexplained
                      </th>
                      <th scope="col">Status</th>
                      <th scope="col" className="last">
                        Preparer → reviewer
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recs.map((r) => (
                      <tr key={r.id} className="clickable" onClick={() => navigate(href(`/recs/${r.id}`))} data-testid={`rec-${r.title}`}>
                        <td className="first" style={{ minWidth: 240 }}>
                          <a href={href(`/recs/${r.id}`)} className="strong" style={{ color: 'var(--ink)', textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
                            {r.title}
                          </a>
                          <div className="xs muted">
                            {r.entityCode} · {r.accountCode} {r.accountName} · {r.comparisonLabel}
                          </div>
                          {(r.pendingProposals > 0 || r.openItems > 0) && (
                            <div className="row-wrap" style={{ marginTop: 4 }}>
                              {r.pendingProposals > 0 && <Badge tone="warn">{plural(r.pendingProposals, 'proposal')} waiting</Badge>}
                              {r.openItems > 0 && <Badge>{plural(r.openItems, 'open item')}</Badge>}
                            </div>
                          )}
                        </td>
                        <td className="num">
                          <Money cents={r.glBalance} currency={r.currency} />
                        </td>
                        <td className="num">
                          <Money cents={r.comparisonBalance} currency={r.currency} />
                        </td>
                        <td className="num">
                          <Money cents={r.difference} currency={r.currency} />
                        </td>
                        <td className={`num strong ${r.unexplained === 0 ? 'diff-ok' : 'diff-bad'}`}>{r.unexplained === 0 ? '0.00' : money(r.unexplained, r.currency)}</td>
                        <td>
                          <Status value={r.status} label={r.status === 'prepared' ? 'Certified' : r.status === 'reviewed' ? 'Signed off' : undefined} />
                        </td>
                        <td className="last small" style={{ minWidth: 160 }}>
                          {r.preparedBy?.name ?? r.owner?.name ?? '—'} → {r.reviewedBy?.name ?? r.reviewer?.name ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        }}
      </Query>
    </div>
  );
}

function ReviewDialog({ id, approve, onClose }: { id: string; approve: boolean; onClose: () => void }) {
  const [note, setNote] = useState('');
  const review = useAction('recs.review', { success: approve ? 'Signed off as reviewer.' : 'Returned to the preparer.', onSuccess: onClose });
  return (
    <Dialog
      title={approve ? 'Sign off as reviewer' : 'Return to the preparer'}
      description={approve ? 'Your sign-off completes maker-checker for this reconciliation and freezes its numbers.' : 'The preparer will see your note and certify again after fixing it.'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={approve ? 'good' : 'danger'} busy={review.isPending} disabled={!approve && note.trim().length < 3} onClick={() => review.mutate({ id, approve, note: note || undefined })} data-testid="confirm-review">
            {approve ? 'Sign off' : 'Return'}
          </Button>
        </>
      }
    >
      <Field label={approve ? 'Note (optional)' : 'What needs to change?'} htmlFor="review-note">
        <textarea id="review-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </Field>
    </Dialog>
  );
}

function AddItemDialog({ d, onClose }: { d: Detail; onClose: () => void }) {
  const [itemType, setItemType] = useState<'deposit_in_transit' | 'outstanding_check' | 'bank_fee' | 'bank_interest' | 'bank_error' | 'book_error' | 'timing' | 'unexplained' | 'fx'>('timing');
  const [side, setSide] = useState<'bank' | 'book'>('book');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [originDate, setOriginDate] = useState(`${d.summary.periodKey}-28`);
  const add = useAction('recs.addItem', { success: 'Reconciling item added.', onSuccess: onClose });
  const cents = Math.round(Number(amount.replace(/[$,\s]/g, '')) * 100);
  const valid = Number.isFinite(cents) && cents !== 0 && description.trim().length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(originDate);
  return (
    <Dialog
      title="Add a reconciling item"
      description="Explain part of the difference with evidence. It stays open until it clears (for example on next month's statement)."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} busy={add.isPending} onClick={() => add.mutate({ id: d.summary.id, item: { itemType, side, amount: cents, description, originDate, sourceRefs: [{ type: 'reconciliation', id: d.summary.id, label: 'Added by preparer' }] } })}>
            Add item
          </Button>
        </>
      }
    >
      <div className="grid grid-2">
        <Field label="Type" htmlFor="it-type">
          <select id="it-type" className="select" value={itemType} onChange={(e) => setItemType(e.target.value as typeof itemType)}>
            {['deposit_in_transit', 'outstanding_check', 'bank_fee', 'bank_interest', 'bank_error', 'book_error', 'timing', 'fx', 'unexplained'].map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Where it sits" htmlFor="it-side">
          <select id="it-side" className="select" value={side} onChange={(e) => setSide(e.target.value as 'bank' | 'book')}>
            <option value="book">In the books, not the comparison</option>
            <option value="bank">In the comparison, not the books</option>
          </select>
        </Field>
        <Field label={`Amount (${d.summary.currency})`} htmlFor="it-amount" help="Positive increases the side it sits on.">
          <input id="it-amount" className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="Date" htmlFor="it-date">
          <input id="it-date" className="input" type="date" value={originDate} onChange={(e) => setOriginDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Description" htmlFor="it-desc">
        <input id="it-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      </Field>
    </Dialog>
  );
}

function ResolveDialog({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const [status, setStatus] = useState<'cleared' | 'resolved' | 'written_off'>('cleared');
  const [note, setNote] = useState('');
  const resolve = useAction('recs.resolveItem', { success: 'Item resolved.', onSuccess: onClose });
  return (
    <Dialog
      title="Resolve reconciling item"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={note.trim().length < 3} busy={resolve.isPending} onClick={() => resolve.mutate({ itemId, status, note })}>
            Resolve
          </Button>
        </>
      }
    >
      <Field label="Outcome" htmlFor="rs-status">
        <select id="rs-status" className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="cleared">Cleared (appeared on a later statement)</option>
          <option value="resolved">Resolved (corrected by an entry)</option>
          <option value="written_off">Written off</option>
        </select>
      </Field>
      <Field label="Note" htmlFor="rs-note">
        <textarea id="rs-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
    </Dialog>
  );
}

function BankMatching({ d }: { d: Detail }) {
  const { can } = useSession();
  const [bankSel, setBankSel] = useState<Set<string>>(new Set());
  const [bookSel, setBookSel] = useState<Set<string>>(new Set());
  const [showMatched, setShowMatched] = useState(false);
  const match = useAction('recs.match', { success: 'Matched.', onSuccess: () => (setBankSel(new Set()), setBookSel(new Set())) });
  const [unmatchId, setUnmatchId] = useState<string | null>(null);
  const cur = d.summary.currency;
  const bank = d.bankLines.filter((l) => showMatched || !l.match);
  const book = d.bookLines.filter((l) => showMatched || !l.match);
  const bankSum = d.bankLines.filter((l) => bankSel.has(l.id)).reduce((s, l) => s + l.amount, 0);
  const bookSum = d.bookLines.filter((l) => bookSel.has(l.id)).reduce((s, l) => s + l.amount, 0);
  const editable = can('rec.prepare') && d.summary.status !== 'prepared' && d.summary.status !== 'reviewed';
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setter(n);
  };
  return (
    <Card
      title="Statement and ledger"
      hint={`${plural(d.bankLines.filter((l) => !l.match && !l.subsequent).length, 'statement line')} and ${plural(d.bookLines.filter((l) => !l.match).length, 'ledger line')} not matched`}
      actions={
        <label className="check small">
          <input type="checkbox" checked={showMatched} onChange={(e) => setShowMatched(e.target.checked)} /> Show matched
        </label>
      }
      flush
    >
      <div className="grid grid-2" style={{ gap: 0 }}>
        <div style={{ borderRight: '1px solid var(--line)' }}>
          <div className="small strong" style={{ padding: '4px 20px 8px' }}>
            Bank statement {d.statement?.filename && <span className="muted">· {d.statement.filename}</span>}
          </div>
          <div className="table-wrap" style={{ maxHeight: 460, overflowY: 'auto' }}>
            <table className="table">
              <tbody>
                {bank.map((l) => (
                  <tr key={l.id} aria-selected={bankSel.has(l.id)}>
                    <td className="first" style={{ width: 28 }}>
                      {editable && !l.match && <input type="checkbox" checked={bankSel.has(l.id)} onChange={() => toggle(bankSel, setBankSel, l.id)} aria-label={`Select statement line ${l.description}`} style={{ width: 18, height: 18 }} />}
                    </td>
                    <td>
                      <div className="small">{l.description}</div>
                      <div className="xs muted">
                        {date(l.date, 'short')}
                        {l.reference ? ` · ${l.reference}` : ''}
                        {l.subsequent ? ' · next month' : ''}
                      </div>
                      {l.suspicious.length > 0 && (
                        <Badge tone="bad" title={l.suspicious.join(', ')}>
                          <CircleAlert size={11} aria-hidden /> instructions in text
                        </Badge>
                      )}
                    </td>
                    <td className="num small">{money(l.amount, cur)}</td>
                    <td className="last" style={{ width: 90 }}>
                      {l.match ? (
                        <button type="button" className="badge t-good" style={{ border: 0, cursor: editable ? 'pointer' : 'default' }} onClick={() => editable && setUnmatchId(l.match!.id)} title={editable ? 'Undo this match' : `${l.match.type} match`}>
                          <Link2 size={11} aria-hidden /> {l.match.type.replace(/_/g, ' ')}
                        </button>
                      ) : (
                        <Badge tone="warn">open</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="small strong" style={{ padding: '4px 20px 8px' }}>
            Ledger · {d.summary.accountCode} {d.summary.accountName}
          </div>
          <div className="table-wrap" style={{ maxHeight: 460, overflowY: 'auto' }}>
            <table className="table">
              <tbody>
                {book.map((l) => (
                  <tr key={l.id} aria-selected={bookSel.has(l.id)}>
                    <td className="first" style={{ width: 28 }}>
                      {editable && !l.match && <input type="checkbox" checked={bookSel.has(l.id)} onChange={() => toggle(bookSel, setBookSel, l.id)} aria-label={`Select ledger line ${l.memo}`} style={{ width: 18, height: 18 }} />}
                    </td>
                    <td>
                      <div className="small">{l.memo}</div>
                      <div className="xs muted">
                        {date(l.date, 'short')} ·{' '}
                        <a href={href(`/journals/${l.entryId}`)} onClick={(e) => e.stopPropagation()}>
                          {l.entryNumber}
                        </a>
                      </div>
                    </td>
                    <td className="num small">{money(l.amount, cur)}</td>
                    <td className="last" style={{ width: 90 }}>
                      {l.match ? (
                        <Badge tone="good">
                          <Link2 size={11} aria-hidden /> matched
                        </Badge>
                      ) : (
                        <Badge tone="warn">open</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {(bankSel.size > 0 || bookSel.size > 0) && (
        <div className="card-foot">
          <span className="small">
            Bank {money(bankSum, cur)} · Ledger {money(bookSum, cur)} ·{' '}
            {bankSum === bookSum ? <strong className="diff-ok">equal</strong> : <strong className="diff-bad">differ by {money(bankSum - bookSum, cur)}</strong>}
          </span>
          <span className="grow" />
          <Button variant="primary" size="s" icon={<Link2 size={14} aria-hidden />} disabled={!bankSel.size || !bookSel.size || bankSum !== bookSum} busy={match.isPending} onClick={() => match.mutate({ reconciliationId: d.summary.id, bankTransactionIds: [...bankSel], journalLineIds: [...bookSel] })}>
            Match selected
          </Button>
        </div>
      )}
      {unmatchId && <UnmatchDialog matchId={unmatchId} onClose={() => setUnmatchId(null)} />}
    </Card>
  );
}

function UnmatchDialog({ matchId, onClose }: { matchId: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const unmatch = useAction('recs.unmatch', { success: 'Match undone.', onSuccess: onClose });
  return (
    <Dialog
      title="Undo this match"
      description="The lines return to the open list. The original match stays in the audit log."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<Link2Off size={16} aria-hidden />} disabled={reason.trim().length < 3} busy={unmatch.isPending} onClick={() => unmatch.mutate({ matchId, reason })}>
            Undo match
          </Button>
        </>
      }
    >
      <Field label="Reason" htmlFor="um-reason">
        <input id="um-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} data-autofocus />
      </Field>
    </Dialog>
  );
}

function Workbench({ id }: { id: string }) {
  const { can } = useSession();
  const q = useApi('recs.get', { id });
  const certify = useAction('recs.certify', { success: 'Certified. A reviewer can now sign off.' });
  const [review, setReview] = useState<null | boolean>(null);
  const [adding, setAdding] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const openItems = useMemo(() => q.data?.items.filter((i) => i.status === 'open') ?? [], [q.data]);

  return (
    <div className="page">
      <div>
        <LinkButton href="#/recs" variant="quiet" size="s" icon={<ArrowLeft size={14} aria-hidden />}>
          All reconciliations
        </LinkButton>
      </div>
      <Query q={q} rows={10}>
        {(d) => {
          const s = d.summary;
          const cur = s.currency;
          const editable = can('rec.prepare') && s.status !== 'prepared' && s.status !== 'reviewed';
          return (
            <>
              <PageHead
                eyebrow={
                  <>
                    <Term id={REC_TERM[s.recType] ?? 'ek:Reconciliation'}>{s.recType.replace(/_/g, ' ')} reconciliation</Term> · {s.entityCode} · {period(s.periodKey)}
                  </>
                }
                title={s.title}
                sub={`${s.accountCode} ${s.accountName} compared with ${s.comparisonLabel.toLowerCase()}.`}
                actions={
                  <>
                    {s.status !== 'prepared' && s.status !== 'reviewed' && (
                      <Button variant="primary" icon={<BadgeCheck size={16} aria-hidden />} disabled={!d.canCertify.ok} busy={certify.isPending} onClick={() => certify.mutate({ id: s.id })} title={d.canCertify.reasons.join(' ')} data-testid="certify">
                        Certify as preparer
                      </Button>
                    )}
                    {s.status === 'prepared' && (
                      <>
                        <Button variant="good" icon={<CheckCircle2 size={16} aria-hidden />} disabled={!d.canReview.ok} onClick={() => setReview(true)} title={d.canReview.reasons.join(' ')} data-testid="review-signoff">
                          Sign off as reviewer
                        </Button>
                        <Button icon={<RotateCcw size={16} aria-hidden />} disabled={!d.canReview.ok} onClick={() => setReview(false)}>
                          Return
                        </Button>
                      </>
                    )}
                  </>
                }
              />
              {s.status !== 'prepared' && s.status !== 'reviewed' && !d.canCertify.ok && (
                <Notice tone="warn" title="Not ready to certify">
                  {d.canCertify.reasons.join(' ')}
                </Notice>
              )}
              {s.status === 'prepared' && !d.canReview.ok && <Notice tone="info">{d.canReview.reasons.join(' ')}</Notice>}
              {s.status === 'reviewed' && (
                <Notice tone="good" title="Signed off">
                  Certified by {s.preparedBy?.name ?? '—'} and reviewed by {s.reviewedBy?.name ?? '—'}. The numbers are frozen.
                </Notice>
              )}

              <div className="grid grid-4">
                <div className="card stat">
                  <span className="label">Ledger balance</span>
                  <span className="value">
                    <Money cents={s.glBalance} currency={cur} />
                  </span>
                  <span className="small muted">
                    {s.accountCode} at the end of {period(s.periodKey)}
                  </span>
                </div>
                <div className="card stat">
                  <span className="label">{s.comparisonLabel}</span>
                  <span className="value">
                    <Money cents={s.comparisonBalance} currency={cur} />
                  </span>
                  <span className="small muted">{d.statement ? `Opening ${money(d.statement.opening, cur)}` : 'independent source'}</span>
                </div>
                <div className="card stat">
                  <span className="label">Explained by items</span>
                  <span className="value">
                    <Money cents={s.explained} currency={cur} />
                  </span>
                  <span className="small muted">of a {money(s.difference, cur)} difference</span>
                </div>
                <div className="card stat" data-testid="unexplained">
                  <span className="label">
                    <Term id="ek:UnexplainedDifference">Unexplained</Term>
                  </span>
                  <span className={`value ${s.unexplained === 0 ? 'diff-ok' : 'diff-bad'}`}>
                    <Money cents={s.unexplained} currency={cur} />
                  </span>
                  <span className="small muted">tolerance {money(s.tolerance, cur)}</span>
                </div>
              </div>

              <Card
                title="Reconciling items"
                hint={`${plural(openItems.length, 'open item')}. Book side adds, comparison side subtracts.`}
                actions={
                  editable ? (
                    <Button size="s" icon={<Plus size={14} aria-hidden />} onClick={() => setAdding(true)}>
                      Add item
                    </Button>
                  ) : null
                }
                flush
              >
                {d.items.length ? (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th className="first" scope="col">
                            Item
                          </th>
                          <th scope="col">Side</th>
                          <th scope="col">Dates</th>
                          <th scope="col" className="num">
                            Amount
                          </th>
                          <th scope="col">Status</th>
                          <th scope="col" className="last">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.items.map((i) => (
                          <tr key={i.id}>
                            <td className="first" style={{ minWidth: 220 }}>
                              <div className="small strong">{i.description}</div>
                              <div className="xs muted">
                                <Term id={ITEM_TERM[i.type] ?? 'ek:ReconcilingItem'}>{i.type.replace(/_/g, ' ')}</Term> · by {i.createdBy}
                                {i.proposalId && (
                                  <>
                                    {' '}
                                    · <a href={href(`/inbox/${i.proposalId}`)}>proposal</a>
                                  </>
                                )}
                              </div>
                            </td>
                            <td className="small">{i.side === 'bank' ? 'Comparison' : 'Books'}</td>
                            <td className="small nowrap">
                              {date(i.originDate, 'short')}
                              {i.expectedClearDate ? ` → ${date(i.expectedClearDate, 'short')}` : ''}
                              {(i.clearedBy as unknown[]).length > 0 && <div className="xs muted">cleared next month</div>}
                            </td>
                            <td className="num">
                              <Money cents={i.amount} currency={cur} />
                            </td>
                            <td>
                              <Status value={i.status} />
                            </td>
                            <td className="last">
                              {editable && i.status === 'open' && (
                                <Button size="s" variant="quiet" onClick={() => setResolving(i.id)}>
                                  Resolve
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title="No reconciling items">{s.difference === 0 ? 'The ledger agrees with the comparison.' : 'The difference has not been explained yet.'}</Empty>
                )}
              </Card>

              {s.recType === 'bank' && <BankMatching d={d} />}

              {d.detail && (
                <Card title={d.detail.label} hint="Supporting detail from the subledger or schedule" flush>
                  {d.detail.rows.length ? (
                    <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
                      <table className="table">
                        <tbody>
                          {d.detail.rows.map((r, i) => (
                            <tr key={i}>
                              <td className="first small">{r.ref ? <a href={r.ref.type === 'journal_entry' ? href(`/journals/${r.ref.id}`) : href(`/records/${r.ref.type}/${r.ref.id}`)}>{r.label}</a> : r.label}</td>
                              <td className="num last small">{money(r.amount, cur)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td className="first">Total</td>
                            <td className="num last">{money(d.detail.rows.reduce((x, r) => x + r.amount, 0), cur)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  ) : (
                    <Empty title="Nothing open" />
                  )}
                </Card>
              )}

              <div className="grid grid-2">
                <Card title="Matches" hint="How statement lines were paired with the ledger">
                  {d.matches.length ? (
                    <Kv items={[['Exact', String(d.matches.filter((m) => m.type === 'exact').length)], ['Fuzzy', String(d.matches.filter((m) => m.type === 'fuzzy').length)], ['One-to-many / many-to-one', String(d.matches.filter((m) => m.type === 'one_to_many' || m.type === 'many_to_one').length)], ['Manual', String(d.matches.filter((m) => m.type === 'manual').length)], ['By agents', String(d.matches.filter((m) => m.createdBy === 'agent').length)]]} />
                  ) : (
                    <p className="small muted">{s.recType === 'bank' ? 'No matches yet.' : 'This reconciliation compares balances, not individual lines.'}</p>
                  )}
                </Card>
                <Card title="Sign-offs">
                  {d.signoffs.length ? (
                    <ul className="stack small" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 8 }}>
                      {d.signoffs.map((so, i) => (
                        <li key={i} className="row" style={{ alignItems: 'flex-start' }}>
                          <BadgeCheck size={16} color="var(--good)" aria-hidden />
                          <span>
                            <strong>{so.role === 'preparer' ? 'Certified' : so.role === 'reviewer' ? 'Reviewed' : so.role}</strong> by <Person name={so.user?.name} /> <span className="muted">· {when(so.signedAt)}</span>
                            {so.statement && <div className="xs ink2">“{so.statement}”</div>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="small muted">Not certified yet.</p>
                  )}
                  {d.statement?.documentId && (
                    <div style={{ marginTop: 12 }}>
                      <LinkButton href={href(`/documents/${d.statement.documentId}`)} size="s" icon={<FileText size={14} aria-hidden />}>
                        Open the statement file
                      </LinkButton>
                    </div>
                  )}
                </Card>
              </div>
              {review !== null && <ReviewDialog id={s.id} approve={review} onClose={() => setReview(null)} />}
              {adding && <AddItemDialog d={d} onClose={() => setAdding(false)} />}
              {resolving && <ResolveDialog itemId={resolving} onClose={() => setResolving(null)} />}
            </>
          );
        }}
      </Query>
    </div>
  );
}

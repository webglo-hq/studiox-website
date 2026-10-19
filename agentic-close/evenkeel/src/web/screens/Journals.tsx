import { ArrowLeft, Bot, Check, CircleCheck, CircleX, FileText, Plus, Trash2, Undo2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAction, useApi } from '../lib/api';
import { actionLabel, date, humanize, money, period, plural, when } from '../lib/format';
import { href, navigate, setQuery, type Route } from '../lib/router';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Dialog, Empty, Field, Kv, LinkButton, Money, Notice, PageHead, Query, Status } from '../ui/kit';
import { Term } from '../ui/term';

export function Journals({ route, openId }: { route: Route; openId: string | null }) {
  if (openId === 'new') return <NewEntry />;
  if (openId) return <EntryDetail id={openId} />;
  return <EntryList route={route} />;
}

function EntryList({ route }: { route: Route }) {
  const { can } = useSession();
  const entityCode = (route.query.get('entity') as 'US' | 'UK' | 'CONSOL' | null) ?? undefined;
  const status = (route.query.get('status') as 'draft' | 'pending_approval' | 'posted' | 'rejected' | null) ?? undefined;
  const source = (route.query.get('source') as 'manual' | 'agent' | 'import' | 'system' | 'subledger' | null) ?? undefined;
  const allPeriods = route.query.get('all') === '1';
  const [q, setQ] = useState(route.query.get('q') ?? '');
  const [page, setPage] = useState(0);
  const act = useApi('close.activity', {});
  const list = useApi('journals.list', { periodKey: allPeriods ? undefined : act.data?.periodKey, entityCode, status, source, q: q || undefined, limit: 50, offset: page * 50 }, { keepPrevious: true, enabled: allPeriods || !!act.data });

  return (
    <div className="page">
      <PageHead
        eyebrow="Ledger"
        title="Journal entries"
        sub={
          <>
            Every <Term id="ek:JournalEntry">journal entry</Term> balances (debits equal credits) and, once posted, can only be undone by a <Term id="ek:ReversingEntry">reversal</Term>. Open one to see its lines, its source document and its full history.
          </>
        }
        actions={
          can('je.create') ? (
            <LinkButton href="#/journals/new" variant="primary" icon={<Plus size={16} aria-hidden />}>
              New entry
            </LinkButton>
          ) : null
        }
      />
      <div className="row-wrap">
        <select className="select" style={{ width: 'auto', minHeight: 34 }} aria-label="Entity" value={entityCode ?? ''} onChange={(e) => setQuery(route, 'entity', e.target.value || null)}>
          <option value="">All entities</option>
          <option value="US">Kitewell US</option>
          <option value="UK">Kitewell UK</option>
          <option value="CONSOL">Consolidation</option>
        </select>
        <select className="select" style={{ width: 'auto', minHeight: 34 }} aria-label="Status" value={status ?? ''} onChange={(e) => setQuery(route, 'status', e.target.value || null)}>
          <option value="">Any status</option>
          <option value="posted">Posted</option>
          <option value="pending_approval">Waiting for approval</option>
          <option value="draft">Draft</option>
          <option value="rejected">Rejected</option>
        </select>
        <select className="select" style={{ width: 'auto', minHeight: 34 }} aria-label="Source" value={source ?? ''} onChange={(e) => setQuery(route, 'source', e.target.value || null)}>
          <option value="">Any source</option>
          <option value="agent">Agents</option>
          <option value="manual">Manual</option>
          <option value="import">Imported</option>
          <option value="subledger">Subledgers</option>
          <option value="system">System</option>
        </select>
        <label className="check small">
          <input type="checkbox" checked={allPeriods} onChange={(e) => setQuery(route, 'all', e.target.checked ? '1' : null)} /> All periods
        </label>
        <input className="input" type="search" style={{ maxWidth: 260, minHeight: 34 }} placeholder="Memo or entry number" aria-label="Search entries" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} />
      </div>
      <Card flush>
        <Query q={list} rows={10} empty={(d) => (d.items.length ? null : <Empty icon={<FileText size={22} />} title="No entries match" />)}>
          {(d) => (
            <>
              <div className="table-wrap">
                <table className="table" data-testid="je-table">
                  <thead>
                    <tr>
                      <th className="first" scope="col">
                        Entry
                      </th>
                      <th scope="col">Date</th>
                      <th scope="col">Type</th>
                      <th scope="col" className="num">
                        Amount
                      </th>
                      <th scope="col">Prepared → approved</th>
                      <th scope="col" className="last">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((e) => (
                      <tr key={e.id} className="clickable" onClick={() => navigate(href(`/journals/${e.id}`))}>
                        <td className="first" style={{ minWidth: 260 }}>
                          <a href={href(`/journals/${e.id}`)} className="mono small strong" onClick={(ev) => ev.stopPropagation()}>
                            {e.entryNumber}
                          </a>
                          <div className="small">{e.memo}</div>
                          <div className="xs muted">
                            {e.entityCode} · {humanize(e.source)}
                            {e.reverses ? ` · reverses ${e.reverses}` : ''}
                            {e.reversedBy ? ` · reversed by ${e.reversedBy}` : ''}
                          </div>
                        </td>
                        <td className="small nowrap">{date(e.date, 'short')}</td>
                        <td className="small">{humanize(e.type)}</td>
                        <td className="num">
                          <Money cents={e.total} currency={e.currency} />
                        </td>
                        <td className="xs" style={{ minWidth: 160 }}>
                          {e.preparedBy ?? '—'} → {e.approvedBy ?? '—'}
                        </td>
                        <td className="last">
                          <Status value={e.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-foot">
                <span className="small muted">
                  {d.total.toLocaleString()} entries{allPeriods ? '' : ` in ${period(act.data?.periodKey)}`} · showing {page * 50 + 1}–{Math.min(d.total, page * 50 + d.items.length)}
                </span>
                <span className="grow" />
                <Button size="s" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="s" disabled={(page + 1) * 50 >= d.total} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </>
          )}
        </Query>
      </Card>
    </div>
  );
}

function ReasonDialog({ title, description, action, onClose, onSubmit, busy, min = 3 }: { title: string; description: string; action: string; onClose: () => void; onSubmit: (reason: string) => void; busy: boolean; min?: number }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={reason.trim().length < min} busy={busy} onClick={() => onSubmit(reason)}>
            {action}
          </Button>
        </>
      }
    >
      <Field label={`Reason (at least ${min} characters)`} htmlFor="reason">
        <textarea id="reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-autofocus />
      </Field>
    </Dialog>
  );
}

function EntryDetail({ id }: { id: string }) {
  const q = useApi('journals.get', { id });
  const approve = useAction('journals.approve', { success: 'Approved and posted.' });
  const [rejecting, setRejecting] = useState(false);
  const [reversing, setReversing] = useState(false);
  const reject = useAction('journals.reject', { success: 'Entry rejected.', onSuccess: () => setRejecting(false) });
  const reverse = useAction('journals.reverse', {
    success: (o) => `Reversal ${o.entryNumber} posted in ${period(o.periodKey)}.`,
    onSuccess: (o) => {
      setReversing(false);
      navigate(href(`/journals/${o.id}`));
    },
  });
  return (
    <div className="page">
      <div>
        <LinkButton href="#/journals" variant="quiet" size="s" icon={<ArrowLeft size={14} aria-hidden />}>
          All entries
        </LinkButton>
      </div>
      <Query q={q} rows={10}>
        {(d) => {
          const e = d.entry;
          return (
            <>
              <PageHead
                eyebrow={
                  <>
                    {e.entityName} · {period(e.periodKey)} · {humanize(e.type)}
                  </>
                }
                title={<span className="mono">{e.entryNumber}</span>}
                sub={e.memo}
                actions={
                  <>
                    {d.can.approve && (
                      <Button variant="good" icon={<Check size={16} aria-hidden />} busy={approve.isPending} onClick={() => approve.mutate({ id: e.id })}>
                        Approve and post
                      </Button>
                    )}
                    {d.can.reject && (
                      <Button variant="danger" icon={<X size={16} aria-hidden />} onClick={() => setRejecting(true)}>
                        Reject…
                      </Button>
                    )}
                    {d.can.reverse && (
                      <Button icon={<Undo2 size={16} aria-hidden />} onClick={() => setReversing(true)} data-testid="reverse-entry">
                        Reverse…
                      </Button>
                    )}
                  </>
                }
              />
              <div className="row-wrap">
                <Status value={e.status} />
                {e.preparedByAgent && (
                  <Badge tone="info">
                    <Bot size={12} aria-hidden /> prepared by the {e.preparedByAgent} agent
                  </Badge>
                )}
                {d.reverses && (
                  <a className="badge t-outline" href={href(`/journals/${d.reverses.id}`)}>
                    Reverses {d.reverses.entryNumber}
                  </a>
                )}
                {d.reversedBy && (
                  <a className="badge t-warn" href={href(`/journals/${d.reversedBy.id}`)}>
                    Reversed by {d.reversedBy.entryNumber}
                  </a>
                )}
              </div>
              {e.status === 'pending_approval' && !d.can.approve && <Notice tone="info">Waiting for someone other than the preparer to approve (maker-checker).</Notice>}
              <Card title="Lines" hint={`${plural(d.lines.length, 'line')} · ${e.currency}`} flush>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="first" scope="col">
                          Account
                        </th>
                        <th scope="col">Memo</th>
                        <th scope="col">Source</th>
                        <th scope="col" className="num">
                          Debit
                        </th>
                        <th scope="col" className="num last">
                          Credit
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.lines.map((l) => (
                        <tr key={l.lineNo}>
                          <td className="first" style={{ minWidth: 200 }}>
                            <a href={href(`/reports/account/${l.account.id}`, { scope: e.entityCode, p: e.periodKey })}>
                              {l.account.code} {l.account.name}
                            </a>
                            {(l.department || l.counterparty) && <div className="xs muted">{[l.department, l.counterparty ? `counterparty ${l.counterparty}` : null].filter(Boolean).join(' · ')}</div>}
                            {l.txnCurrency && l.txnCurrency !== e.currency && (
                              <div className="xs muted">
                                {money(l.txnAmount ?? 0, l.txnCurrency)} at {l.fxRate}
                              </div>
                            )}
                          </td>
                          <td className="small ink2">{l.memo}</td>
                          <td className="small">{l.source ? <a href={href(`/records/${l.source.type}/${l.source.id}`)}>{l.source.label}</a> : <span className="muted">—</span>}</td>
                          <td className="num">{l.debit ? money(l.debit, e.currency) : ''}</td>
                          <td className="num last">{l.credit ? money(l.credit, e.currency) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td className="first" colSpan={3}>
                          Total — balanced
                        </td>
                        <td className="num">{money(d.lines.reduce((s, l) => s + l.debit, 0), e.currency)}</td>
                        <td className="num last">{money(d.lines.reduce((s, l) => s + l.credit, 0), e.currency)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Card>
              <div className="grid grid-2">
                <Card title="Provenance">
                  <Kv
                    items={[
                      ['Entry date', date(e.date)],
                      ['Source', humanize(e.source)],
                      ['Prepared by', e.preparedBy ?? (e.preparedByAgent ? `${e.preparedByAgent} agent` : (e.externalPreparer ?? '—'))],
                      ...(e.requestedBy ? ([['On behalf of', e.requestedBy]] as [string, string][]) : []),
                      ['Approved by', e.approvedBy ?? e.externalApprover ?? '—'],
                      ['Approval basis', e.approvalPolicy ?? '—'],
                      ['Posted', e.postedAt ? `${when(e.postedAt)}${e.postedBy ? ` by ${e.postedBy}` : ''}` : e.externalPostedAt ? `${when(e.externalPostedAt)} (in the legacy system)` : '—'],
                      ...(e.autoReverseDate ? ([['Reverses automatically', date(e.autoReverseDate)]] as [string, string][]) : []),
                    ]}
                  />
                  <div className="row-wrap" style={{ marginTop: 12 }}>
                    {d.document && (
                      <LinkButton href={href(`/documents/${d.document.id}`)} size="s" icon={<FileText size={14} aria-hidden />}>
                        {d.document.filename}
                      </LinkButton>
                    )}
                    {d.proposal && (
                      <LinkButton href={href(`/inbox/${d.proposal.id}`)} size="s" icon={<Bot size={14} aria-hidden />}>
                        Agent proposal
                      </LinkButton>
                    )}
                  </div>
                  {d.proposal && <p className="small ink2" style={{ marginTop: 10 }}>{d.proposal.why}</p>}
                </Card>
                <Card title="History" hint={<Term id="ek:AuditTrail">Audit trail</Term>}>
                  {d.audit.length ? (
                    <ol className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
                      {d.audit.map((a) => (
                        <li key={a.seq}>
                          <strong>{actionLabel(a.action)}</strong> <span className="muted">by {a.actor ?? a.actorType} · {when(a.at)}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="small muted">Loaded with the opening history.</p>
                  )}
                </Card>
              </div>
              {rejecting && <ReasonDialog title="Reject this entry" description="Rejected entries are never posted. The reason is recorded." action="Reject" busy={reject.isPending} onClose={() => setRejecting(false)} onSubmit={(reason) => reject.mutate({ id: e.id, reason })} />}
              {reversing && <ReasonDialog title="Reverse this entry" description="Posts an equal and opposite entry (in this period if it is open, otherwise the next open one). The original stays unchanged and linked." action="Post reversal" min={5} busy={reverse.isPending} onClose={() => setReversing(false)} onSubmit={(reason) => reverse.mutate({ id: e.id, reason })} />}
            </>
          );
        }}
      </Query>
    </div>
  );
}

interface LineInput {
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
  departmentId: string;
}

const toCents = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

function NewEntry() {
  const ref = useApi('journals.reference', {});
  const act = useApi('close.activity', {});
  const [entityId, setEntityId] = useState('');
  const [entryDate, setEntryDate] = useState('2026-09-30');
  const [memo, setMemo] = useState('');
  const [entryType, setEntryType] = useState<'standard' | 'adjusting' | 'accrual' | 'reclass'>('adjusting');
  const [lines, setLines] = useState<LineInput[]>([
    { accountId: '', debit: '', credit: '', memo: '', departmentId: '' },
    { accountId: '', debit: '', credit: '', memo: '', departmentId: '' },
  ]);
  const ents = ref.data?.entities.filter((e) => !e.elimination) ?? [];
  const entity = ents.find((e) => e.id === entityId) ?? ents[0];
  const periodKey = act.data?.periodKey ?? entryDate.slice(0, 7);
  const draft = useMemo(
    () =>
      entity
        ? {
            entityId: entity.id,
            entryDate,
            periodKey: entryDate.slice(0, 7),
            entryType,
            memo,
            currency: entity.currency,
            lines: lines
              .filter((l) => l.accountId)
              .map((l) => ({ accountId: l.accountId, debit: toCents(l.debit || '0'), credit: toCents(l.credit || '0'), memo: l.memo || undefined, departmentId: l.departmentId || null })),
          }
        : null,
    [entity, entryDate, entryType, memo, lines],
  );
  const totals = (draft?.lines ?? []).reduce((t, l) => ({ d: t.d + (Number.isFinite(l.debit) ? l.debit : 0), c: t.c + (Number.isFinite(l.credit) ? l.credit : 0) }), { d: 0, c: 0 });
  const ready = !!draft && draft.lines.length >= 2 && memo.trim().length >= 3 && totals.d === totals.c && totals.d > 0 && draft.lines.every((l) => Number.isFinite(l.debit) && Number.isFinite(l.credit));
  const preview = useApi('journals.preview', { draft: draft! }, { enabled: ready });
  const create = useAction('journals.create', { success: (o) => `${o.entryNumber} ${o.status === 'pending_approval' ? 'sent for approval' : 'saved as draft'}.`, onSuccess: (o) => navigate(href(`/journals/${o.id}`)) });
  const set = (i: number, patch: Partial<LineInput>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="page">
      <div>
        <LinkButton href="#/journals" variant="quiet" size="s" icon={<ArrowLeft size={14} aria-hidden />}>
          All entries
        </LinkButton>
      </div>
      <PageHead eyebrow="Manual entry" title="New journal entry" sub="Prepare an entry; someone else approves it before it posts. Evenkeel checks it against the ontology's double-entry and period rules as you type." />
      <Query q={ref} rows={6}>
        {(r) => (
          <>
            <Card title="Header">
              <div className="grid grid-4">
                <Field label="Entity" htmlFor="je-entity">
                  <select id="je-entity" className="select" value={entity?.id ?? ''} onChange={(e) => setEntityId(e.target.value)}>
                    {ents.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} ({e.currency})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Date" htmlFor="je-date" help={`Open period: ${period(periodKey)}`}>
                  <input id="je-date" className="input" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
                </Field>
                <Field label="Type" htmlFor="je-type">
                  <select id="je-type" className="select" value={entryType} onChange={(e) => setEntryType(e.target.value as typeof entryType)}>
                    <option value="adjusting">Adjusting</option>
                    <option value="standard">Standard</option>
                    <option value="accrual">Accrual</option>
                    <option value="reclass">Reclassification</option>
                  </select>
                </Field>
                <Field label="Memo" htmlFor="je-memo">
                  <input id="je-memo" className="input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} />
                </Field>
              </div>
            </Card>
            <Card title="Lines" hint="Debits must equal credits" flush footer={<span className={`small strong ${totals.d === totals.c ? 'diff-ok' : 'diff-bad'}`}>Debits {money(totals.d, entity?.currency)} · Credits {money(totals.c, entity?.currency)}{totals.d !== totals.c ? ` · off by ${money(totals.d - totals.c, entity?.currency)}` : ' · balanced'}</span>}>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="first" scope="col">
                        Account
                      </th>
                      <th scope="col">Department</th>
                      <th scope="col">Memo</th>
                      <th scope="col" className="num">
                        Debit
                      </th>
                      <th scope="col" className="num">
                        Credit
                      </th>
                      <th scope="col" className="last">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i}>
                        <td className="first" style={{ minWidth: 220 }}>
                          <select className="select" aria-label={`Account, line ${i + 1}`} value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })}>
                            <option value="">Choose an account</option>
                            {r.accounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.code} {a.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{ minWidth: 150 }}>
                          <select className="select" aria-label={`Department, line ${i + 1}`} value={l.departmentId} onChange={(e) => set(i, { departmentId: e.target.value })}>
                            <option value="">—</option>
                            {r.departments.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{ minWidth: 160 }}>
                          <input className="input" aria-label={`Memo, line ${i + 1}`} value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} />
                        </td>
                        <td style={{ minWidth: 110 }}>
                          <input className="input num" inputMode="decimal" aria-label={`Debit, line ${i + 1}`} value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} />
                        </td>
                        <td style={{ minWidth: 110 }}>
                          <input className="input num" inputMode="decimal" aria-label={`Credit, line ${i + 1}`} value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} />
                        </td>
                        <td className="last">
                          <Button size="s" variant="quiet" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} icon={<Trash2 size={14} aria-hidden />} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: '10px 20px' }}>
                <Button size="s" icon={<Plus size={14} aria-hidden />} onClick={() => setLines((ls) => [...ls, { accountId: '', debit: '', credit: '', memo: '', departmentId: '' }])}>
                  Add line
                </Button>
              </div>
            </Card>
            <Card title="Ontology checks" hint="Axioms evaluated against the draft">
              {!ready ? (
                <p className="small muted">Fill in a memo and at least two balanced lines to run the checks.</p>
              ) : preview.data ? (
                <div className="stack small">
                  <span className="row">
                    {preview.data.ok ? <CircleCheck size={16} color="var(--good)" aria-hidden /> : <CircleX size={16} color="var(--bad)" aria-hidden />}
                    {preview.data.ok ? `Passes ${plural(preview.data.checked.length, 'rule')}.` : 'Fix these before submitting:'}
                  </span>
                  {preview.data.violations.map((v, i) => (
                    <span key={i} className={v.severity === 'error' ? 'diff-bad' : 'ink2'}>
                      <Term id={v.axiomId}>{v.axiomId}</Term> {v.message}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="small muted">Checking…</p>
              )}
            </Card>
            <div className="row-wrap">
              <Button variant="primary" disabled={!ready || !preview.data?.ok} busy={create.isPending} onClick={() => draft && create.mutate({ draft, submit: true })}>
                Submit for approval
              </Button>
              <Button disabled={!ready} busy={create.isPending} onClick={() => draft && create.mutate({ draft, submit: false })}>
                Save draft
              </Button>
            </div>
          </>
        )}
      </Query>
    </div>
  );
}

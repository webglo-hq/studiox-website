import { BookOpen, Bot, Check, ChevronLeft, ChevronRight, FileText, Plus, RotateCcw, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api, qs } from '../lib/api';
import { date, label, money } from '../lib/format';
import { navigate, useAction, useApi, useCan } from '../lib/hooks';
import { nextPeriodStart, parseAmount, periodEnd, periodLabel, periodOptions, type Reference, useReference } from '../lib/reference';
import { Badge, Drawer, Empty, ErrorBox, ReasonDialog, Skeleton, StatusBadge, Term } from '../components/ui';

interface EntryRow {
  id: string;
  number: string;
  entity: string;
  date: string;
  type: string;
  status: string;
  source: string;
  module: string;
  description: string;
  total: number;
  currency: string;
  basis: string | null;
  preparedBy: string | null;
  approvedBy: string | null;
  reversesEntryId: string | null;
}

interface EntryDetail {
  entry: {
    id: string;
    number: string;
    entity: string;
    period: string;
    date: string;
    type: string;
    typeLabel: string;
    status: string;
    description: string;
    source: string;
    module: string;
    currency: string;
    fxRate: number;
    total: number;
    basis: string | null;
    preparedBy: string | null;
    preparedByRunId: string | null;
    externalPreparedBy: string | null;
    externalApprovedBy: string | null;
    externalRef: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
    postedAt: string | null;
    postedByRunId: string | null;
    autoReverseDate: string | null;
    icReference: string | null;
    reversesEntryId: string | null;
    reversedBy: { id: string; number: string } | null;
  };
  lines: Array<{ id: string; line: number; account: string; accountName: string; accountClass: string; debit: number; credit: number; department: string | null; counterparty: string | null; vendor: string | null; memo: string | null; txnCurrency: string | null; txnAmount: number | null }>;
  provenance: { document: { id: string; filename: string; sha256: string; uploadedAt: string } | null; batch: { id: string; format: string; status: string } | null; locator: string | null };
  proposal: { id: string; title: string; status: string } | null;
  checks: Array<{ axiom: string; severity: 'error' | 'warning'; message: string }>;
  canApprove: boolean;
  canReverse: boolean;
}

const BASIS_TEXT: Record<string, string> = {
  human_approval: 'Approved by a person',
  autonomy_policy: 'Auto-applied under the skill autonomy policy',
  reversal_exemption: 'Reversal of a posted entry',
  import: 'Approved in the source system, then imported',
  system: 'System entry',
};

const STATUSES = ['posted', 'pending_approval', 'rejected', 'draft'];
const TYPES = ['standard', 'adjusting', 'accrual', 'reversing', 'recurring', 'reclass', 'elimination', 'revaluation', 'depreciation', 'amortization', 'opening'];
const SOURCES = ['manual', 'agent', 'subledger', 'import', 'system'];
const PAGE = 100;

export function LedgerScreen({ entryId, query }: { entryId: string | null; query: URLSearchParams }) {
  const can = useCan();
  const ref = useReference();
  const queryKey = query.toString();
  const periodParam = query.get('period');
  const period = periodParam ?? ref.data?.period ?? '';
  const filters = {
    entity: query.get('entity') ?? '',
    period: period === 'all' ? '' : period,
    status: query.get('status') ?? '',
    type: query.get('type') ?? '',
    source: query.get('source') ?? '',
    q: query.get('q') ?? '',
    account: query.get('account') ?? '',
  };
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState(filters.q);
  const [creating, setCreating] = useState(query.get('new') === '1');
  useEffect(() => setOffset(0), [queryKey]);
  const listPath = ref.data ? `/api/journal-entries${qs({ ...filters, limit: PAGE, offset })}` : null;
  const { data, error, reload } = useApi<{ total: number; entries: EntryRow[] }>(listPath);
  const setFilter = (key: string, value: string) => {
    const p = new URLSearchParams(query);
    p.delete('new');
    if (value) p.set(key, value);
    else p.delete(key);
    navigate(`/ledger${p.toString() ? `?${p.toString()}` : ''}`);
  };
  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setFilter('q', search.trim());
  };
  const keep = queryKey ? `?${queryKey}` : '';
  const anyFilter = !!(filters.entity || filters.status || filters.type || filters.source || filters.q || filters.account);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Journal entries</h1>
          <div className="sub">
            Every <Term id="bh:JournalEntry">journal entry</Term> with who prepared it, who approved it and where it came from. Posted entries never change: to undo one, reverse it.
          </div>
        </div>
        {can('je.prepare') && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden="true" /> New journal entry
          </button>
        )}
      </div>
      <section className="card card-pad filters" aria-label="Filters">
        <form className="filter-grid" onSubmit={onSearch}>
          <div className="field">
            <label htmlFor="je-q">Search descriptions</label>
            <div className="input-icon">
              <Search size={15} aria-hidden="true" />
              <input id="je-q" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Vendor, memo or reference" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="je-entity">Entity</label>
            <select id="je-entity" className="select" value={filters.entity} onChange={(e) => setFilter('entity', e.target.value)}>
              <option value="">All entities</option>
              {ref.data?.entities.map((en) => (
                <option key={en.id} value={en.code}>
                  {en.code} · {en.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="je-period">Period</label>
            <select id="je-period" className="select" value={period || 'all'} onChange={(e) => setFilter('period', e.target.value)}>
              <option value="all">All periods</option>
              {periodOptions(ref.data?.period ?? null).map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="je-status">Status</label>
            <select id="je-status" className="select" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="je-type">Type</label>
            <select id="je-type" className="select" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
              <option value="">Any type</option>
              {TYPES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="je-source">Source</label>
            <select id="je-source" className="select" value={filters.source} onChange={(e) => setFilter('source', e.target.value)}>
              <option value="">Any source</option>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="je-account">Account</label>
            <select id="je-account" className="select" value={filters.account} onChange={(e) => setFilter('account', e.target.value)}>
              <option value="">Any account</option>
              {ref.data?.accounts.map((a) => (
                <option key={a.number} value={a.number}>
                  {a.number} {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field filter-actions">
            <button type="submit" className="btn">
              <Search size={15} aria-hidden="true" /> Search
            </button>
            {anyFilter && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setSearch('');
                  navigate(periodParam ? `/ledger?period=${periodParam}` : '/ledger');
                }}
              >
                <X size={15} aria-hidden="true" /> Clear
              </button>
            )}
          </div>
        </form>
      </section>
      {(error || ref.error) && <ErrorBox error={error ?? ref.error} onRetry={error ? reload : ref.reload} />}
      {!data && !error && <Skeleton rows={10} />}
      {data && (
        <section className="card" aria-label="Journal entries">
          <div className="card-head">
            <h2>
              {data.total.toLocaleString('en-US')} {data.total === 1 ? 'entry' : 'entries'}
              {filters.period ? ` in ${periodLabel(filters.period)}` : ''}
            </h2>
            {data.total > PAGE && (
              <div className="row small">
                <span className="muted">
                  {offset + 1}–{Math.min(offset + PAGE, data.total)}
                </span>
                <button type="button" className="btn btn-sm btn-ghost btn-icon" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label="Previous page">
                  <ChevronLeft size={16} />
                </button>
                <button type="button" className="btn btn-sm btn-ghost btn-icon" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)} aria-label="Next page">
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>
          {data.entries.length === 0 ? (
            <Empty title="No journal entries match" icon={<BookOpen size={26} aria-hidden="true" />}>
              Try another period or clear the filters.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                    <th className="hide-sm">Prepared / approved</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.id} className={`clickable${e.id === entryId ? ' selected' : ''}`} onClick={() => navigate(`/ledger/${e.id}${keep}`)}>
                      <td>
                        <a href={`#/ledger/${e.id}${keep}`} onClick={(ev) => ev.stopPropagation()} className="mono">
                          {e.number}
                        </a>
                        <div className="tiny muted">{e.entity}</div>
                      </td>
                      <td className="nowrap">{date(e.date)}</td>
                      <td>
                        <div className="clamp-2">{e.description}</div>
                        <div className="row-wrap" style={{ marginTop: 3 }}>
                          <Badge>{label(e.type)}</Badge>
                          <span className="tiny muted">
                            {label(e.source)} · {e.module.toUpperCase()}
                          </span>
                          {e.reversesEntryId && <Badge tone="violet">Reversal</Badge>}
                        </div>
                      </td>
                      <td className="num">{money(e.total, e.currency)}</td>
                      <td>
                        <StatusBadge status={e.status} />
                      </td>
                      <td className="hide-sm small">
                        <div>{e.preparedBy ?? '—'}</div>
                        <div className="muted">{e.approvedBy ?? (e.basis ? label(e.basis) : '—')}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {entryId && <EntryDrawer id={entryId} onClose={() => navigate(`/ledger${keep}`)} />}
      {creating && ref.data && (
        <NewEntryDrawer
          reference={ref.data}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/ledger/${id}${keep}`);
          }}
        />
      )}
    </div>
  );
}

function EntryDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error, reload } = useApi<EntryDetail>(`/api/journal-entries/${id}`);
  const { run, busy } = useAction();
  const [dialog, setDialog] = useState<'reject' | 'reverse' | null>(null);
  const e = data?.entry;
  const totals = useMemo(() => (data ? data.lines.reduce((t, l) => ({ d: t.d + l.debit, c: t.c + l.credit }), { d: 0, c: 0 }) : null), [data]);
  const errors = data?.checks.filter((c) => c.severity === 'error') ?? [];
  const footer =
    data && (data.canApprove || data.canReverse) ? (
      <>
        {data.canApprove && (
          <button type="button" className="btn btn-primary" disabled={busy || errors.length > 0} onClick={() => void run(() => api.post(`/api/journal-entries/${id}/approve`), 'Approved and posted.')}>
            <Check size={15} aria-hidden="true" /> Approve and post
          </button>
        )}
        {data.canApprove && (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setDialog('reject')}>
            <X size={15} aria-hidden="true" /> Reject
          </button>
        )}
        {data.canReverse && (
          <button type="button" className="btn" disabled={busy} onClick={() => setDialog('reverse')}>
            <RotateCcw size={15} aria-hidden="true" /> Reverse (undo)
          </button>
        )}
      </>
    ) : undefined;
  return (
    <Drawer
      title={e ? <span className="mono">{e.number}</span> : 'Journal entry'}
      subtitle={
        e && (
          <span className="row-wrap">
            <StatusBadge status={e.status} />
            <span>
              {e.entity} · {e.period} · {date(e.date, 'long')}
            </span>
          </span>
        )
      }
      onClose={onClose}
      footer={footer}
    >
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Skeleton rows={8} />}
      {data && e && totals && (
        <div className="stack" style={{ gap: 18 }}>
          <div>
            <p style={{ fontSize: 15 }}>{e.description}</p>
            <div className="row-wrap" style={{ marginTop: 8 }}>
              <Badge>
                <Term id={`bh:JE_${e.type}`}>{e.typeLabel}</Term>
              </Badge>
              <Badge>
                {label(e.source)} · {e.module.toUpperCase()}
              </Badge>
              {e.currency !== 'USD' && <Badge tone="info">{e.currency}</Badge>}
              {e.autoReverseDate && <Badge tone="violet">Auto-reverses {date(e.autoReverseDate)}</Badge>}
              {e.icReference && <Badge tone="info">IC {e.icReference}</Badge>}
            </div>
          </div>
          <div className="table-wrap card">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Account</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="muted tiny">{l.line}</td>
                    <td>
                      <Term id={l.accountClass}>
                        <span className="mono">{l.account}</span> {l.accountName}
                      </Term>
                      <div className="tiny muted">
                        {[l.department && `Dept ${l.department}`, l.counterparty && `Counterparty ${l.counterparty}`, l.vendor, l.memo].filter(Boolean).join(' · ')}
                        {l.txnCurrency && l.txnAmount !== null && l.txnCurrency !== e.currency ? ` · ${money(l.txnAmount, l.txnCurrency)}` : ''}
                      </div>
                    </td>
                    <td className="num">{l.debit ? money(l.debit, e.currency) : ''}</td>
                    <td className="num">{l.credit ? money(l.credit, e.currency) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td />
                  <td>{totals.d === totals.c ? 'Balanced' : 'Out of balance'}</td>
                  <td className="num">{money(totals.d, e.currency)}</td>
                  <td className="num">{money(totals.c, e.currency)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <section aria-labelledby="je-checks">
            <h3 id="je-checks" className="section-title">
              <ShieldCheck size={15} aria-hidden="true" /> Ontology checks
            </h3>
            {data.checks.length === 0 ? (
              <div className="callout success small">All applicable <Term id="bh:JournalEntry">journal entry</Term> axioms pass: balanced, postable accounts, required departments, period and dates, intercompany counterparties.</div>
            ) : (
              <ul className="list card small">
                {data.checks.map((c, i) => (
                  <li key={i} className="row">
                    <Badge tone={c.severity === 'error' ? 'danger' : 'attention'}>{c.axiom}</Badge>
                    <span className="grow">{c.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="je-who">
            <h3 id="je-who" className="section-title">
              Who and why
            </h3>
            <dl className="facts">
              <dt>Prepared by</dt>
              <dd>
                {e.preparedBy ?? e.externalPreparedBy ?? (e.preparedByRunId ? 'Agent' : 'System')}
                {e.preparedByRunId && (
                  <>
                    {' '}
                    · <a href={`#/runs/${e.preparedByRunId}`}><Bot size={13} aria-hidden="true" /> agent run trace</a>
                  </>
                )}
              </dd>
              <dt>Approval</dt>
              <dd>
                {e.basis ? BASIS_TEXT[e.basis] ?? label(e.basis) : 'Not approved yet'}
                {e.approvedBy ? ` · ${e.approvedBy}` : e.externalApprovedBy ? ` · ${e.externalApprovedBy}` : ''}
                {e.approvedAt ? ` · ${date(e.approvedAt, 'time')}` : ''}
              </dd>
              {e.postedAt && (
                <>
                  <dt>Posted</dt>
                  <dd>{date(e.postedAt, 'time')}</dd>
                </>
              )}
              {data.proposal && (
                <>
                  <dt>Agent proposal</dt>
                  <dd>
                    <a href={`#/inbox/${data.proposal.id}?view=all`}>{data.proposal.title}</a> <StatusBadge status={data.proposal.status} />
                  </dd>
                </>
              )}
              {e.reversesEntryId && (
                <>
                  <dt>Reverses</dt>
                  <dd>
                    <a href={`#/ledger/${e.reversesEntryId}`}>the original entry</a>
                  </dd>
                </>
              )}
              {e.reversedBy && (
                <>
                  <dt>Reversed by</dt>
                  <dd>
                    <a href={`#/ledger/${e.reversedBy.id}`} className="mono">
                      {e.reversedBy.number}
                    </a>
                  </dd>
                </>
              )}
              {e.externalRef && (
                <>
                  <dt>External reference</dt>
                  <dd className="mono">{e.externalRef}</dd>
                </>
              )}
            </dl>
          </section>
          {(data.provenance.document || data.provenance.batch) && (
            <section aria-labelledby="je-prov">
              <h3 id="je-prov" className="section-title">
                <FileText size={15} aria-hidden="true" /> <Term id="bh:SourceDocument">Provenance</Term>
              </h3>
              <dl className="facts">
                {data.provenance.document && (
                  <>
                    <dt>Source file</dt>
                    <dd>
                      {data.provenance.document.filename}
                      <div className="tiny muted mono">sha256 {data.provenance.document.sha256.slice(0, 24)}...</div>
                    </dd>
                  </>
                )}
                {data.provenance.batch && (
                  <>
                    <dt>Import batch</dt>
                    <dd>
                      {data.provenance.batch.format.toUpperCase()} · {label(data.provenance.batch.status)}
                    </dd>
                  </>
                )}
                {data.provenance.locator && (
                  <>
                    <dt>Location in file</dt>
                    <dd className="mono small">{data.provenance.locator}</dd>
                  </>
                )}
              </dl>
            </section>
          )}
        </div>
      )}
      {dialog === 'reject' && (
        <ReasonDialog title="Reject this entry" prompt="Why are you rejecting it? The preparer sees this." confirmLabel="Reject entry" danger onClose={() => setDialog(null)} onSubmit={(reason) => run(() => api.post(`/api/journal-entries/${id}/reject`, { reason }), 'Entry rejected.')} />
      )}
      {dialog === 'reverse' && (
        <ReasonDialog
          title="Reverse this entry"
          prompt="Why are you reversing it? A mirror entry posts in the first open period; the original stays on the books."
          confirmLabel="Post reversal"
          minLength={5}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => run(() => api.post<{ entry_number: string }>(`/api/journal-entries/${id}/reverse`, { reason }), (r) => `Reversal ${r.entry_number} posted.`)}
        />
      )}
    </Drawer>
  );
}

interface LineForm {
  key: number;
  account: string;
  debit: string;
  credit: string;
  department: string;
  memo: string;
}

interface Check {
  axiom: string;
  severity: 'error' | 'warning';
  message: string;
}

function NewEntryDrawer({ reference, onClose, onCreated }: { reference: Reference; onClose: () => void; onCreated: (id: string) => void }) {
  const period = reference.period ?? new Date().toISOString().slice(0, 7);
  const operating = reference.entities.filter((e) => e.kind !== 'elimination');
  const [entity, setEntity] = useState(operating[0]?.code ?? '');
  const [entryDate, setEntryDate] = useState(periodEnd(period));
  const [type, setType] = useState('adjusting');
  const [description, setDescription] = useState('');
  const [autoReverse, setAutoReverse] = useState(false);
  const [lines, setLines] = useState<LineForm[]>([
    { key: 1, account: '', debit: '', credit: '', department: '', memo: '' },
    { key: 2, account: '', debit: '', credit: '', department: '', memo: '' },
  ]);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const { run, busy } = useAction();
  const accounts = useMemo(() => new Map(reference.accounts.map((a) => [a.number, a])), [reference.accounts]);
  const currency = reference.entities.find((e) => e.code === entity)?.currency ?? 'USD';
  const parsed = lines.map((l) => ({ ...l, d: parseAmount(l.debit) ?? 0, c: parseAmount(l.credit) ?? 0, bad: (l.debit !== '' && parseAmount(l.debit) === null) || (l.credit !== '' && parseAmount(l.credit) === null) }));
  const totalD = parsed.reduce((s, l) => s + l.d, 0);
  const totalC = parsed.reduce((s, l) => s + l.c, 0);
  const draft = {
    entity,
    date: entryDate,
    type,
    description: description.trim(),
    autoReverseDate: autoReverse ? nextPeriodStart(entryDate.slice(0, 7)) : null,
    lines: parsed
      .filter((l) => l.account && (l.d || l.c))
      .map((l) => ({ account: l.account, ...(l.d ? { debit: l.d } : {}), ...(l.c ? { credit: l.c } : {}), department: l.department || null, memo: l.memo.trim() || null })),
  };
  const ready = draft.description.length >= 5 && draft.lines.length >= 2 && totalD === totalC && totalD > 0 && !parsed.some((l) => l.bad);
  const update = (key: number, patch: Partial<LineForm>) => {
    setChecks(null);
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const check = () => run(async () => setChecks((await api.post<{ ok: boolean; checks: Check[] }>('/api/journal-entries/preview', draft)).checks));
  const submit = async () => {
    const r = await run(() => api.post<{ entry: { id: string; entry_number: string } }>('/api/journal-entries', draft), (x) => `${x.entry.entry_number} submitted for approval.`);
    if (r) onCreated(r.entry.id);
  };
  return (
    <Drawer
      title="New journal entry"
      subtitle="It goes to an approver with the right limit; you cannot approve your own entry."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" disabled={busy || draft.lines.length < 2} onClick={() => void check()}>
            <ShieldCheck size={15} aria-hidden="true" /> Check
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={() => void submit()}>
            Submit for approval
          </button>
          <span className="grow" />
          <span className={`small ${totalD === totalC ? 'muted' : 'neg'}`}>
            {totalD === totalC ? (totalD ? 'Balanced' : 'Enter amounts') : `Out of balance by ${money(Math.abs(totalD - totalC), currency)}`}
          </span>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="grid grid-2">
          <div className="field">
            <label htmlFor="nje-entity">Entity</label>
            <select id="nje-entity" className="select" value={entity} onChange={(e) => setEntity(e.target.value)}>
              {reference.entities.map((en) => (
                <option key={en.id} value={en.code}>
                  {en.code} · {en.name} ({en.currency})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="nje-date">Date</label>
            <input id="nje-date" type="date" className="input" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="nje-type">Type</label>
            <select id="nje-type" className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {['adjusting', 'accrual', 'reclass', 'standard'].map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="label">Reversal</span>
            <label className="chip-check" style={{ minHeight: 38, alignItems: 'center' }}>
              <input type="checkbox" checked={autoReverse} onChange={(e) => setAutoReverse(e.target.checked)} />
              <span>Auto-reverse on {date(nextPeriodStart(entryDate.slice(0, 7)))} (accruals)</span>
            </label>
          </div>
        </div>
        <div className="field">
          <label htmlFor="nje-desc">Description</label>
          <input id="nje-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What and why, e.g. Accrue September legal fees (Copperline, invoice not yet received)" />
        </div>
        <div className="stack" style={{ gap: 8 }}>
          {lines.map((l, i) => {
            const a = accounts.get(l.account);
            const p = parsed[i]!;
            return (
              <fieldset key={l.key} className="je-line">
                <legend className="sr-only">Line {i + 1}</legend>
                <div className="field je-account">
                  <label htmlFor={`nje-a-${l.key}`}>Account</label>
                  <select id={`nje-a-${l.key}`} className="select" value={l.account} onChange={(e) => update(l.key, { account: e.target.value })}>
                    <option value="">Choose account</option>
                    {reference.accounts.map((acc) => (
                      <option key={acc.number} value={acc.number}>
                        {acc.number} {acc.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`nje-d-${l.key}`}>Debit</label>
                  <input id={`nje-d-${l.key}`} className="input num" inputMode="decimal" value={l.debit} aria-invalid={l.debit !== '' && parseAmount(l.debit) === null} onChange={(e) => update(l.key, { debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) })} />
                </div>
                <div className="field">
                  <label htmlFor={`nje-c-${l.key}`}>Credit</label>
                  <input id={`nje-c-${l.key}`} className="input num" inputMode="decimal" value={l.credit} aria-invalid={l.credit !== '' && parseAmount(l.credit) === null} onChange={(e) => update(l.key, { credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })} />
                </div>
                <div className="field">
                  <label htmlFor={`nje-dep-${l.key}`}>Department{a?.requiresDepartment ? ' (required)' : ''}</label>
                  <select id={`nje-dep-${l.key}`} className="select" value={l.department} onChange={(e) => update(l.key, { department: e.target.value })}>
                    <option value="">None</option>
                    {reference.departments.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.code} · {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field je-memo">
                  <label htmlFor={`nje-m-${l.key}`}>Memo</label>
                  <input id={`nje-m-${l.key}`} className="input" value={l.memo} onChange={(e) => update(l.key, { memo: e.target.value })} />
                </div>
                <button type="button" className="btn btn-ghost btn-icon je-remove" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove line ${i + 1}`}>
                  <Trash2 size={16} />
                </button>
                {a && (
                  <div className="tiny muted je-hint">
                    <Term id={a.subtype}>{label(a.class)}</Term> account · normal {a.normalBalance} balance{p.bad ? ' · enter amounts like 1250.00' : ''}
                  </div>
                )}
              </fieldset>
            );
          })}
          <div>
            <button type="button" className="btn btn-sm" disabled={lines.length >= 40} onClick={() => setLines((ls) => [...ls, { key: Math.max(...ls.map((x) => x.key)) + 1, account: '', debit: '', credit: '', department: '', memo: '' }])}>
              <Plus size={14} aria-hidden="true" /> Add line
            </button>
          </div>
        </div>
        <div className="row-wrap small">
          <span>
            Debits <strong className="num">{money(totalD, currency)}</strong>
          </span>
          <span>
            Credits <strong className="num">{money(totalC, currency)}</strong>
          </span>
        </div>
        {checks && (
          <div role="status">
            {checks.length === 0 ? (
              <div className="callout success small">Every ontology axiom passes. Submit it for approval.</div>
            ) : (
              <ul className="list card small">
                {checks.map((c, i) => (
                  <li key={i} className="row">
                    <Badge tone={c.severity === 'error' ? 'danger' : 'attention'}>{c.axiom}</Badge>
                    <span className="grow">{c.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

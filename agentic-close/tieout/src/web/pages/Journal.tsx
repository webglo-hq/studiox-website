/** Journal entries: explore, drill into lines, approvals and audit trail; prepare and approve manual entries. */
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, qs, type JournalDetail as JD, type JournalList } from '../api';
import { Badge, Dialog, Empty, ErrorBox, Loading, Money, ReasonDialog, Term } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { date, dateTime, titleCase } from '../lib/format';
import { navigate, setQuery, useRoute } from '../lib/router';

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral' | 'info'> = { posted: 'good', pending_approval: 'warn', draft: 'neutral', rejected: 'bad', approved: 'info', void: 'neutral' };

export function Journal() {
  const route = useRoute();
  if (route.path[1]) return <JournalDetail id={route.path[1]} />;
  return <JournalList_ />;
}

function JournalList_() {
  const me = useMe();
  const { period } = useApp();
  const route = useRoute();
  const entity = route.query.get('entity') ?? '';
  const status = route.query.get('status') ?? '';
  const source = route.query.get('source') ?? '';
  const text = route.query.get('q') ?? '';
  const { data, error, loading, reload } = useData(() => api<JournalList>(`/journal${qs({ entity, status, source, q: text, period })}`), [entity, status, source, text, period]);
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Journal entries</h1>
          <p className="lede">
            Every posted entry balances (<Term id="tie:JournalEntry">AX-DE-01</Term>), is immutable once posted and is corrected only by reversal. Agent-prepared entries show the proposal and the person — or the policy —
            that approved them.
          </p>
        </div>
        <div className="actions">
          {can(me, 'je.create') ? (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Plus className="icon" aria-hidden="true" /> New entry
            </button>
          ) : null}
        </div>
      </div>
      <div className="row" style={{ marginBottom: 14 }} role="search">
        <label className="sr-only" htmlFor="j-ent">
          Entity
        </label>
        <select id="j-ent" value={entity} onChange={(e) => setQuery('entity', e.target.value || null)}>
          <option value="">All entities</option>
          {me.entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.code}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="j-status">
          Status
        </label>
        <select id="j-status" value={status} onChange={(e) => setQuery('status', e.target.value || null)}>
          <option value="">Any status</option>
          {['posted', 'pending_approval', 'rejected', 'draft'].map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="j-src">
          Source
        </label>
        <select id="j-src" value={source} onChange={(e) => setQuery('source', e.target.value || null)}>
          <option value="">Any source</option>
          {['agent', 'manual', 'subledger', 'import', 'system'].map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="j-q">
          Search
        </label>
        <input id="j-q" type="search" placeholder="Number, memo or reference" defaultValue={text} onKeyDown={(e) => e.key === 'Enter' && setQuery('q', (e.target as HTMLInputElement).value || null)} />
      </div>
      {error ? <ErrorBox error={error} onRetry={reload} /> : null}
      {!data ? (
        <Loading />
      ) : (
        <section className={`card${loading ? ' skeleton' : ''}`}>
          {data.items.length ? (
            <div className="table-wrap" style={{ maxHeight: '70vh' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Entry</th>
                    <th scope="col">Date</th>
                    <th scope="col">Memo</th>
                    <th scope="col">Source</th>
                    <th scope="col" className="r">
                      Amount
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((j) => (
                    <tr key={j.id} className="clickable" onClick={() => navigate(`journal/${j.id}`)}>
                      <td>
                        <a className="row-link mono" href={`#/journal/${j.id}`}>
                          {j.number}
                        </a>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {titleCase(j.type)}
                        </div>
                      </td>
                      <td className="num">{date(j.date)}</td>
                      <td style={{ maxWidth: 420 }}>{j.memo}</td>
                      <td>
                        {j.source}
                        {j.route ? <div className="muted" style={{ fontSize: 12 }}>via {j.route}</div> : null}
                      </td>
                      <td className="r">
                        <Money minor={j.totalMinor} currency={j.currency} />
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[j.status] ?? 'neutral'}>{titleCase(j.status)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No entries match">Try another filter.</Empty>
          )}
        </section>
      )}
      {creating ? <NewEntry onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function JournalDetail({ id }: { id: string }) {
  const me = useMe();
  const { toast, bump } = useApp();
  const { data, error, reload } = useData(() => api<JD>(`/journal/${id}`), [id]);
  const [reversing, setReversing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  async function act(path: string, body: unknown, label: string) {
    try {
      await api(path, { body });
      toast(label);
      bump();
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'That did not work.', 'bad');
    }
  }
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const e = data.entry;
  const dr = data.lines.reduce((s, l) => s + l.debit_minor, 0);
  const cr = data.lines.reduce((s, l) => s + l.credit_minor, 0);
  return (
    <div>
      <a href="#/journal" className="row" style={{ gap: 6, marginBottom: 10 }}>
        <ArrowLeft className="icon" aria-hidden="true" /> All entries
      </a>
      <div className="page-head">
        <div>
          <h1 className="mono" style={{ fontFamily: 'var(--font-mono)', fontSize: 30 }}>
            {e.je_number}
          </h1>
          <p className="lede">{e.memo}</p>
        </div>
        <div className="actions">
          <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{titleCase(e.status)}</Badge>
          {data.canApprove ? (
            <>
              <button className="btn primary" onClick={() => void act(`/journal/${id}/approve`, {}, `${e.je_number} approved and posted.`)}>
                Approve & post
              </button>
              <button className="btn danger" onClick={() => setRejecting(true)}>
                Reject
              </button>
            </>
          ) : null}
          {e.status === 'posted' && !data.reversal && can(me, 'je.reverse') ? (
            <button className="btn" onClick={() => setReversing(true)}>
              Request reversal
            </button>
          ) : null}
        </div>
      </div>
      <div className="grid main-side">
        <section className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Account</th>
                  <th scope="col">Dimensions</th>
                  <th scope="col" className="r">
                    Debit
                  </th>
                  <th scope="col" className="r">
                    Credit
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="num muted">{l.line_no}</td>
                    <td>
                      <span className="mono">{l.accountCode}</span> {l.accountName}
                      {l.memo ? <div className="muted" style={{ fontSize: 12 }}>{l.memo}</div> : null}
                      {l.txn_currency ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {l.txn_currency} <Money minor={l.txn_amount_minor} currency={l.txn_currency} /> @ {l.fx_rate}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ fontSize: 13 }}>{[l.department, l.location, l.product_class, l.project].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="r">{l.debit_minor ? <Money minor={l.debit_minor} currency={e.currency} /> : ''}</td>
                    <td className="r">{l.credit_minor ? <Money minor={l.credit_minor} currency={e.currency} /> : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>{dr === cr ? 'Balanced' : 'Out of balance'}</td>
                  <td className="r">
                    <Money minor={dr} currency={e.currency} />
                  </td>
                  <td className="r">
                    <Money minor={cr} currency={e.currency} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
        <div className="stack">
          <section className="card card-pad">
            <dl className="kv">
              <dt>Entity</dt>
              <dd>{e.entityCode}</dd>
              <dt>Posting date</dt>
              <dd>{date(e.posting_date, true)}</dd>
              <dt>Type</dt>
              <dd>{titleCase(e.entry_type)}</dd>
              <dt>Source</dt>
              <dd>
                {e.source}
                {e.source_ref ? <span className="muted"> · {e.source_ref}</span> : null}
              </dd>
              <dt>Prepared by</dt>
              <dd>{e.preparedByName}</dd>
              <dt>Approved by</dt>
              <dd>
                {e.approvedByName ?? '—'}
                {e.approval_route ? <span className="muted"> ({e.approval_route})</span> : null}
              </dd>
              <dt>Posted</dt>
              <dd>{e.posted_at ? dateTime(e.posted_at) : '—'}</dd>
              {e.auto_reverse_on ? (
                <>
                  <dt>Reverses on</dt>
                  <dd>{date(e.auto_reverse_on, true)}</dd>
                </>
              ) : null}
              {data.proposal ? (
                <>
                  <dt>From proposal</dt>
                  <dd>
                    <a href={`#/inbox?status=all&open=${data.proposal.id}`}>{data.proposal.ref}</a>
                  </dd>
                </>
              ) : null}
              {data.reversal ? (
                <>
                  <dt>Reversal</dt>
                  <dd>
                    <a href={`#/journal/${data.reversal.id}`}>{data.reversal.number}</a> ({data.reversal.status})
                  </dd>
                </>
              ) : null}
              {data.sourceDocument ? (
                <>
                  <dt>Source file</dt>
                  <dd>
                    <a href={`#/documents/${data.sourceDocument.id}`}>{data.sourceDocument.filename}</a>
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
          <section className="card card-pad">
            <h3 style={{ marginBottom: 6 }}>Audit trail</h3>
            <ul className="checks">
              {data.events.map((ev) => (
                <li key={ev.seq}>
                  <span className="mono muted" style={{ minWidth: 44 }}>
                    #{ev.seq}
                  </span>
                  <span>
                    {ev.summary}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {ev.actor} · {dateTime(ev.at)}
                    </div>
                  </span>
                </li>
              ))}
              {!data.events.length ? <li className="muted">Seeded history (before the audit log of this demo started).</li> : null}
            </ul>
          </section>
        </div>
      </div>
      <ReasonDialog open={reversing} title={`Reverse ${e.je_number}`} label="Why is it being reversed?" confirm="Request reversal" tone="primary" onCancel={() => setReversing(false)} onConfirm={(r) => { setReversing(false); void act(`/journal/${id}/reverse`, { reason: r, postingDate: e.posting_date }, 'Reversal drafted; it needs a second person to approve.'); }} />
      <ReasonDialog open={rejecting} title={`Reject ${e.je_number}`} label="Why are you rejecting it?" confirm="Reject" onCancel={() => setRejecting(false)} onConfirm={(r) => { setRejecting(false); void act(`/journal/${id}/reject`, { reason: r }, 'Entry rejected.'); }} />
    </div>
  );
}

interface LineDraft {
  account: string;
  debit: string;
  credit: string;
  department: string;
  memo: string;
}

function NewEntry({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const { period, toast, bump } = useApp();
  const legal = me.entities.filter((e) => e.kind !== 'elimination');
  const [entityId, setEntity] = useState(legal[0]!.id);
  // amounts are entered, and totalled, in the entity's functional currency
  const currency = legal.find((e) => e.id === entityId)?.currency ?? 'USD';
  const [postingDate, setDate] = useState(`${period}-30`);
  const [memo, setMemo] = useState('');
  const [entryType, setType] = useState<'standard' | 'adjusting' | 'accrual' | 'reclass'>('adjusting');
  const [lines, setLines] = useState<LineDraft[]>([
    { account: '', debit: '', credit: '', department: '', memo: '' },
    { account: '', debit: '', credit: '', department: '', memo: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const toMinor = (s: string) => Math.round(Number(s.replace(/[,$£\s]/g, '') || 0) * 100);
  const dr = lines.reduce((s, l) => s + toMinor(l.debit), 0);
  const cr = lines.reduce((s, l) => s + toMinor(l.credit), 0);
  async function save() {
    setError(null);
    try {
      const r = await api<{ id: string; je_number: string }>('/journal', {
        body: { entityId, postingDate, entryType, memo, autoReverseOn: entryType === 'accrual' ? nextMonthStart(postingDate) : null, lines: lines.filter((l) => l.account).map((l) => ({ account: l.account.trim(), ...(toMinor(l.debit) ? { debit: toMinor(l.debit) } : { credit: toMinor(l.credit) }), department: l.department || null, memo: l.memo || null })) },
      });
      toast(`${r.je_number} drafted and sent for approval.`);
      bump();
      onClose();
      navigate(`journal/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.');
    }
  }
  const set = (i: number, k: keyof LineDraft, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <Dialog
      open
      onClose={onClose}
      title="New journal entry"
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={dr === 0 || dr !== cr || memo.length < 3}>
            Send for approval
          </button>
        </>
      }
    >
      <div className="row">
        <label className="field">
          Entity
          <select value={entityId} onChange={(e) => setEntity(e.target.value)}>
            {legal.map((e) => (
              <option key={e.id} value={e.id}>
                {e.code}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Date
          <input type="date" value={postingDate} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          Type
          <select value={entryType} onChange={(e) => setType(e.target.value as typeof entryType)}>
            {['standard', 'adjusting', 'accrual', 'reclass'].map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        Memo
        <input value={memo} onChange={(e) => setMemo(e.target.value)} />
      </label>
      {lines.map((l, i) => (
        <div key={i} className="row" style={{ alignItems: 'flex-end', gap: 6 }}>
          <label className="field" style={{ width: 82 }}>
            Account
            <input value={l.account} onChange={(e) => set(i, 'account', e.target.value)} placeholder="6500" />
          </label>
          <label className="field" style={{ width: 96 }}>
            Debit
            <input inputMode="decimal" value={l.debit} onChange={(e) => set(i, 'debit', e.target.value)} />
          </label>
          <label className="field" style={{ width: 96 }}>
            Credit
            <input inputMode="decimal" value={l.credit} onChange={(e) => set(i, 'credit', e.target.value)} />
          </label>
          <label className="field" style={{ width: 80 }}>
            Dept
            <input value={l.department} onChange={(e) => set(i, 'department', e.target.value.toUpperCase())} placeholder="GA" />
          </label>
          <button className="btn ghost small" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
            <Trash2 className="icon" aria-hidden="true" />
          </button>
        </div>
      ))}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="btn small" onClick={() => setLines((ls) => [...ls, { account: '', debit: '', credit: '', department: '', memo: '' }])}>
          <Plus className="icon" aria-hidden="true" /> Line
        </button>
        <span className={dr === cr && dr > 0 ? '' : 'error-text'} role="status">
          Debits <Money minor={dr} currency={currency} /> · Credits <Money minor={cr} currency={currency} /> {dr === cr && dr > 0 ? '· balanced' : '· must balance'}
        </span>
      </div>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function nextMonthStart(d: string): string {
  const [y, m] = d.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

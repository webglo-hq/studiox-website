import { AlertTriangle, Check, CheckCircle2, Inbox as InboxIcon, Lock, ShieldAlert, Undo2, X, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, qs } from '../lib/api';
import { date, KIND_LABELS, label, money } from '../lib/format';
import { navigate, useAction, useApi, useHotkeys } from '../lib/hooks';
import { Badge, Confidence, Drawer, Empty, ErrorBox, Money, ReasonDialog, Skeleton, StatusBadge, Tabs, Term } from '../components/ui';

interface Item {
  id: string;
  kind: string;
  title: string;
  why: string;
  confidence: number;
  amount: number;
  currency: string;
  entity: string | null;
  status: string;
  disposition: string;
  autonomy: string;
  riskFlags: string[];
  skill: string | null;
  runId: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  checks: { passed: number; failed: string[]; warnings: string[]; disposition: string | null };
  sampledForReview: boolean;
  postHocStatus: string;
  canApprove: boolean;
  blocks: string[];
  sodWarnings: string[];
  canReject: boolean;
  canReviewPostHoc: boolean;
  canAdopt: boolean;
  postedEntryId: string | null;
}

interface ListData {
  view: string;
  total: number;
  counts: { pending: number; review: number; blocked: number; suggested: number; autoApplied: number };
  items: Item[];
}

type View = 'pending' | 'review' | 'blocked' | 'suggested' | 'decided';

export function InboxScreen({ initialId, view: viewParam }: { initialId: string | null; view: string | null }) {
  const [view, setView] = useState<View>((viewParam as View) || 'pending');
  const [kind, setKind] = useState('');
  const [entity, setEntity] = useState('');
  const task = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('task') ?? undefined;
  const { data, error, reload } = useApi<ListData>(`/api/proposals${qs({ view, kind, entity, task, limit: 300 })}`, { pollMs: 5000 });
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(initialId);
  const [rejecting, setRejecting] = useState<string[] | null>(null);
  const { run, busy } = useAction();
  const items = useMemo(() => data?.items ?? [], [data]);
  useEffect(() => setSelected(new Set()), [view, kind, entity]);
  useEffect(() => setOpenId(initialId), [initialId]);

  const approve = async (ids: string[]) => {
    if (ids.length === 1) await run(() => api.post(`/api/proposals/${ids[0]}/approve`, {}), 'Approved and applied.');
    else await run(() => api.post<{ ok: number; failed: number }>('/api/proposals/bulk', { ids, decision: 'approve' }), (r) => `Approved ${r.ok}${r.failed ? `; ${r.failed} could not be approved by you` : ''}.`);
    setSelected(new Set());
  };
  const current = items[cursor];
  useHotkeys(
    {
      j: () => setCursor((c) => Math.min(items.length - 1, c + 1)),
      k: () => setCursor((c) => Math.max(0, c - 1)),
      Enter: () => current && setOpenId(current.id),
      x: () => current && setSelected((s) => {
        const n = new Set(s);
        if (n.has(current.id)) n.delete(current.id);
        else n.add(current.id);
        return n;
      }),
      a: () => current?.canApprove && void approve([current.id]),
      r: () => current?.canReject && setRejecting([current.id]),
    },
    !openId && !rejecting,
  );
  const approvable = items.filter((i) => selected.has(i.id) && i.canApprove).map((i) => i.id);
  const rejectable = items.filter((i) => selected.has(i.id) && i.canReject).map((i) => i.id);
  const kinds = [...new Set(items.map((i) => i.kind))];
  const entities = [...new Set(items.map((i) => i.entity).filter(Boolean))] as string[];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <div className="sub">
            Agent proposals with their reasons, confidence and <Term id="bh:Evidence">evidence</Term>. Approving applies the change; every decision is logged.
          </div>
        </div>
      </div>
      <Tabs
        label="Inbox views"
        value={view}
        onChange={(v) => {
          setView(v);
          setCursor(0);
        }}
        tabs={[
          { id: 'pending', label: 'Needs approval', count: data?.counts.pending },
          { id: 'review', label: 'Spot-check auto-applied', count: data?.counts.review },
          { id: 'blocked', label: 'Failed checks', count: data?.counts.blocked },
          { id: 'suggested', label: 'Suggestions', count: data?.counts.suggested },
          { id: 'decided', label: 'History' },
        ]}
      />
      <div className="row-wrap">
        <label className="sr-only" htmlFor="kind-filter">
          Kind
        </label>
        <select id="kind-filter" className="select" style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {Object.entries(KIND_LABELS).map(([k, v]) => (
            <option key={k} value={k} disabled={!kinds.includes(k) && kind !== k}>
              {v}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="entity-filter">
          Entity
        </label>
        <select id="entity-filter" className="select" style={{ width: 'auto' }} value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">All entities</option>
          {['BW-US', 'BW-UK', ...entities.filter((e) => !['BW-US', 'BW-UK'].includes(e))].map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        {task && (
          <a className="btn btn-sm" href="#/inbox">
            Clear task filter
          </a>
        )}
        <span className="grow" />
        <span className="tiny muted">
          <span className="kbd">j</span>/<span className="kbd">k</span> move · <span className="kbd">a</span> approve · <span className="kbd">r</span> reject · <span className="kbd">x</span> select
        </span>
      </div>
      {selected.size > 0 && (
        <div className="bulk-bar card card-pad row-wrap" role="region" aria-label="Bulk actions">
          <strong>{selected.size} selected</strong>
          <button type="button" className="btn btn-primary btn-sm" disabled={!approvable.length || busy} onClick={() => void approve(approvable)}>
            <Check size={14} aria-hidden="true" /> Approve {approvable.length}
          </button>
          <button type="button" className="btn btn-danger btn-sm" disabled={!rejectable.length || busy} onClick={() => setRejecting(rejectable)}>
            <X size={14} aria-hidden="true" /> Reject {rejectable.length}
          </button>
          {approvable.length < selected.size && <span className="small muted">{selected.size - approvable.length} need someone else (limit, role or SoD).</span>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      <ErrorBox error={error} onRetry={reload} />
      {!data ? (
        <Skeleton rows={8} />
      ) : items.length === 0 ? (
        <div className="card">
          <Empty icon={<InboxIcon size={28} aria-hidden="true" />} title={view === 'pending' ? 'Inbox zero' : 'Nothing here'}>
            {view === 'pending' ? 'No agent proposal is waiting for a decision.' : 'No items in this view.'}
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table inbox-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={items.length > 0 && items.every((i) => selected.has(i.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())}
                  />
                </th>
                <th>Proposal</th>
                <th className="hide-sm">Entity</th>
                <th className="num">Amount</th>
                <th className="hide-sm">Confidence</th>
                <th className="hide-sm">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i, idx) => (
                <tr key={i.id} className={`clickable${idx === cursor ? ' cursor' : ''}${selected.has(i.id) ? ' selected' : ''}`} onClick={() => { setCursor(idx); setOpenId(i.id); }}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${i.title}`}
                      checked={selected.has(i.id)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(i.id);
                          else n.delete(i.id);
                          return n;
                        })
                      }
                    />
                  </td>
                  <td>
                    <div className="row-wrap" style={{ gap: 6, marginBottom: 3 }}>
                      <Badge>{KIND_LABELS[i.kind] ?? i.kind}</Badge>
                      {i.riskFlags.map((f) => (
                        <Badge key={f} tone="danger" title="Risk flag: auto-apply disabled">
                          <ShieldAlert size={11} aria-hidden="true" /> {label(f)}
                        </Badge>
                      ))}
                      {!i.canApprove && i.status === 'pending' && (
                        <span title={i.blocks.join(' ')}>
                          <Badge>
                            <Lock size={11} aria-hidden="true" /> Needs someone else
                          </Badge>
                        </span>
                      )}
                    </div>
                    <button type="button" className="link-button" onClick={(e) => { e.stopPropagation(); setCursor(idx); setOpenId(i.id); }}>
                      {i.title}
                    </button>
                    <div className="tiny muted">
                      <span className="show-sm">{i.entity ? `${i.entity} · ` : ''}</span>
                      {i.skill} · {date(i.createdAt, 'time')}
                    </div>
                  </td>
                  <td className="hide-sm">{i.entity ?? '—'}</td>
                  <td className="num">
                    <Money minor={i.amount} currency={i.currency} />
                  </td>
                  <td className="hide-sm">
                    <Confidence value={i.confidence} />
                  </td>
                  <td className="hide-sm">
                    <StatusBadge status={i.status} text={i.status === 'auto_applied' ? 'Auto-applied' : undefined} />
                    {i.decidedBy && <div className="tiny muted">{i.decidedBy}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <ProposalDrawer id={openId} onClose={() => { setOpenId(null); if (initialId) navigate('/inbox'); }} onReject={(id) => setRejecting([id])} />}
      {rejecting && (
        <ReasonDialog
          title={rejecting.length === 1 ? 'Reject proposal' : `Reject ${rejecting.length} proposals`}
          prompt="Why? The agent and the next reviewer will see this."
          confirmLabel="Reject"
          danger
          onClose={() => setRejecting(null)}
          onSubmit={async (reason) => {
            if (rejecting.length === 1) await run(() => api.post(`/api/proposals/${rejecting[0]}/reject`, { reason }), 'Rejected.');
            else await run(() => api.post<{ ok: number }>('/api/proposals/bulk', { ids: rejecting, decision: 'reject', reason }), (r) => `Rejected ${r.ok}.`);
            setSelected(new Set());
            setOpenId(null);
          }}
        />
      )}
    </div>
  );
}

interface Detail extends Item {
  evidence: Array<{ type: string; id?: string | null; label: string }>;
  verification: Array<{ id: string; label: string; passed: boolean; severity: string; message?: string }>;
  effect: Record<string, unknown> | null;
  detail: Record<string, unknown> & { type: string };
  approvals: Array<{ decision: string; user: string; role: string; reason: string | null; at: string }>;
  run: { id: string; skill: string; status: string; mode: string; model: string | null; requestedBy: string } | null;
  policy: { version: number; autonomy: string; author: string | null } | null;
  postedEntry: { id: string; number: string } | null;
}

function evidenceHref(e: { type: string; id?: string | null }): string | null {
  if (!e.id) return null;
  if (e.type === 'journal_entry') return `#/ledger/${e.id}`;
  if (e.type === 'reconciliation') return `#/recs/${e.id}`;
  return null;
}

function ProposalDrawer({ id, onClose, onReject }: { id: string; onClose: () => void; onReject: (id: string) => void }) {
  const { data, error } = useApi<Detail>(`/api/proposals/${id}`);
  const { run, busy } = useAction();
  const [reversing, setReversing] = useState(false);
  return (
    <Drawer
      title={data?.title ?? 'Proposal'}
      subtitle={data && <span className="row-wrap"><Badge>{KIND_LABELS[data.kind] ?? data.kind}</Badge><StatusBadge status={data.status} />{data.entity && <Badge>{data.entity}</Badge>}<Confidence value={data.confidence} /></span>}
      onClose={onClose}
      footer={
        data && (
          <>
            {data.status === 'pending' && (
              <button type="button" className="btn btn-primary" disabled={!data.canApprove || busy} onClick={async () => { const r = await run(() => api.post(`/api/proposals/${id}/approve`, {}), 'Approved and applied.'); if (r) onClose(); }}>
                <Check size={15} aria-hidden="true" /> Approve
              </button>
            )}
            {data.canReject && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onReject(id)}>
                <X size={15} aria-hidden="true" /> Reject
              </button>
            )}
            {data.canAdopt && (
              <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.post(`/api/proposals/${id}/adopt`, {}), 'Adopted: it now needs someone else\'s approval.')}>
                Adopt suggestion
              </button>
            )}
            {data.canReviewPostHoc && (
              <>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => api.post(`/api/proposals/${id}/post-hoc`, { decision: 'confirm' }), 'Confirmed.'); if (r) onClose(); }}>
                  <CheckCircle2 size={15} aria-hidden="true" /> Confirm
                </button>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setReversing(true)}>
                  <Undo2 size={15} aria-hidden="true" /> Reverse
                </button>
              </>
            )}
            <span className="grow" />
            {data.run && (
              <a className="btn btn-ghost btn-sm" href={`#/runs/${data.run.id}`}>
                Agent trace
              </a>
            )}
          </>
        )
      }
    >
      <ErrorBox error={error} />
      {!data ? (
        <Skeleton rows={8} />
      ) : (
        <div className="stack" style={{ gap: 18 }}>
          {data.status === 'pending' && !data.canApprove && (
            <div className="callout attention small" role="note">
              <strong>You can't approve this one.</strong> {data.blocks.join(' ')}
            </div>
          )}
          {data.status === 'pending' && data.canApprove && data.sodWarnings.length > 0 && (
            <div className="callout attention small" role="note">
              <strong>Segregation-of-duties warning.</strong> {data.sodWarnings.join(' ')} You can approve, but the warning is recorded with your approval.
            </div>
          )}
          {data.riskFlags.length > 0 && (
            <div className="callout danger small">
              <AlertTriangle size={14} aria-hidden="true" /> Risk flags: {data.riskFlags.map(label).join(', ')}. Auto-apply is disabled for flagged items{data.riskFlags.includes('instruction_like_text') ? ': a source document contained instruction-like text, which the agent treated as data and did not act on.' : '.'}
            </div>
          )}
          <section>
            <h3 className="label">Why the agent proposes this</h3>
            <p style={{ marginTop: 6 }}>{data.why}</p>
          </section>
          <section className="grid grid-3 small">
            <div>
              <div className="label">Amount at stake</div>
              <Money minor={data.amount} currency={data.currency} />
            </div>
            <div>
              <div className="label">
                <Term id="bh:AutonomyLevel">Autonomy</Term>
              </div>
              {data.autonomy} {data.policy ? `· policy v${data.policy.version} (${data.policy.author})` : ''}
            </div>
            <div>
              <div className="label">Proposed by</div>
              {data.run ? `${data.skill} for ${data.run.requestedBy} (${data.run.mode}${data.run.model ? `, ${data.run.model}` : ''})` : data.skill}
            </div>
          </section>
          <KindDetail detail={data.detail} currency={data.currency} />
          <section>
            <h3 className="label">Deterministic checks</h3>
            <ul className="list card" style={{ marginTop: 6 }}>
              {data.verification.filter((c) => c.id !== 'DISPOSITION').map((c, i) => (
                <li key={i} className="row small">
                  {c.passed ? <CheckCircle2 size={15} className="pos" aria-label="passed" /> : c.severity === 'error' ? <XCircle size={15} className="neg" aria-label="failed" /> : <AlertTriangle size={15} style={{ color: 'var(--attention)' }} aria-label="warning" />}
                  <span className="grow">{c.passed ? c.label : (c.message ?? c.label)}</span>
                  <code className="tiny muted">{c.id}</code>
                </li>
              ))}
            </ul>
            {data.checks.disposition && <p className="tiny muted" style={{ marginTop: 6 }}>Routing: {data.checks.disposition}</p>}
          </section>
          <section>
            <h3 className="label">Evidence</h3>
            <ul className="list card" style={{ marginTop: 6 }}>
              {data.evidence.map((e, i) => {
                const href = evidenceHref(e);
                return (
                  <li key={i} className="row small">
                    <Badge>{label(e.type)}</Badge>
                    {href ? <a href={href}>{e.label}</a> : <span>{e.label}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
          {(data.approvals.length > 0 || data.effect) && (
            <section>
              <h3 className="label">Decision record</h3>
              <ul className="list card" style={{ marginTop: 6 }}>
                {data.approvals.map((a, i) => (
                  <li key={i} className="small">
                    <strong>{label(a.decision)}</strong> by {a.user} ({label(a.role)}) {date(a.at, 'time')}
                    {a.reason && <div className="text-2">"{a.reason}"</div>}
                  </li>
                ))}
                {data.status === 'auto_applied' && <li className="small">Applied automatically under the {data.autonomy} policy{data.sampledForReview ? '; sampled for post-hoc review' : ''}.</li>}
                {data.postedEntry && (
                  <li className="small">
                    Posted as <a href={`#/ledger/${data.postedEntry.id}`}>{data.postedEntry.number}</a>
                  </li>
                )}
              </ul>
            </section>
          )}
        </div>
      )}
      {reversing && <ReasonDialog title="Reverse auto-applied work" prompt="Why is this wrong?" confirmLabel="Reverse" danger onClose={() => setReversing(false)} onSubmit={(reason) => run(() => api.post(`/api/proposals/${id}/post-hoc`, { decision: 'reverse', reason }), 'Reversed with a mirror entry.')} />}
    </Drawer>
  );
}

interface EntryView {
  entity: string;
  date: string;
  type: string;
  description: string;
  autoReverseDate: string | null;
  lines: Array<{ account: string; debit: number; credit: number; department: string | null; memo: string | null; txnCurrency: string | null; txnAmount: number | null; counterparty: string | null }>;
}

export function EntryTable({ entry, currency }: { entry: EntryView; currency: string }) {
  const d = entry.lines.reduce((s, l) => s + l.debit, 0);
  const c = entry.lines.reduce((s, l) => s + l.credit, 0);
  return (
    <div className="card table-wrap">
      <div className="card-head small">
        <span>
          <strong>{entry.description}</strong> · {entry.entity} · {date(entry.date)} · <Term id={`bh:JE_${entry.type}`}>{label(entry.type)}</Term>
          {entry.autoReverseDate && <> · reverses {date(entry.autoReverseDate)}</>}
        </span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Dept</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.account}
                {l.memo && <div className="tiny muted">{l.memo}</div>}
                {l.txnCurrency && l.txnAmount !== null && l.txnAmount !== 0 && l.txnCurrency !== currency && <div className="tiny muted">{money(l.txnAmount, l.txnCurrency)} transaction amount</div>}
              </td>
              <td>{l.department ?? ''}</td>
              <td className="num">{l.debit ? money(l.debit, currency) : ''}</td>
              <td className="num">{l.credit ? money(l.credit, currency) : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>{d === c ? 'Balanced' : 'Out of balance'}</td>
            <td className="num">{money(d, currency)}</td>
            <td className="num">{money(c, currency)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function KindDetail({ detail, currency }: { detail: Record<string, unknown> & { type: string }; currency: string }) {
  const entryCurrency = (e: EntryView | null) => (e?.entity === 'BW-UK' ? 'GBP' : currency);
  switch (detail.type) {
    case 'entry': {
      const e = detail.entry as EntryView;
      return <EntryTable entry={e} currency={entryCurrency(e)} />;
    }
    case 'reversal': {
      const e = detail.entry as { id: string; number: string; description: string; total: number } | null;
      return e ? <div className="callout small">Reverses <a href={`#/ledger/${e.id}`}>{e.number}</a> ({e.description}, {money(e.total)}). Reason: {String(detail.reason ?? '')}</div> : null;
    }
    case 'coding': {
      const t = detail.transaction as { merchant: string; date: string; amount: number; currency: string; memo: string | null; mcc: string | null } | null;
      return (
        <div className="card card-pad small stack" style={{ gap: 6 }}>
          {t && (
            <div>
              <strong>{t.merchant}</strong> · {date(t.date)} · <Money minor={t.amount} currency={t.currency} /> {t.mcc && <span className="muted">MCC {t.mcc}</span>}
              {t.memo && <div className="text-2">"{t.memo}"</div>}
            </div>
          )}
          <div>
            Code to <strong>{String(detail.account)}</strong>
            {detail.department ? <> · department {String(detail.department)}</> : null} · signal: {label(String(detail.source))}
          </div>
        </div>
      );
    }
    case 'match': {
      const bank = detail.bank as Array<{ id: string; date: string; amount: number; description: string }>;
      const ledger = detail.ledger as Array<{ id: string; date: string; amount: number; entryNumber: string; description: string; memo: string | null }>;
      return (
        <div className="grid grid-2">
          <div className="card table-wrap">
            <div className="card-head small">
              <strong>Bank</strong>
            </div>
            <table className="table">
              <tbody>
                {bank.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {date(b.date)}
                      <div className="tiny muted">{b.description}</div>
                    </td>
                    <td className="num">{money(b.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card table-wrap">
            <div className="card-head small">
              <strong>Ledger</strong> <span className="muted">{label(String(detail.matchType))}</span>
            </div>
            <table className="table">
              <tbody>
                {ledger.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {date(l.date)} · {l.entryNumber}
                      <div className="tiny muted">{l.description}</div>
                    </td>
                    <td className="num">{money(l.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    case 'reconciling_item':
      return (
        <div className="card card-pad small">
          <Term id="bh:ReconcilingItem">Reconciling item</Term> on {String(detail.account)}: <strong>{label(String(detail.kind))}</strong> {money(Number(detail.amount))} dated {date(String(detail.itemDate))}
          {detail.expectedClearDate ? <> · clears {date(String(detail.expectedClearDate))}</> : null}
          <div className="text-2">{String(detail.description)}</div>
        </div>
      );
    case 'flux': {
      const drivers = (detail.drivers as Array<{ kind: string; label: string; amount_minor: number }>) ?? [];
      return (
        <div className="card card-pad small stack" style={{ gap: 8 }}>
          <div>
            <strong>{String(detail.account)}</strong>: {money(Number(detail.current))} vs {money(Number(detail.comparison))} ({money(Number(detail.variance), 'USD', { signed: true })})
          </div>
          <blockquote className="quote">{String(detail.explanation)}</blockquote>
          <div>
            <div className="label">
              <Term id="bh:VarianceDriver">Drivers</Term>
            </div>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {drivers.map((d, i) => (
                <li key={i}>
                  {d.label}: {money(d.amount_minor, 'USD', { signed: true })}
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    }
    case 'anomaly': {
      const res = detail.resolution as { type: string; reason?: string; entry?: unknown; voidBillIds?: string[] };
      return (
        <div className="stack" style={{ gap: 8 }}>
          <div className="card card-pad small">
            <Badge tone={detail.severity === 'high' ? 'danger' : 'attention'}>{label(String(detail.severity))} severity</Badge> <strong>{label(String(detail.category))}</strong>
            <p className="text-2" style={{ marginTop: 6 }}>
              Recommended: {String(detail.recommendedAction)}
            </p>
          </div>
          {res.type === 'reverse_entry' && res.entry ? (
            <div className="callout small">
              Approving reverses <a href={`#/ledger/${(res.entry as { id: string }).id}`}>{(res.entry as { number: string }).number}</a> ({(res.entry as { description: string }).description}, {money((res.entry as { total: number }).total)}).
              {(res.entry as { preparedBy?: string }).preparedBy && <> Prepared by "{(res.entry as { preparedBy: string }).preparedBy}" and approved by "{(res.entry as { approvedBy: string }).approvedBy}" in the source ERP.</>}
            </div>
          ) : res.type === 'journal_entry' && res.entry ? (
            <>
              <div className="small text-2">Approving posts this correcting entry{res.voidBillIds?.length ? ' and voids the duplicate bill' : ''}:</div>
              <EntryTable entry={res.entry as EntryView} currency={entryCurrency(res.entry as EntryView)} />
            </>
          ) : (
            <div className="small text-2">Approving records that an independent reviewer looked at this finding. No entry is posted.</div>
          )}
        </div>
      );
    }
    case 'prepaid_schedule':
      return (
        <div className="stack" style={{ gap: 8 }}>
          <div className="card card-pad small">
            New <Term id="bh:PrepaidSchedule">prepaid schedule</Term>: {String(detail.description)} · {money(Number(detail.total))} over {String(detail.months)} months from {date(String(detail.startDate))} · {String(detail.balanceAccount)} → {String(detail.plAccount)}
          </div>
          {Boolean(detail.catchUpEntry) && <EntryTable entry={detail.catchUpEntry as EntryView} currency={currency} />}
        </div>
      );
    case 'capitalize':
      return (
        <div className="stack" style={{ gap: 8 }}>
          <div className="card card-pad small">
            <Term id="bh:FixedAsset">Fixed asset</Term>: {String(detail.description)} · {money(Number(detail.cost))} · {label(String(detail.assetClass))} · {String(detail.usefulLifeMonths)} months from {date(String(detail.inServiceDate))} · {String(detail.assetAccount)}
          </div>
          <EntryTable entry={detail.reclass as EntryView} currency={currency} />
        </div>
      );
    case 'close_package': {
      const blockers = (detail.openBlockers as string[]) ?? [];
      const act = detail.agentActivity as { runs: number; proposals: number; autoApplied: number; approved: number; rejected: number; pending: number } | undefined;
      return (
        <div className="card card-pad small stack" style={{ gap: 6 }}>
          <div>
            Package hash <code>{String(detail.contentHash).slice(0, 16)}...</code> · <a href={`#/close/${String(detail.closeId)}/package`}>Open the package</a>
          </div>
          {act && (
            <div className="text-2">
              {act.runs} agent runs, {act.proposals} proposals: {act.autoApplied} auto-applied, {act.approved} approved, {act.rejected} rejected, {act.pending} pending.
            </div>
          )}
          {blockers.length > 0 && <div className="callout attention">Still open: {blockers.slice(0, 5).join('; ')}</div>}
        </div>
      );
    }
    default:
      return null;
  }
}

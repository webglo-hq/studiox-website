/**
 * Inbox: every agent proposal with its why, confidence, evidence and verification. Approve,
 * reject (with a reason), review auto-applied items, edit a coding, or approve in bulk.
 * Keyboard: j/k move, Enter opens, a approves the open item.
 */
import { Check, CircleAlert, CircleCheck, ExternalLink, Lock, Pencil, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, qs, type ProposalDetail, type ProposalList } from '../api';
import { Badge, Confidence, Drawer, Empty, ErrorBox, FlagBadges, Loading, Money, ProposalStatus, ReasonDialog, Segmented, Term } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { date, KIND_LABEL, ROLE_LABEL, ROUTE_LABEL, titleCase } from '../lib/format';
import { setQuery, useRoute } from '../lib/router';

type StatusFilter = 'open' | 'review' | 'auto' | 'all';

const KIND_TERM: Record<string, string> = { journal_entry: 'tie:JournalEntryProposal', coding: 'tie:CodingProposal', rec_match: 'tie:MatchProposal', reconciling_item: 'tie:ReconcilingItem', flux_explanation: 'tie:VarianceExplanation', finding: 'tie:Finding', report: 'tie:ClosePackage' };

export function Inbox() {
  const me = useMe();
  const { period, toast, bump } = useApp();
  const route = useRoute();
  const status = (route.query.get('status') as StatusFilter | null) ?? 'open';
  const kind = route.query.get('kind') ?? '';
  const skill = route.query.get('skill') ?? '';
  const text = route.query.get('q') ?? '';
  const openId = route.query.get('open');
  const { data, error, loading, reload } = useData(() => api<ProposalList>(`/proposals${qs({ status, kind, skill, q: text, period })}`), [status, kind, skill, text, period]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => data?.items ?? [], [data]);

  useEffect(() => setSelected(new Set()), [status, kind, skill, text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [role="dialog"]') || e.metaKey || e.ctrlKey || openId) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        setCursor((c) => {
          const n = Math.max(0, Math.min(items.length - 1, c + (e.key === 'j' ? 1 : -1)));
          listRef.current?.querySelectorAll<HTMLElement>('[data-row]')[n]?.focus();
          return n;
        });
      }
      if (e.key === 'Enter' && items[cursor] && (t.dataset.row !== undefined || t === document.body)) setQuery('open', items[cursor]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, cursor, openId]);

  async function bulkApprove() {
    setBusy(true);
    try {
      const r = await api<{ results: { ok: boolean; ref?: string; error?: string }[] }>('/proposals/bulk-approve', { body: { ids: [...selected] } });
      const ok = r.results.filter((x) => x.ok).length;
      const bad = r.results.filter((x) => !x.ok);
      toast(`${ok} approved${bad.length ? `; ${bad.length} could not be approved (${bad[0]!.error})` : ''}.`, bad.length ? 'bad' : 'ok');
      setSelected(new Set());
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Bulk approval failed.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  const decidable = items.filter((i) => i.canDecide);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p className="lede">
            Agent work waiting for a person, and items the policy applied that were sampled for review. Every item says why, how sure the agent is, and what it is based on; the{' '}
            <Term id="tie:Verification">verifier</Term> has already re-checked it against the ontology.
          </p>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 14 }} role="search">
        <Segmented<StatusFilter>
          label="Show"
          value={status}
          onChange={(v) => setQuery('status', v === 'open' ? null : v)}
          options={[
            { value: 'open', label: `Needs a decision${data ? ` (${data.counts.open})` : ''}` },
            { value: 'review', label: 'Review queue' },
            { value: 'auto', label: 'Applied by policy' },
            { value: 'all', label: 'All' },
          ]}
        />
        <label className="sr-only" htmlFor="f-kind">
          Kind
        </label>
        <select id="f-kind" value={kind} onChange={(e) => setQuery('kind', e.target.value || null)}>
          <option value="">All kinds</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="f-q">
          Search
        </label>
        <input id="f-q" type="search" placeholder="Search title, why or ref" defaultValue={text} onKeyDown={(e) => e.key === 'Enter' && setQuery('q', (e.target as HTMLInputElement).value || null)} style={{ minWidth: 240 }} />
        {skill ? (
          <button className="btn small" onClick={() => setQuery('skill', null)}>
            Skill: {skill} <X className="icon" aria-hidden="true" />
          </button>
        ) : null}
        <span style={{ flex: 1 }} />
        {status === 'open' && decidable.length ? (
          <>
            <button className="btn small" onClick={() => setSelected(selected.size === decidable.length ? new Set() : new Set(decidable.map((d) => d.id)))}>
              {selected.size === decidable.length ? 'Clear selection' : `Select all I can approve (${decidable.length})`}
            </button>
            <button className="btn primary small" disabled={!selected.size || busy} onClick={() => void bulkApprove()}>
              <Check className="icon" aria-hidden="true" /> Approve {selected.size || ''} selected
            </button>
          </>
        ) : null}
      </div>
      {error ? <ErrorBox error={error} onRetry={reload} /> : null}
      {!data ? (
        <Loading />
      ) : (
        <section className={`card${loading ? ' skeleton' : ''}`} aria-label="Proposals" ref={listRef}>
          {items.length === 0 ? (
            <Empty title={status === 'open' ? 'Nothing needs a decision' : 'No items'}>{status === 'open' ? 'When agents propose work that needs a person, it lands here.' : 'Try another filter.'}</Empty>
          ) : (
            items.map((p, i) => (
              <div className="prop" key={p.id} data-row data-active={cursor === i ? 'true' : undefined} aria-current={cursor === i ? 'true' : undefined} tabIndex={0} onFocus={() => setCursor(i)} onKeyDown={(e) => e.key === 'Enter' && setQuery('open', p.id)}>
                {status === 'open' ? (
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.ref}`}
                    disabled={!p.canDecide}
                    checked={selected.has(p.id)}
                    onChange={(e) => {
                      const s = new Set(selected);
                      if (e.target.checked) s.add(p.id);
                      else s.delete(p.id);
                      setSelected(s);
                    }}
                    style={{ width: 20, height: 20, minHeight: 20, marginTop: 3 }}
                  />
                ) : (
                  <span className="badge neutral">{p.ref}</span>
                )}
                <div>
                  <a className="title" href={`#/inbox?${new URLSearchParams({ ...Object.fromEntries(route.query), open: p.id }).toString()}`}>
                    {status === 'open' ? <span className="muted mono" style={{ fontWeight: 400 }}>{p.ref} </span> : null}
                    {p.title}
                  </a>
                  <p className="why">{p.why}</p>
                  <div className="meta">
                    <span>{KIND_LABEL[p.kind]}</span>·<span>{p.skillKey}</span>
                    <ProposalStatus status={p.status} route={p.route} reviewStatus={p.reviewStatus} />
                    <FlagBadges flags={p.flags} />
                    {p.status === 'pending_approval' && p.assignedRole ? <span>for {ROLE_LABEL[p.assignedRole] ?? p.assignedRole}</span> : null}
                    {!p.canDecide && p.blockedBy.length && status === 'open' ? (
                      <span title={p.blockedBy.join(' ')}>
                        <Lock className="icon" style={{ width: 12, height: 12, verticalAlign: -1 }} aria-hidden="true" /> {p.blockedBy[0]!.replace(/^[A-Z0-9-]+: /, '')}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div style={{ textAlign: 'right', minWidth: 110 }}>
                  {p.amountMinor ? <Money minor={p.amountMinor} currency={p.currency} /> : null}
                  <div>
                    <Confidence value={p.confidence} />
                  </div>
                </div>
              </div>
            ))
          )}
        </section>
      )}
      {openId ? <ProposalDrawer id={openId} canEdit={can(me, 'coding.approve')} onClose={() => setQuery('open', null)} onChanged={() => { bump(); reload(); }} /> : null}
    </div>
  );
}

function ProposalDrawer({ id, onClose, onChanged, canEdit }: { id: string; onClose: () => void; onChanged: () => void; canEdit: boolean }) {
  const { toast } = useApp();
  const { data: p, error, reload } = useData(() => api<ProposalDetail>(`/proposals/${id}`), [id]);
  const [rejecting, setRejecting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [acct, setAcct] = useState('');
  const [dept, setDept] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'a' && !t.closest('input, textarea, select') && p?.eligibility.canDecide && !busy) void decide('approve');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function decide(action: 'approve' | 'reject' | 'review', reason?: string) {
    setBusy(true);
    try {
      await api(`/proposals/${id}/${action}`, { body: action === 'reject' ? { reason } : {} });
      toast(action === 'approve' ? `${p?.ref} approved and applied.` : action === 'reject' ? `${p?.ref} rejected.` : `${p?.ref} marked reviewed.`);
      onChanged();
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'That did not work.', 'bad');
      reload();
    } finally {
      setBusy(false);
      setRejecting(false);
    }
  }

  async function saveEdit() {
    setBusy(true);
    try {
      await api(`/proposals/${id}/edit`, { body: { accountCode: acct, department: dept || null } });
      toast('Coding changed. You are now a preparer of this item, so someone else approves it.');
      setEditing(false);
      reload();
      onChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not change the coding.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  const payload = (p?.payload ?? {}) as Record<string, unknown>;
  const open = p && (p.status === 'pending_approval' || p.status === 'suggested');
  return (
    <Drawer
      open
      onClose={onClose}
      title={p ? p.title : 'Loading…'}
      subtitle={
        p ? (
          <span className="row" style={{ gap: 6 }}>
            <span className="mono">{p.ref}</span>·<Term id={KIND_TERM[p.kind] ?? 'tie:Proposal'}>{KIND_LABEL[p.kind]}</Term>·<span>{p.skillTitle}</span>
            {p.run ? (
              <>
                ·<a href={`#/runs/${p.run.id}`}>{p.run.ref}</a>
              </>
            ) : null}
          </span>
        ) : undefined
      }
      footer={
        p ? (
          open ? (
            <>
              {p.eligibility.canDecide ? (
                <button className="btn primary" disabled={busy} onClick={() => void decide('approve')}>
                  <Check className="icon" aria-hidden="true" /> {p.kind === 'finding' ? 'Acknowledge' : p.kind === 'journal_entry' || p.kind === 'coding' ? 'Approve & post' : 'Approve'} <span className="kbd" style={{ marginLeft: 4 }}>a</span>
                </button>
              ) : (
                <span className="row" style={{ gap: 6, color: 'var(--ink-2)', fontSize: 14 }}>
                  <Lock className="icon" aria-hidden="true" /> You can’t approve this.
                </span>
              )}
              <button className="btn danger" disabled={busy || !p.eligibility.reasons.every((r) => !r.includes('permission'))} onClick={() => setRejecting(true)}>
                <X className="icon" aria-hidden="true" /> Reject
              </button>
              {p.kind === 'coding' && canEdit ? (
                <button className="btn" onClick={() => { setAcct(String(payload.accountCode ?? '')); setDept(String(payload.department ?? '')); setEditing((e) => !e); }}>
                  <Pencil className="icon" aria-hidden="true" /> Change coding
                </button>
              ) : null}
            </>
          ) : p.reviewStatus === 'pending' ? (
            <button className="btn primary" disabled={busy} onClick={() => void decide('review')}>
              <CircleCheck className="icon" aria-hidden="true" /> Mark reviewed
            </button>
          ) : (
            <span className="muted">
              {p.decidedBy ? `Decided by ${p.decidedBy} ${date(p.decidedAt)}` : 'Closed'}
              {p.decisionReason ? ` — “${p.decisionReason}”` : ''}
            </span>
          )
        ) : null
      }
    >
      {error ? <ErrorBox error={error} /> : null}
      {!p ? (
        <Loading />
      ) : (
        <div className="stack">
          <div className="row">
            <ProposalStatus status={p.status} route={p.route} reviewStatus={p.reviewStatus} />
            <FlagBadges flags={p.flags} />
            <span style={{ flex: 1 }} />
            {p.amountMinor ? <Money minor={p.amountMinor} currency={p.currency} className="value" /> : null}
            <Confidence value={p.confidence} />
          </div>
          <div className="why-box">{p.why}</div>
          {!p.eligibility.canDecide && open && p.eligibility.reasons.length ? (
            <div className="callout warn" role="note">
              <CircleAlert className="icon" aria-hidden="true" />
              <div>
                <strong>Why you can’t approve it</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {p.eligibility.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                {p.assignedRole ? <p style={{ marginTop: 6 }}>Assigned to: {ROLE_LABEL[p.assignedRole] ?? p.assignedRole}.</p> : null}
              </div>
            </div>
          ) : null}
          {editing ? (
            <div className="card card-pad stack" style={{ gap: 10 }}>
              <h3>Change the coding</h3>
              <div className="row">
                <label className="field">
                  Account
                  <input value={acct} onChange={(e) => setAcct(e.target.value)} placeholder="6400" style={{ width: 120 }} />
                </label>
                <label className="field">
                  Department
                  <input value={dept} onChange={(e) => setDept(e.target.value.toUpperCase())} placeholder="SALES" style={{ width: 140 }} />
                </label>
              </div>
              <div className="row">
                <button className="btn primary small" disabled={busy} onClick={() => void saveEdit()}>
                  Save change
                </button>
                <button className="btn small" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {p.lines ? (
            <section aria-labelledby="h-lines">
              <h3 id="h-lines" style={{ marginBottom: 6 }}>
                Entry ({titleCase(String(payload.entryType ?? ''))}, {date(String(payload.postingDate ?? ''), true)}
                {payload.autoReverseOn ? `, reverses ${date(String(payload.autoReverseOn))}` : ''})
              </h3>
              <div className="table-wrap card">
                <table className="data je-lines">
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col">Dept</th>
                      <th scope="col" className="r">
                        Debit
                      </th>
                      <th scope="col" className="r">
                        Credit
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.lines.map((l, i) => (
                      <tr key={i}>
                        <td>
                          <span className="mono">{l.account}</span> {l.accountName}
                          {l.memo ? <div className="muted" style={{ fontSize: 12 }}>{l.memo}</div> : null}
                        </td>
                        <td>{l.department ?? ''}</td>
                        <td className="r num">{l.debit ? <Money minor={l.debit} currency={p.currency} /> : ''}</td>
                        <td className="r num">{l.credit ? <Money minor={l.credit} currency={p.currency} /> : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {p.appliedEntry ? (
                <p style={{ marginTop: 6 }}>
                  Posted as <a href={`#/journal/${p.appliedEntry.id}`}>{p.appliedEntry.number}</a>.
                </p>
              ) : null}
            </section>
          ) : null}
          {p.kind === 'flux_explanation' ? <blockquote className="why-box" style={{ margin: 0, borderLeftColor: 'var(--info)' }}>{String(payload.text ?? '')}</blockquote> : null}
          {p.dependsOn.length ? (
            <div className="callout info">
              <div>
                This entry assumes {p.dependsOn.map((d) => `${d.ref} (${d.status.replace('_', ' ')})`).join(', ')} {p.dependsOn.length === 1 ? 'is' : 'are'} posted, so it can only be approved after{' '}
                {p.dependsOn.length === 1 ? 'it' : 'them'}.
              </div>
            </div>
          ) : null}
          <section aria-labelledby="h-ev">
            <h3 id="h-ev" style={{ marginBottom: 6 }}>
              <Term id="tie:Evidence">Evidence</Term>
            </h3>
            <ul className="checks">
              {p.evidence.map((e, i) => (
                <li key={i}>
                  <Badge icon={false}>{e.kind.replace('_', ' ')}</Badge>
                  <span>
                    {e.refType === 'journal_entry' && e.refId ? <a href={`#/journal/${e.refId}`}>{e.label}</a> : e.refType === 'source_document' && e.refId ? <a href={`#/documents/${e.refId}`}>{e.label}</a> : e.label}
                    {e.detail ? <span className="muted"> — {e.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="h-ver">
            <h3 id="h-ver" style={{ marginBottom: 6 }}>
              Verification ({p.verification.filter((v) => v.passed).length}/{p.verification.length} checks hold)
            </h3>
            <ul className="checks">
              {p.verification.map((v, i) => (
                <li key={i}>
                  {v.passed ? <CircleCheck className="icon" style={{ color: 'var(--accent)' }} aria-label="passed" /> : <CircleAlert className="icon" style={{ color: v.severity === 'error' ? 'var(--danger)' : 'var(--warn)' }} aria-label={v.severity} />}
                  <span>
                    {v.axiomId ? (
                      <a href={`#/ontology?axiom=${v.axiomId}`} className="mono" style={{ marginRight: 6 }}>
                        {v.axiomId}
                      </a>
                    ) : null}
                    <strong style={{ fontWeight: 600 }}>{v.check}</strong>
                    <span className="muted"> — {v.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="h-route">
            <h3 id="h-route" style={{ marginBottom: 6 }}>
              Routing
            </h3>
            <p>
              <strong>{ROUTE_LABEL[p.route] ?? p.route}.</strong> {p.routeReasons.join(' ')}
            </p>
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Prepared by</dt>
              <dd>{p.preparedBy}</dd>
              <dt>Run requested by</dt>
              <dd>{p.requestedBy ?? '—'}</dd>
              {p.editedBy ? (
                <>
                  <dt>Edited by</dt>
                  <dd>{p.editedBy}</dd>
                </>
              ) : null}
              <dt>Materiality</dt>
              <dd>
                <Term id="tie:Materiality">{p.materiality.replace('_', ' ')}</Term>
              </dd>
              <dt>Needs permission</dt>
              <dd>
                <code>{p.decisionPermission}</code>
              </dd>
            </dl>
            {p.approvals.length ? (
              <ul className="checks" style={{ marginTop: 8 }}>
                {p.approvals.map((a, i) => (
                  <li key={i}>
                    <Badge tone={a.decision === 'rejected' ? 'bad' : 'good'} icon={false}>
                      {a.decision}
                    </Badge>
                    <span>
                      {a.by} ({a.actorType}) {date(a.at)} {a.reason ? `— ${a.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          {p.run ? (
            <a href={`#/runs/${p.run.id}`} className="row" style={{ gap: 6 }}>
              See how the agent got here <ExternalLink className="icon" aria-hidden="true" />
            </a>
          ) : null}
        </div>
      )}
      <ReasonDialog open={rejecting} title={`Reject ${p?.ref ?? ''}`} label="Why are you rejecting it?" confirm="Reject" onCancel={() => setRejecting(false)} onConfirm={(r) => void decide('reject', r)} />
    </Drawer>
  );
}

import { AlertTriangle, Bot, Check, CheckCheck, CircleCheck, CircleX, FileText, Filter, Fingerprint, History, Inbox as InboxIcon, Undo2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { MethodOutput } from '../../app/methods';
import { useAgents } from '../lib/agents';
import { useAction, useApi } from '../lib/api';
import { humanize, money, plural, when } from '../lib/format';
import { href, navigate, setQuery, type Route } from '../lib/router';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Confidence, Dialog, Disclosure, Drawer, Empty, ErrorState, Field, Kv, Loading, Money, Notice, PageHead, Person, Status, Tabs } from '../ui/kit';
import { Term } from '../ui/term';

type Proposal = MethodOutput<'inbox.get'>;
type Tab = 'mine' | 'waiting' | 'review' | 'auto' | 'decided';

const KIND_TERM: Record<string, string> = {
  journal_entry: 'ek:JournalEntry',
  coding: 'ek:CodingDecision',
  rec_match: 'ek:Match',
  reconciling_item: 'ek:ReconcilingItem',
  flux_explanation: 'ek:VarianceExplanation',
  issue: 'ek:Exception',
  prepaid_schedule: 'ek:PrepaidSchedule',
  fixed_asset: 'ek:FixedAsset',
  close_package: 'ek:ClosePackage',
  task_update: 'ek:CloseTask',
};

function RejectDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const decide = useAction('inbox.decide', {
    success: (o) => {
      const ok = o.results.filter((r) => r.ok).length;
      return `Rejected ${plural(ok, 'proposal')}. The agent will not post ${ok === 1 ? 'it' : 'them'}.`;
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Dialog
      title={`Reject ${plural(ids.length, 'proposal')}`}
      description="Rejected proposals are never posted. Your reason is recorded on each one and in the audit log, and the agent learns nothing silently."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<X size={16} aria-hidden />} busy={decide.isPending} disabled={reason.trim().length < 3} onClick={() => decide.mutate({ ids, decision: 'reject', reason })} data-testid="confirm-reject">
            Reject
          </Button>
        </>
      }
    >
      <Field label="Why are you rejecting?" htmlFor="reject-reason" help="At least 3 characters, e.g. “Duplicate of the vendor's credit memo”.">
        <textarea id="reject-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} data-autofocus />
      </Field>
    </Dialog>
  );
}

function UndoDialog({ p, onClose }: { p: Proposal; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const undo = useAction('inbox.undo', { success: 'Posted a reversal. The original entry is unchanged and linked to it.', onSuccess: onClose });
  return (
    <Dialog
      title="Undo by reversal"
      description="Posted entries are never edited or deleted. Undo posts an equal and opposite entry dated in the open period and links the two."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<Undo2 size={16} aria-hidden />} busy={undo.isPending} disabled={reason.trim().length < 3} onClick={() => undo.mutate({ id: p.id, reason })}>
            Post reversal
          </Button>
        </>
      }
    >
      <Field label="Reason" htmlFor="undo-reason">
        <textarea id="undo-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} data-autofocus />
      </Field>
    </Dialog>
  );
}

function ProposalDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useApi('inbox.get', { id });
  const agents = useAgents();
  const [rejecting, setRejecting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const decide = useAction('inbox.decide', {
    success: (o) => (o.results[0]?.ok ? (o.continuing || o.continued ? 'Approved and posted. The next agents are starting.' : 'Approved and posted.') : (o.results[0]?.error ?? 'Not approved.')),
    onSuccess: (o) => o.continuing && agents.expect(),
  });
  const review = useAction('inbox.review', { success: 'Review recorded.' });
  const p = q.data;
  return (
    <Drawer
      label="Proposal"
      title={p ? p.title : 'Proposal'}
      sub={
        p ? (
          <span className="row-wrap">
            <Badge>{p.kindLabel}</Badge>
            <Status value={p.status} />
            {p.materiality === 'material' && <Status value="material" label="Material" />}
            {p.injectionFlag && (
              <Badge tone="bad">
                <AlertTriangle size={12} aria-hidden /> Untrusted text flagged
              </Badge>
            )}
          </span>
        ) : null
      }
      onClose={onClose}
      footer={
        p && (
          <>
            {['pending', 'suggested'].includes(p.status) && (
              <>
                <Button variant="good" icon={<Check size={16} aria-hidden />} disabled={!p.canApprove.ok} busy={decide.isPending} onClick={() => decide.mutate({ ids: [p.id], decision: 'approve' })} data-testid="approve-one">
                  Approve and post
                </Button>
                <Button variant="danger" icon={<X size={16} aria-hidden />} disabled={!p.canReject.ok} onClick={() => setRejecting(true)}>
                  Reject…
                </Button>
              </>
            )}
            {p.canReview.ok && (
              <Button icon={<CheckCheck size={16} aria-hidden />} busy={review.isPending} onClick={() => review.mutate({ id: p.id, note: 'Reviewed after posting' })}>
                Mark reviewed
              </Button>
            )}
            {p.canUndo.ok && (
              <Button variant="quiet" icon={<Undo2 size={16} aria-hidden />} onClick={() => setUndoing(true)}>
                Undo (reversal)
              </Button>
            )}
            <span className="grow" />
            <a href={href(`/runs/${p.run.id}`)} className="small">
              See the agent's trace
            </a>
          </>
        )
      }
    >
      {q.isLoading && <Loading rows={8} />}
      {q.isError && <ErrorState error={q.error} retry={() => void q.refetch()} />}
      {p && (
        <>
          {['pending', 'suggested'].includes(p.status) && !p.canApprove.ok && (
            <Notice tone="warn" title="You cannot approve this one">
              {p.canApprove.reasons.join(' ')}
            </Notice>
          )}
          {p.injectionFlag && (
            <Notice tone="bad" title="Possible prompt injection">
              Text from a source document looked like instructions to the agent. The agent treated it as data only, flagged it and did not act on it. Check the evidence before deciding.
            </Notice>
          )}
          <section className="stack" aria-label="Why">
            <h3>Why the agent proposes this</h3>
            <p>{p.why}</p>
            <div className="row-wrap small">
              <span className="row">
                Confidence <Confidence value={p.confidence} />
              </span>
              {p.amount !== null && (
                <span>
                  Amount <strong>{money(p.amount, p.currency ?? 'USD')}</strong>
                </span>
              )}
              {p.entityCode && <span>Entity {p.entityCode}</span>}
              <span>
                <Term id="ek:Materiality">Materiality</Term>: <Status value={p.materiality} />
              </span>
            </div>
          </section>

          <section className="stack" aria-label="What will be posted">
            <h3>
              What it will do · <Term id={KIND_TERM[p.kind] ?? 'ek:Proposal'}>{p.kindLabel}</Term>
            </h3>
            {p.preview.fields.length > 0 && <Kv items={p.preview.fields.map((f) => [f.label, f.value])} />}
            {p.preview.lines && (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col">Memo</th>
                      <th scope="col" className="num">
                        Debit
                      </th>
                      <th scope="col" className="num">
                        Credit
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.preview.lines.map((l, i) => (
                      <tr key={i}>
                        <td>
                          {l.account}
                          {l.dimension && <div className="xs muted">{l.dimension}</div>}
                        </td>
                        <td className="small ink2">{l.memo ?? ''}</td>
                        <td className="num">{l.debit ? money(l.debit, p.currency ?? 'USD') : ''}</td>
                        <td className="num">{l.credit ? money(l.credit, p.currency ?? 'USD') : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2}>Total (balanced)</td>
                      <td className="num">{money(p.preview.lines.reduce((s, l) => s + l.debit, 0), p.currency ?? 'USD')}</td>
                      <td className="num">{money(p.preview.lines.reduce((s, l) => s + l.credit, 0), p.currency ?? 'USD')}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {p.preview.drivers && p.preview.drivers.length > 0 && (
              <ul className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
                {p.preview.drivers.map((d, i) => (
                  <li key={i}>
                    {d.label} <span className="muted">({d.kind.replace(/_/g, ' ')})</span> <strong>{money(d.amount, p.currency ?? 'USD', { signed: true })}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="stack" aria-label="Evidence">
            <h3>
              <Term id="ek:Evidence">Evidence</Term>
            </h3>
            <div>
              {p.evidence.map((e, i) => (
                <div key={i} className={`evidence ${e.untrusted ? 'untrusted' : ''}`}>
                  {e.kind === 'document' ? <FileText size={16} aria-hidden /> : e.kind === 'history' ? <History size={16} aria-hidden /> : <Fingerprint size={16} aria-hidden />}
                  <div className="stack" style={{ gap: 2 }}>
                    <span>
                      {e.label}
                      {e.untrusted && (
                        <Badge tone="warn" title="Text from an outside document, treated as data only">
                          untrusted text
                        </Badge>
                      )}
                    </span>
                    {e.detail && <span className="xs muted">{e.detail}</span>}
                    {e.ref && (
                      <a className="xs" href={e.ref.type === 'journal_entry' ? href(`/journals/${e.ref.id}`) : e.ref.type === 'source_document' ? href(`/documents/${e.ref.id}`) : e.ref.type === 'reconciliation' ? href(`/recs/${e.ref.id}`) : href(`/records/${e.ref.type}/${e.ref.id}`)}>
                        Open {e.ref.label ?? humanize(e.ref.type)}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="stack" aria-label="Checks">
            <h3>Deterministic checks</h3>
            <ul className="stack small" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
              {p.checks.map((c) => (
                <li key={c.id} className="row" style={{ alignItems: 'flex-start' }}>
                  {c.ok ? <CircleCheck size={16} color="var(--good)" aria-label="Passed" /> : <CircleX size={16} color={c.severity === 'error' ? 'var(--bad)' : 'var(--warn)'} aria-label="Failed" />}
                  <span>
                    {c.label}
                    {c.detail && <span className="muted"> — {c.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {p.gate && (
              <div className="sunken small">
                <strong>
                  Policy gate · <Term id="ek:AutonomyLevel">autonomy</Term> {p.gate.level}:
                </strong>{' '}
                {p.gate.reasons.join(' ')}
              </div>
            )}
          </section>

          <section className="stack" aria-label="Provenance">
            <h3>Provenance</h3>
            <Kv
              items={[
                ['Prepared by', `${p.skillId} agent (${p.run.engine === 'live' ? `Claude ${p.run.model ?? ''}` : 'offline engine'})`],
                ['On behalf of', <Person key="rb" name={p.run.requestedBy?.name} />],
                ['Task', p.run.taskCode ? `${p.run.taskCode} ${p.run.taskTitle}` : '—'],
                ['Created', when(p.createdAt)],
                ...(p.decidedBy ? ([['Decided by', `${p.decidedBy.name} · ${when(p.decidedAt)}`]] as [string, string][]) : []),
                ...(p.decisionReason ? ([['Reason', p.decisionReason]] as [string, string][]) : []),
                ...(p.reviewedBy ? ([['Reviewed by', p.reviewedBy.name]] as [string, string][]) : []),
              ]}
            />
            <Disclosure summary="Raw payload (ontology-typed JSON)">
              <pre className="code">{JSON.stringify(p.payload, null, 2)}</pre>
            </Disclosure>
          </section>
          {rejecting && <RejectDialog ids={[p.id]} onClose={() => setRejecting(false)} onDone={() => undefined} />}
          {undoing && <UndoDialog p={p} onClose={() => setUndoing(false)} />}
        </>
      )}
    </Drawer>
  );
}

export function AgentInbox({ route, openId }: { route: Route; openId: string | null }) {
  const { can } = useSession();
  const tab = (route.query.get('tab') as Tab | null) ?? 'mine';
  const kind = route.query.get('kind') ?? undefined;
  const [search, setSearch] = useState('');
  const list = useApi('inbox.list', { tab, kind, q: search || undefined, limit: 200 }, { keepPrevious: true });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [rejectIds, setRejectIds] = useState<string[] | null>(null);
  const agents = useAgents();
  const decide = useAction('inbox.decide', {
    success: (o) => {
      const ok = o.results.filter((r) => r.ok).length;
      const bad = o.results.length - ok;
      return `Approved ${plural(ok, 'proposal')}${bad ? `; ${bad} could not be approved (${o.results.find((r) => !r.ok)?.error ?? ''})` : ''}.${o.continuing || o.continued ? ' The next agents are starting.' : ''}`;
    },
    onSuccess: (o) => {
      setSelected(new Set());
      if (o.continuing) agents.expect();
    },
  });
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const approvable = items.filter((p) => p.canApprove.ok);

  // A different view starts with nothing selected (adjusting state while rendering, not in an effect).
  const view = `${tab}|${kind ?? ''}`;
  const [viewSeen, setViewSeen] = useState(view);
  if (viewSeen !== view) {
    setViewSeen(view);
    setSelected(new Set());
    setCursor(0);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.ctrlKey || e.metaKey || e.altKey || openId || rejectIds || document.querySelector('[role="dialog"]')) return;
      const cur = items[cursor];
      if (e.key === 'j') setCursor((c) => Math.min(items.length - 1, c + 1));
      else if (e.key === 'k') setCursor((c) => Math.max(0, c - 1));
      else if (e.key === 'x' && cur) {
        setSelected((s) => {
          const n = new Set(s);
          if (n.has(cur.id)) n.delete(cur.id);
          else n.add(cur.id);
          return n;
        });
      } else if (e.key === 'Enter' && cur) navigate(href(`/inbox/${cur.id}`, Object.fromEntries(route.query)));
      else if (e.key === 'a' && selected.size) decide.mutate({ ids: [...selected], decision: 'approve' });
      else if (e.key === 'r' && selected.size) setRejectIds([...selected]);
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, cursor, selected, openId, rejectIds, decide, route.query]);

  const counts = list.data?.counts;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const decidable = tab === 'mine' || tab === 'waiting';
  const selectedApprovable = [...selected].filter((id) => approvable.some((p) => p.id === id));
  const closeDetail = () => navigate(href('/inbox', Object.fromEntries(route.query)));

  return (
    <div className="page">
      <PageHead
        eyebrow="Agent inbox"
        title="Proposals for review"
        sub={
          <>
            Agents post routine items under your policy thresholds and send the rest here, each with the why, the evidence and a confidence. <Term id="ek:MakerChecker">Maker-checker</Term> applies: you cannot approve work prepared on your behalf.
          </>
        }
      />
      <Tabs
        label="Inbox views"
        value={tab}
        onChange={(v) => setQuery(route, 'tab', v)}
        items={[
          { value: 'mine', label: 'Waiting for you', count: counts?.mine },
          { value: 'waiting', label: 'All waiting', count: counts?.waiting },
          { value: 'review', label: 'Post-hoc review', count: counts?.review },
          { value: 'auto', label: 'Auto-posted', count: counts?.auto },
          { value: 'decided', label: 'Decided', count: counts?.decided },
        ]}
      />
      <div className="row-wrap">
        <label className="row small" style={{ gap: 6 }}>
          <Filter size={15} aria-hidden className="muted" />
          <span className="sr-only">Filter by kind</span>
          <select className="select" style={{ width: 'auto', minHeight: 34 }} value={kind ?? ''} onChange={(e) => setQuery(route, 'kind', e.target.value || null)}>
            <option value="">All kinds</option>
            {(list.data?.byKind ?? []).map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label} ({k.n})
              </option>
            ))}
          </select>
        </label>
        <input className="input" style={{ maxWidth: 280, minHeight: 34 }} type="search" placeholder="Search titles and reasons" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search proposals" />
        <span className="grow" />
        {decidable && approvable.length > 0 && can('proposal.approve') && (
          <Button size="s" variant="quiet" onClick={() => setSelected(new Set(approvable.map((p) => p.id)))}>
            Select all I can approve ({approvable.length})
          </Button>
        )}
      </div>

      <Card flush>
        {list.isLoading ? (
          <div style={{ padding: 20 }}>
            <Loading rows={6} />
          </div>
        ) : list.isError ? (
          <div style={{ padding: 20 }}>
            <ErrorState error={list.error} retry={() => void list.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <Empty icon={<InboxIcon size={22} />} title={tab === 'mine' ? 'Nothing is waiting for you' : 'Nothing here'}>
            {tab === 'mine' && counts?.waiting ? `${plural(counts.waiting, 'proposal')} wait for someone else, because you prepared them or they need a different role.` : tab === 'mine' ? 'When agents need a decision, it appears here.' : 'Try another view.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="inbox-table">
              <thead>
                <tr>
                  {decidable && (
                    <th scope="col" className="first" style={{ width: 36 }}>
                      <span className="sr-only">Select</span>
                    </th>
                  )}
                  <th scope="col" className={decidable ? '' : 'first'}>
                    Proposal
                  </th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col">Confidence</th>
                  <th scope="col" className="last">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((p, i) => (
                  <tr key={p.id} className={`clickable ${i === cursor ? 'focus-row' : ''}`} aria-selected={selected.has(p.id)} onClick={() => navigate(href(`/inbox/${p.id}`, Object.fromEntries(route.query)))} data-testid="proposal-row">
                    {decidable && (
                      <td className="first" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" className="check" style={{ width: 18, height: 18 }} checked={selected.has(p.id)} disabled={!p.canApprove.ok && !p.canReject.ok} onChange={() => toggle(p.id)} aria-label={`Select ${p.title}`} />
                      </td>
                    )}
                    <td className={decidable ? '' : 'first'} style={{ minWidth: 280 }}>
                      <div className="strong">
                        {p.injectionFlag && <AlertTriangle size={14} color="var(--bad)" aria-label="Flagged" style={{ marginRight: 4 }} />}
                        {p.title}
                      </div>
                      <div className="xs muted" style={{ maxWidth: 560 }}>
                        {p.why.length > 160 ? `${p.why.slice(0, 157)}…` : p.why}
                      </div>
                      <div className="xs muted">
                        <Bot size={12} aria-hidden /> {p.run.taskCode ?? p.skillId}
                        {p.entityCode ? ` · ${p.entityCode}` : ''}
                        {!p.canApprove.ok && decidable && p.canApprove.reasons[0] ? ` · ${p.canApprove.reasons[0]}` : ''}
                      </div>
                    </td>
                    <td>
                      <Badge>{p.kindLabel}</Badge>
                    </td>
                    <td className="num">{p.amount !== null ? <Money cents={p.amount} currency={p.currency ?? 'USD'} /> : <span className="muted">—</span>}</td>
                    <td>
                      <Confidence value={p.confidence} />
                    </td>
                    <td className="last">
                      <div className="row-wrap">
                        <Status value={p.status} />
                        {p.materiality === 'material' && <Status value="material" label="Material" />}
                        {p.reviewStatus === 'sampled' || p.reviewStatus === 'pending_review' ? <Badge tone="accent">Review</Badge> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected.size > 0 && (
        <div className="sticky-actions" role="region" aria-label="Bulk actions">
          <span className="small strong">{selected.size} selected</span>
          <span className="grow" />
          <Button variant="good" icon={<Check size={16} aria-hidden />} busy={decide.isPending} disabled={!selectedApprovable.length} onClick={() => decide.mutate({ ids: selectedApprovable, decision: 'approve' })} data-testid="bulk-approve">
            Approve {selectedApprovable.length || ''}
          </Button>
          <Button icon={<X size={16} aria-hidden />} onClick={() => setRejectIds([...selected])}>
            Reject…
          </Button>
          <Button variant="quiet" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      {rejectIds && <RejectDialog ids={rejectIds} onClose={() => setRejectIds(null)} onDone={() => setSelected(new Set())} />}
      {openId && <ProposalDetail id={openId} onClose={closeDetail} />}
    </div>
  );
}

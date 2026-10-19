/**
 * Flux analysis: month-over-month and budget variances, drivers, and explanations drafted by the
 * agent or written by a person (either way, someone else approves them).
 */
import { Play } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api, ApiError, type FluxData } from '../api';
import { DivergingBars } from '../components/charts';
import { Badge, Drawer, ErrorBox, Loading, Money, ProposalStatus, Segmented, Term } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { pct, periodName } from '../lib/format';
import { setQuery, useRoute } from '../lib/router';

export function Flux() {
  const me = useMe();
  const { period, entityId, setEntityId, toast } = useApp();
  const legal = me.entities.filter((e) => e.kind === 'legal');
  const ent = entityId && legal.some((e) => e.id === entityId) ? entityId : legal[0]!.id;
  const route = useRoute();
  const [scope, setScope] = useState<'significant' | 'all'>('significant');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const textId = useId();
  const { data, error, loading, reload } = useData(() => api<FluxData>(`/flux?entity=${ent}&period=${period}`), [ent, period]);
  const open = route.query.get('account');
  useEffect(() => setText(''), [open]);
  useEffect(() => {
    if (entityId !== ent) setEntityId(ent);
  }, [ent, entityId, setEntityId]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const lines = scope === 'significant' ? data.lines.filter((l) => l.exceeds) : data.lines;
  const sel = data.lines.find((l) => l.code === open) ?? null;
  const waiting = (l: FluxData['lines'][number]) => !!l.proposal && ['pending_approval', 'suggested'].includes(l.proposal.status);
  // significant variances with neither an approved explanation nor a draft waiting for a decision
  const needed = data.lines.filter((l) => l.exceeds && l.explanation?.status !== 'approved' && !waiting(l));

  async function draftWithAgent() {
    setBusy(true);
    try {
      const r = await api<{ ref: string; summary: { headline?: string; proposals?: number } }>('/runs', { body: { skillKey: 'flux-analysis', entityId: ent, periodKey: period } });
      toast(`${r.summary.headline ?? 'The flux agent finished'} (${r.ref}). Drafts are in the inbox for approval.`);
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'The flux agent could not run.', 'bad');
    } finally {
      setBusy(false);
    }
  }
  async function submitExplanation(accountCode: string) {
    setBusy(true);
    try {
      const p = await api<{ ref: string }>('/flux/explanations', { body: { entityId: ent, periodKey: period, accountCode, text } });
      toast(`Explanation submitted as ${p.ref}; someone else approves it.`);
      setText('');
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not submit the explanation.', 'bad');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={loading ? 'skeleton' : undefined}>
      <div className="page-head">
        <div>
          <h1>Flux analysis</h1>
          <p className="lede">
            {periodName(period)} against {periodName(data.comparativeKey)} and budget. A <Term id="tie:VarianceThreshold">significant variance</Term> is at least {(data.thresholds.absMinor / 100).toLocaleString('en-US', { style: 'currency', currency: data.currency, maximumFractionDigits: 0 })}{' '}
            and {(data.thresholds.pct * 100).toFixed(0)}%, or above performance materiality. Each one needs an approved explanation before the period can lock.
          </p>
        </div>
        {needed.length && can(me, 'agent.run') ? (
          <div className="actions">
            <button className="btn primary" disabled={busy} onClick={() => void draftWithAgent()}>
              <Play className="icon" aria-hidden="true" /> {busy ? 'Drafting…' : `Draft ${needed.length} explanation${needed.length === 1 ? '' : 's'}`}
            </button>
          </div>
        ) : null}
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="sr-only" htmlFor="flux-entity">
          Entity
        </label>
        <select id="flux-entity" value={ent} onChange={(e) => setEntityId(e.target.value)}>
          {legal.map((e) => (
            <option key={e.id} value={e.id}>
              {e.code} · {e.name} ({e.currency})
            </option>
          ))}
        </select>
        <Segmented label="Show" value={scope} onChange={setScope} options={[{ value: 'significant', label: `Significant (${data.significant})` }, { value: 'all', label: 'All accounts' }]} />
        <span className="muted">
          {data.explained} of {data.significant} significant variances explained
        </span>
      </div>
      <section className="card">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" className="r">
                  {periodName(period).slice(0, 3)}
                </th>
                <th scope="col" className="r">
                  {periodName(data.comparativeKey).slice(0, 3)}
                </th>
                <th scope="col" className="r">
                  Change
                </th>
                <th scope="col" className="r">
                  %
                </th>
                <th scope="col" className="r hide-sm">
                  Budget
                </th>
                <th scope="col">Explanation</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.code} className="clickable" aria-selected={open === l.code} onClick={() => setQuery('account', l.code)}>
                  <td>
                    <a className="row-link" href={`#/flux?account=${l.code}`} onClick={(e) => { e.preventDefault(); setQuery('account', l.code); }}>
                      <span className="mono">{l.code}</span> {l.name}
                    </a>
                    {l.exceeds ? (
                      <div>
                        <Badge tone={l.materiality === 'material' ? 'bad' : 'warn'} icon={false}>
                          {l.materiality === 'material' ? 'Material' : 'Significant'}
                        </Badge>
                      </div>
                    ) : null}
                  </td>
                  <td className="r">
                    <Money minor={l.currentMinor} currency={data.currency} />
                  </td>
                  <td className="r">
                    <Money minor={l.comparativeMinor} currency={data.currency} />
                  </td>
                  <td className="r">
                    <Money minor={l.varianceMinor} currency={data.currency} signed />
                  </td>
                  <td className="r num">{pct(l.variancePct)}</td>
                  <td className="r hide-sm">{l.budgetMinor === null ? '—' : <Money minor={l.budgetMinor} currency={data.currency} />}</td>
                  <td>
                    {l.explanation ? (
                      <Badge tone={l.explanation.status === 'approved' ? 'good' : 'info'}>{l.explanation.status}</Badge>
                    ) : l.proposal ? (
                      <ProposalStatus status={l.proposal.status} route={l.proposal.route} />
                    ) : l.exceeds ? (
                      <Badge tone="warn">Needed</Badge>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {sel ? (
        <Drawer open onClose={() => setQuery('account', null)} title={`${sel.code} ${sel.name}`} subtitle={`${data.entityCode} · ${periodName(period)} vs ${periodName(data.comparativeKey)}`}>
          <div className="stack">
            <div className="grid cols-3">
              <div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {periodName(period)}
                </div>
                <div style={{ fontSize: 22, fontWeight: 650 }}>
                  <Money minor={sel.currentMinor} currency={data.currency} />
                </div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: 13 }}>
                  Change
                </div>
                <div style={{ fontSize: 22, fontWeight: 650 }}>
                  <Money minor={sel.varianceMinor} currency={data.currency} signed />
                </div>
              </div>
              <div>
                <div className="muted" style={{ fontSize: 13 }}>
                  Against budget
                </div>
                <div style={{ fontSize: 22, fontWeight: 650 }}>{sel.budgetVarianceMinor === null ? '—' : <Money minor={sel.budgetVarianceMinor} currency={data.currency} signed />}</div>
              </div>
            </div>
            <DivergingBars caption="What drove the change" currency={data.currency} totalLabel="Total change" items={sel.drivers.map((d) => ({ label: d.label, value: d.amountMinor, detail: d.detail }))} />
            <p className="muted" style={{ fontSize: 13 }}>
              Drivers add up to the change exactly (<a href="#/ontology?axiom=AX-FLX-02">AX-FLX-02</a>).
            </p>
            {sel.pending.length ? (
              <div className="callout info">
                <div>
                  <strong>Not in the ledger yet</strong>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {sel.pending.map((p) => (
                      <li key={p.proposalId}>
                        <a href={`#/inbox?open=${p.proposalId}`}>{p.proposalRef}</a> {p.label} (<Money minor={p.amountMinor} currency={data.currency} signed />)
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
            {sel.explanation ? (
              <section>
                <h3 style={{ marginBottom: 6 }}>Approved explanation</h3>
                <blockquote className="why-box" style={{ margin: 0 }}>
                  {sel.explanation.text}
                </blockquote>
                <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                  Drafted by {sel.explanationAuthor}; approved by {sel.explanationApprover ?? '—'}.
                </p>
              </section>
            ) : sel.proposal ? (
              <section>
                <h3 style={{ marginBottom: 6 }}>Draft explanation ({sel.proposal.ref})</h3>
                <blockquote className="why-box" style={{ margin: 0 }}>
                  {sel.draftText || sel.proposal.title}
                </blockquote>
                <a className="btn small" href={`#/inbox?open=${sel.proposal.id}`} style={{ marginTop: 8 }}>
                  Review the draft
                </a>
              </section>
            ) : null}
            {sel.exceeds && !sel.explanation && !waiting(sel) ? (
              <section className="stack" style={{ gap: 8 }}>
                <p className="callout warn" style={{ margin: 0 }}>
                  {sel.proposal ? `The last draft was ${sel.proposal.status}.` : 'No explanation yet.'} Draft one with the agent, or write it yourself.
                </p>
                {can(me, 'flux.explain') ? (
                  <>
                    <label className="field" htmlFor={textId}>
                      Your explanation
                      <textarea id={textId} value={text} onChange={(e) => setText(e.target.value)} placeholder="What changed, why, and whether it will happen again." aria-describedby={`${textId}-h`} />
                      <span id={`${textId}-h`} className="hint">
                        At least 20 characters. A different person approves it before it counts toward the lock.
                      </span>
                    </label>
                    <div>
                      <button className="btn primary" disabled={busy || text.trim().length < 20} onClick={() => void submitExplanation(sel.code)}>
                        Submit for approval
                      </button>
                    </div>
                  </>
                ) : null}
              </section>
            ) : null}
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}

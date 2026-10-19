import { Check, Pencil, TrendingDown, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { label, money, pct } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { Badge, Confidence, Empty, ErrorBox, Modal, Skeleton, StatusBadge, Term } from '../components/ui';

interface FluxLine {
  id: string;
  account: string;
  name: string;
  fsLine: string;
  current: number;
  comparison: number;
  variance: number;
  variancePct: number | null;
  material: boolean;
  explanation: string | null;
  status: string;
  drivers: Array<{ kind: string; label: string; amount_minor: number }>;
  confidence: number | null;
  proposalId: string | null;
  explainedBy: string | null;
  reviewedBy: string | null;
}

interface FluxData {
  close: { id: string; name: string; status: string };
  analyses: Array<{ id: string; comparison: string; status: string; thresholdPct: number; thresholdMinor: number; approvedBy: string | null; approvedAt: string | null; canApprove: boolean; lines: FluxLine[] }>;
  canExplain: boolean;
}

export function FluxScreen() {
  const { data, error, reload } = useApi<FluxData>('/api/flux', { pollMs: 8000 });
  const { run, busy } = useAction();
  const [editing, setEditing] = useState<FluxLine | null>(null);
  const [text, setText] = useState('');
  const [showAll, setShowAll] = useState(false);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={8} />;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Flux review</h1>
          <div className="sub">
            {data.close.name}: consolidated <Term id="bh:PeriodOverPeriod">month-over-month</Term> movements. Lines over the <Term id="bh:FluxThreshold">threshold</Term> need a driver-based explanation before the Controller approves.
          </div>
        </div>
      </div>
      {data.analyses.length === 0 && (
        <div className="card">
          <Empty title="No flux analysis yet" icon={<TrendingUp size={26} aria-hidden="true" />}>
            The flux agent runs once the books for the month are complete (after reconciliations, accruals and eliminations).
          </Empty>
        </div>
      )}
      {data.analyses.map((a) => {
        const material = a.lines.filter((l) => l.material);
        const done = material.filter((l) => l.status === 'accepted').length;
        const lines = showAll ? a.lines : material;
        return (
          <section key={a.id} className="card" aria-label={`Flux versus ${label(a.comparison)}`}>
            <div className="card-head">
              <div>
                <h2>Versus {label(a.comparison).toLowerCase()}</h2>
                <div className="small muted">
                  Threshold: {(a.thresholdPct * 100).toFixed(0)}% and {money(a.thresholdMinor, 'USD', { cents: false })} · {done} of {material.length} material variances explained
                </div>
              </div>
              <div className="row-wrap">
                <StatusBadge status={a.status} />
                {a.approvedBy && <span className="small muted">by {a.approvedBy}</span>}
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAll(!showAll)} aria-pressed={showAll}>
                  {showAll ? 'Material only' : 'All lines'}
                </button>
                {a.canApprove && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(() => api.post(`/api/flux/${a.id}/approve`, {}), 'Flux analysis approved.')}>
                    <Check size={14} aria-hidden="true" /> Approve analysis
                  </button>
                )}
              </div>
            </div>
            <ul className="list">
              {lines.map((l) => (
                <li key={l.id} className="flux-line">
                  <div className="row-wrap" style={{ alignItems: 'baseline' }}>
                    <strong className="grow">
                      {l.account} {l.name}
                    </strong>
                    <span className="num small muted">
                      {money(l.comparison, 'USD', { cents: false })} → {money(l.current, 'USD', { cents: false })}
                    </span>
                    <span className="num" style={{ fontWeight: 650 }}>
                      {l.variance > 0 ? <TrendingUp size={14} aria-hidden="true" /> : <TrendingDown size={14} aria-hidden="true" />} {money(l.variance, 'USD', { signed: true, cents: false })} ({pct(l.variancePct)})
                    </span>
                    {l.material ? <StatusBadge status={l.status} text={l.status === 'drafted' ? 'Agent draft' : undefined} /> : <Badge>Below threshold</Badge>}
                  </div>
                  {l.material && (
                    <div className="flux-body">
                      {l.explanation ? <blockquote className="quote">{l.explanation}</blockquote> : <p className="muted small">No explanation yet.</p>}
                      {l.drivers.length > 0 && (
                        <div className="row-wrap" style={{ marginTop: 6 }}>
                          {l.drivers.map((d, i) => (
                            <Badge key={i} tone={d.kind === 'one_time' ? 'attention' : d.kind === 'other' ? '' : 'info'}>
                              {d.label}: {money(d.amount_minor, 'USD', { signed: true, cents: false })}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <div className="row-wrap" style={{ marginTop: 8 }}>
                        {l.confidence !== null && <Confidence value={l.confidence} />}
                        {l.explainedBy && <span className="tiny muted">by {l.explainedBy}</span>}
                        {l.reviewedBy && <span className="tiny muted">· accepted by {l.reviewedBy}</span>}
                        <span className="grow" />
                        {l.status === 'drafted' && l.proposalId && data.canExplain && (
                          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(() => api.post(`/api/proposals/${l.proposalId}/approve`, {}), 'Explanation accepted.')}>
                            <Check size={14} aria-hidden="true" /> Accept draft
                          </button>
                        )}
                        {data.canExplain && a.status !== 'approved' && (
                          <button type="button" className="btn btn-sm" onClick={() => { setEditing(l); setText(l.explanation ?? ''); }}>
                            <Pencil size={14} aria-hidden="true" /> {l.explanation ? 'Rewrite' : 'Write'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {editing && (
        <Modal
          title={`Explain ${editing.account} ${editing.name}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || text.trim().length < 15}
                onClick={async () => {
                  const r = await run(() => api.post(`/api/flux/lines/${editing.id}/explain`, { text }), 'Explanation saved.');
                  if (r) setEditing(null);
                }}
              >
                Save explanation
              </button>
            </>
          }
        >
          <p className="small text-2">
            {money(editing.comparison)} → {money(editing.current)} ({money(editing.variance, 'USD', { signed: true })}). Say what drove the change and whether it recurs. Your explanation replaces the agent's draft.
          </p>
          <label className="sr-only" htmlFor="flux-text">
            Explanation
          </label>
          <textarea id="flux-text" className="textarea" value={text} onChange={(e) => setText(e.target.value)} />
        </Modal>
      )}
    </div>
  );
}

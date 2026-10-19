/** Close package: the period's reporting pack, hashed, reviewable and signed off. */
import { ArrowLeft, Printer, Stamp } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, type PackageData } from '../api';
import { Badge, Dialog, ErrorBox, Loading, Money, Stat } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { dateTime, pct, ROLE_LABEL } from '../lib/format';
import { useRoute } from '../lib/router';

export function Package() {
  const route = useRoute();
  const me = useMe();
  const { toast, bump } = useApp();
  const id = route.path[1] ?? '';
  const { data, error, loading, reload } = useData(() => api<PackageData>(`/packages/${encodeURIComponent(id)}`), [id]);
  const [confirm, setConfirm] = useState(false);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const c = data.content;
  const ccy = c.reportingCurrency;
  const ccyOf = (code: string) => c.entities.find((e) => e.code === code)?.currency ?? ccy;

  async function finalize() {
    try {
      await api(`/packages/${data!.id}/finalize`, { body: {} });
      toast('Package approved and finalized. Your sign-off is bound to its content hash.');
      bump();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not finalize.', 'bad');
    } finally {
      setConfirm(false);
    }
  }

  const statement = (title: string, lines: typeof c.incomeStatement) => (
    <section className="card" aria-label={title}>
      <div className="card-head">
        <h2>{title}</h2>
      </div>
      <div className="table-wrap">
        <table className="data">
          <tbody>
            {lines.map((l) => (
              <tr key={l.code} style={l.isTotal ? { fontWeight: 650, background: 'var(--surface-2)' } : undefined}>
                <td style={{ paddingLeft: l.isTotal ? 12 : 24 }}>{l.label}</td>
                <td className="r">
                  <Money minor={l.amountMinor} currency={ccy} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  return (
    <div className={loading ? 'skeleton' : undefined}>
      <a className="btn ghost small" href="#/close" style={{ marginBottom: 10 }}>
        <ArrowLeft className="icon" aria-hidden="true" /> Close cockpit
      </a>
      <div className="page-head">
        <div>
          <h1>
            {c.periodLabel} close package <span className="muted">v{data.version}</span>
          </h1>
          <p className="lede">
            Consolidated in {ccy}. Generated {dateTime(c.generatedAt)} by {c.generatedBy}. Content hash <span className="mono">{data.content_hash.slice(0, 16)}</span>: approving binds your sign-off to exactly this content.
          </p>
        </div>
        <div className="actions">
          {data.status === 'final' ? <Badge tone="good">Final</Badge> : <Badge tone="warn">Draft</Badge>}
          <button
            className="btn"
            onClick={() => {
              try {
                window.print();
              } catch {
                /* printing unavailable in this frame */
              }
            }}
          >
            <Printer className="icon" aria-hidden="true" /> Print
          </button>
          {data.status === 'draft' && can(me, 'close.package') ? (
            <button className="btn primary" onClick={() => setConfirm(true)}>
              <Stamp className="icon" aria-hidden="true" /> Approve package
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Revenue" value={<Money minor={c.kpis.revenueMinor} currency={ccy} compact />} />
        <Stat label="Gross margin" value={pct(c.kpis.grossMarginPct, 1)} />
        <Stat label="Net income" value={<Money minor={c.kpis.netIncomeMinor} currency={ccy} compact />} />
        <Stat label="Cash" value={<Money minor={c.kpis.cashMinor} currency={ccy} compact />} />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        {statement('Consolidated income statement', c.incomeStatement)}
        {statement('Consolidated balance sheet', c.balanceSheet)}
      </div>

      <section className="card card-pad" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Variance commentary</h2>
        {c.commentary.length ? (
          <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
            {c.commentary.map((m) => (
              <li key={`${m.entityCode}-${m.accountCode}`}>
                <strong>
                  {m.entityCode} {m.accountCode} {m.accountName}
                </strong>{' '}
                (<Money minor={m.varianceMinor} currency={ccyOf(m.entityCode)} signed />
                {m.variancePct === null ? '' : `, ${pct(m.variancePct)}`}): {m.text}
                {m.approvedBy ? <span className="muted"> Approved by {m.approvedBy}.</span> : <span className="muted"> Not yet approved.</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No significant variances.</p>
        )}
      </section>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <section className="card">
          <div className="card-head">
            <h2>Reconciliations</h2>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="r">
                    Unreconciled
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.reconciliations.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.entityCode} · {r.account}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {r.recType.replace(/_/g, ' ')} · prepared by {r.preparer ?? '—'} · reviewed by {r.reviewer ?? '—'}
                      </div>
                    </td>
                    <td>
                      <Badge tone={r.status === 'reviewed' ? 'good' : r.status === 'prepared' ? 'info' : 'warn'}>{r.status}</Badge>
                    </td>
                    <td className="r">
                      <Money minor={r.unreconciledMinor} currency={ccyOf(r.entityCode)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card card-pad stack">
          <h2 style={{ margin: 0 }}>Open items</h2>
          {c.openItems.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {c.openItems.map((o) => (
                <li key={o.ref}>
                  <span className="mono">{o.ref}</span> {o.title} (<Money minor={o.amountMinor} />)
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              None.
            </p>
          )}
          <h2 style={{ margin: '8px 0 0' }}>Agent activity</h2>
          <p style={{ margin: 0 }}>
            {c.agentActivity.runs} runs produced {c.agentActivity.proposals} proposals: {c.agentActivity.approved} approved by people, {c.agentActivity.autoApplied} applied within policy, {c.agentActivity.rejected} rejected. Mode: {c.agentActivity.mode}. Model cost ${(c.agentActivity.costMicros / 1_000_000).toFixed(2)}.
          </p>
          <h2 style={{ margin: '8px 0 0' }}>Sign-offs</h2>
          {data.signoffs.length || c.signoffs.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {c.signoffs.map((s, i) => (
                <li key={`c${i}`}>
                  {ROLE_LABEL[s.role] ?? s.role}: {s.name}, {dateTime(s.at)}
                </li>
              ))}
              {data.signoffs.map((s, i) => (
                <li key={`s${i}`}>
                  <strong>Package approved</strong> by {s.name}, {dateTime(s.at)}: “{s.statement}”
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No sign-offs yet.
            </p>
          )}
        </section>
      </div>

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Approve the close package?"
        actions={
          <>
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void finalize()}>
              Approve and finalize
            </button>
          </>
        }
      >
        <p>
          You are approving version {data.version} of the {c.periodLabel} package. Your sign-off records the content hash <span className="mono">{data.content_hash.slice(0, 16)}…</span>; any later change would need a new version and a new sign-off.
        </p>
      </Dialog>
    </div>
  );
}

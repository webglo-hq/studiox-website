import { ArrowLeft, Check, FileText, Printer, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { footBalanceSheet } from '../../packs/accounting/domain/footing';
import { date, money, pct, recTypeLabel } from '../lib/format';
import { navigate, useAction, useApi } from '../lib/hooks';
import { BalanceSheetTable } from '../components/BalanceSheet';
import { Badge, Empty, ErrorBox, Skeleton, StatusBadge, Term } from '../components/ui';

interface StatementLine {
  key: string;
  label: string;
  section: string;
  amount: number;
}

interface PackageContent {
  close: { name: string; periodEnd: string };
  generatedAt: string;
  reportingCurrency: string;
  statements: {
    balanceSheet: { sections: Array<{ name: string; lines: StatementLine[]; total: number }>; totalAssets: number; totalLiabilities: number; totalEquity: number; currentEarnings: number; balances: boolean };
    incomeStatement: { sections: Array<{ name: string; lines: StatementLine[]; total: number }>; revenue: number; grossProfit: number; operatingIncome: number; netIncome: number };
    consolidatedTb: { totalDebit: number; totalCredit: number; columns: Array<{ code: string; currency: string; cta: number }> };
  };
  entities: Array<{ code: string; currency: string; totalDebit: number; totalCredit: number; balanced: boolean; netIncome: number }>;
  flux: Array<{ account: string; current: number; comparison: number; variance: number; variancePct: number | null; explanation: string | null; status: string }>;
  reconciliations: Array<{ entity: string; account: string; type: string; status: string; difference: number; openItems: number; preparedBy: string | null; reviewedBy: string | null }>;
  exceptions: Array<{ title: string; status: string; amount: number; kind: string }>;
  agentActivity: { runs: number; proposals: number; autoApplied: number; approved: number; rejected: number; pending: number; costUsd: number };
  openBlockers: string[];
  auditChain: { ok: boolean; events: number; headHash: string };
}

interface PackageData {
  close: { id: string; name: string; status: string; periodEnd: string };
  latest: { id: string; version: number; status: string; generatedAt: string; contentHash: string; approvedBy: string | null; approvedAt: string | null; content: PackageContent } | null;
  versions: Array<{ id: string; version: number; status: string; generatedAt: string; contentHash: string }>;
  pendingProposal: { id: string; title: string; why: string } | null;
  canGenerate: boolean;
  canApprove: boolean;
}

/** The income statement as printed: sections and their totals, ending with net income. */
function Statement({ title, sections, currency, bottomLine }: { title: string; sections: Array<{ name: string; lines: StatementLine[]; total: number }>; currency: string; bottomLine: { label: string; amount: number } }) {
  return (
    <div className="card table-wrap">
      <div className="card-head">
        <h3>{title}</h3>
      </div>
      <table className="table">
        <tbody>
          {sections.map((s) => [
            <tr key={s.name} className="section-row">
              <td colSpan={2}>
                <strong>{s.name}</strong>
              </td>
            </tr>,
            ...s.lines.filter((l) => l.amount !== 0).map((l) => (
              <tr key={l.key}>
                <td style={{ paddingLeft: 24 }}>{l.label}</td>
                <td className="num">{money(l.amount, currency, { cents: false })}</td>
              </tr>
            )),
            <tr key={`${s.name}-t`} className="total-row">
              <td>Total {s.name.toLowerCase()}</td>
              <td className="num">{money(s.total, currency, { cents: false })}</td>
            </tr>,
          ])}
          <tr className="total-row grand-row">
            <td>{bottomLine.label}</td>
            <td className="num">{money(bottomLine.amount, currency, { cents: false })}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function PackageScreen({ closeId }: { closeId: string }) {
  const { data, error, reload } = useApi<PackageData>(`/api/closes/${closeId}/package`, { pollMs: 5000 });
  const { run, busy } = useAction();
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={10} />;
  const p = data.latest?.content;
  const cur = p?.reportingCurrency ?? 'USD';
  // Re-foot what is shown: a package generated before current-year earnings sat inside equity says so loudly.
  const foots = p ? footBalanceSheet(p.statements.balanceSheet.sections).foots : true;
  return (
    <div className="stack package" style={{ gap: 16 }}>
      <a href={`#/close/${closeId}`} className="small row no-print">
        <ArrowLeft size={14} aria-hidden="true" /> Back to the close
      </a>
      <div className="page-head">
        <div>
          <div className="row-wrap" style={{ marginBottom: 6 }}>
            {data.latest ? <StatusBadge status={data.latest.status} text={data.latest.status === 'final' ? 'Final' : 'Draft'} /> : <Badge>Not generated</Badge>}
            {data.latest && (
              <span className="small muted">
                v{data.latest.version} · generated {date(data.latest.generatedAt, 'time')} · sha256 <code>{data.latest.contentHash.slice(0, 12)}...</code>
              </span>
            )}
          </div>
          <h1>
            <Term id="bh:ClosePackage">Close package</Term>: {data.close.name.replace(' close', '')}
          </h1>
          {data.latest?.approvedBy && <div className="sub">Approved by {data.latest.approvedBy} on {date(data.latest.approvedAt, 'time')}</div>}
        </div>
        <div className="row-wrap no-print">
          {data.latest && (
            <button type="button" className="btn" onClick={() => window.print()}>
              <Printer size={15} aria-hidden="true" /> Print
            </button>
          )}
          {data.canGenerate && (
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.post(`/api/closes/${closeId}/package`, {}), 'Package generated for approval.')}>
              <RefreshCw size={15} aria-hidden="true" /> {data.latest ? 'Regenerate' : 'Generate'}
            </button>
          )}
          {data.pendingProposal && data.canApprove && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => api.post(`/api/proposals/${data.pendingProposal!.id}/approve`, {}), 'Close package approved.')}>
              <Check size={15} aria-hidden="true" /> Approve package
            </button>
          )}
          {data.pendingProposal && !data.canApprove && (
            <button type="button" className="btn" onClick={() => navigate(`/inbox/${data.pendingProposal!.id}`)}>
              Waiting for approval
            </button>
          )}
        </div>
      </div>
      {!p ? (
        <div className="card">
          <Empty title="No package yet" icon={<FileText size={26} aria-hidden="true" />}>
            The close-package agent assembles it once flux and reconciliations are done; a Senior Accountant or Controller can generate it any time.
          </Empty>
        </div>
      ) : (
        <>
          {p.openBlockers.length > 0 && (
            <div className="callout attention small">
              {data.latest?.status === 'final' ? 'Open when generated: ' : 'This draft cannot be approved until these are finished (then regenerate): '}
              {p.openBlockers.slice(0, 6).join('; ')}
              {p.openBlockers.length > 6 ? `; and ${p.openBlockers.length - 6} more` : ''}
            </div>
          )}
          <section className="grid grid-4">
            <div className="card stat">
              <div className="label">Revenue</div>
              <div className="value">{money(p.statements.incomeStatement.revenue, cur, { compact: true })}</div>
            </div>
            <div className="card stat">
              <div className="label">Net income (month)</div>
              <div className="value">{money(p.statements.incomeStatement.netIncome, cur, { compact: true })}</div>
            </div>
            <div className="card stat">
              <div className="label">Total assets</div>
              <div className="value">{money(p.statements.balanceSheet.totalAssets, cur, { compact: true })}</div>
              <div className={`delta${foots ? '' : ' neg'}`}>{foots ? 'Balance sheet foots' : 'BALANCE SHEET DOES NOT FOOT'}</div>
            </div>
            <div className="card stat">
              <div className="label">Agent work</div>
              <div className="value">{p.agentActivity.proposals}</div>
              <div className="delta">
                {p.agentActivity.autoApplied} auto-applied · {p.agentActivity.approved} approved · {p.agentActivity.rejected} rejected
              </div>
            </div>
          </section>
          <div className="grid grid-2">
            <BalanceSheetTable title="Consolidated balance sheet" sections={p.statements.balanceSheet.sections} currency={cur} heading="h3" />
            <Statement title="Consolidated income statement (month)" sections={p.statements.incomeStatement.sections} currency={cur} bottomLine={{ label: 'Net income', amount: p.statements.incomeStatement.netIncome }} />
          </div>
          <section className="card table-wrap">
            <div className="card-head">
              <h3>Variance commentary</h3>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="num">Variance</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {p.flux.map((f) => (
                  <tr key={f.account}>
                    <td>{f.account}</td>
                    <td className="num">
                      {money(f.variance, cur, { signed: true, cents: false })} ({pct(f.variancePct)})
                    </td>
                    <td className="small">{f.explanation ?? <span className="neg">Missing</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="grid grid-2">
            <section className="card table-wrap">
              <div className="card-head">
                <h3>Reconciliations</h3>
              </div>
              <table className="table">
                <tbody>
                  {p.reconciliations.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <Badge>{r.entity}</Badge> {r.account}
                        <div className="tiny muted">
                          {recTypeLabel(r.type)} · {r.preparedBy ?? '—'} / {r.reviewedBy ?? '—'}
                        </div>
                      </td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card">
              <div className="card-head">
                <h3>Exceptions and controls</h3>
              </div>
              <ul className="list small">
                {p.exceptions.map((e, i) => (
                  <li key={i} className="row">
                    <span className="grow">{e.title}</span>
                    <StatusBadge status={e.status} />
                  </li>
                ))}
                <li>
                  <Term id="bh:AuditEvent">Audit chain</Term>: {p.auditChain.ok ? `intact, ${p.auditChain.events} events` : 'BROKEN'} · head <code>{p.auditChain.headHash.slice(0, 16)}...</code>
                </li>
                <li>
                  Entity trial balances:{' '}
                  {p.entities.map((e) => (
                    <span key={e.code}>
                      {e.code} {e.balanced ? 'balances' : 'OUT OF BALANCE'}{' '}
                    </span>
                  ))}
                </li>
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

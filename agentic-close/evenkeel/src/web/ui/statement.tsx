import { CircleAlert, CircleCheck } from 'lucide-react';
import { Fragment } from 'react';
import type { MethodOutput } from '../../app/methods';
import { money } from '../lib/format';
import { href } from '../lib/router';

type Statement = Omit<MethodOutput<'reports.statement'>, 'comparisonLabel' | 'scope'>;

/** A balance sheet or income statement with optional drill-down to account activity. */
export function StatementTable({ st, scope, comparisonLabel, drill = true }: { st: Statement; scope?: string; comparisonLabel?: string; drill?: boolean }) {
  const cur = st.currency;
  const hasComparison = st.sections.some((s) => s.comparisonTotal !== undefined);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="first" scope="col">
              {st.title}
            </th>
            <th scope="col" className="num">
              Current
            </th>
            {hasComparison && (
              <th scope="col" className="num last">
                {comparisonLabel ?? 'Prior'}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {st.sections.map((sec) => (
            <Fragment key={sec.name}>
              <tr className="section">
                <td className="first" colSpan={hasComparison ? 3 : 2}>
                  {sec.name}
                </td>
              </tr>
              {sec.lines
                .filter((l) => l.amount !== 0 || (l.comparison ?? 0) !== 0)
                .map((l) => (
                  <Fragment key={l.fsLineItemId}>
                    <tr>
                      <td className="first">
                        {l.label}
                        {l.xbrl && <span className="xs muted mono"> · {l.xbrl}</span>}
                      </td>
                      <td className="num">{money(l.amount, cur)}</td>
                      {hasComparison && <td className="num last ink2">{money(l.comparison ?? 0, cur)}</td>}
                    </tr>
                    {drill &&
                      l.accounts
                        .filter((a) => a.amount !== 0)
                        .map((a) => (
                          <tr key={a.accountId} className="indent">
                            <td className="first small" style={{ paddingLeft: 36 }}>
                              <a href={href(`/reports/account/${a.accountId}`, { scope: scope ?? 'consolidated', p: st.periodKey })}>
                                {a.code} {a.name}
                              </a>
                            </td>
                            <td className="num small ink2">{money(a.amount, cur)}</td>
                            {hasComparison && <td className="last" />}
                          </tr>
                        ))}
                  </Fragment>
                ))}
              <tr className="total">
                <td className="first">Total {sec.name.toLowerCase()}</td>
                <td className="num">{money(sec.total, cur)}</td>
                {hasComparison && <td className="num last">{money(sec.comparisonTotal ?? 0, cur)}</td>}
              </tr>
            </Fragment>
          ))}
          {st.subtotals.map((s) => (
            <tr key={s.label} className="total">
              <td className="first" style={{ borderTop: '2px solid var(--line-strong)' }}>
                {s.label}
              </td>
              <td className="num" style={{ borderTop: '2px solid var(--line-strong)' }}>
                {money(s.amount, cur)}
              </td>
              {hasComparison && (
                <td className="num last" style={{ borderTop: '2px solid var(--line-strong)' }}>
                  {money(s.comparison ?? 0, cur)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="small row-wrap" style={{ padding: '10px 20px', gap: 14 }} data-testid="statement-checks">
        <strong>{st.check.label}</strong>
        {st.checks.map((c) => (
          <span key={c.column} className="row" style={{ gap: 6 }} data-column={c.column} data-ok={c.ok}>
            {c.ok ? <CircleCheck size={15} color="var(--good)" aria-hidden /> : <CircleAlert size={15} color="var(--bad)" aria-hidden />}
            <span>
              {c.column === 'current' ? 'Current' : (comparisonLabel ?? 'Prior')}: {c.ok ? 'ties' : `off by ${money(c.difference, cur)}`}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

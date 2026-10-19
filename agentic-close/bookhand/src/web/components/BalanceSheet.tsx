import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { type BalanceSheetSide, footBalanceSheet, sideOf } from '../../packs/accounting/domain/footing';
import { money } from '../lib/format';

export interface BalanceSheetLine {
  key: string;
  label: string;
  amount: number;
  accounts?: Array<{ accountId: string; number: string; name: string; amount: number }>;
}

export interface BalanceSheetSection {
  name: string;
  lines: BalanceSheetLine[];
  total: number;
}

const SIDES: Array<{ side: BalanceSheetSide; total: string | null }> = [
  { side: 'assets', total: 'Total assets' },
  { side: 'liabilities', total: 'Total liabilities' },
  // The Equity section's own total row already reads "Total equity".
  { side: 'equity', total: null },
];

/**
 * A balance sheet as it is printed: assets, liabilities and equity (with current-year earnings), each total, and
 * total liabilities and equity. Every rendering re-foots the very lines it shows and fails loudly when they do
 * not foot: an alert on the page and an error in the console, never a quiet green badge.
 */
export function BalanceSheetTable({ title, sections, currency, onDrill, heading = 'h2' }: { title: string; sections: BalanceSheetSection[]; currency: string; onDrill?: (account: string) => void; heading?: 'h2' | 'h3' }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const footing = footBalanceSheet(sections);
  const failure = footing.foots ? null : `Balance sheet "${title}" does not foot: assets ${footing.assets} vs liabilities and equity ${footing.liabilitiesAndEquity} (minor units)${footing.unclassified.length ? `; unclassified lines: ${footing.unclassified.join(', ')}` : ''}`;
  useEffect(() => {
    if (failure) console.error(failure);
  }, [failure]);
  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const sideOfSection = (s: BalanceSheetSection) => (s.lines[0] ? sideOf(s.lines[0].key) : null);
  const amount = (minor: number) => money(minor, currency, { cents: false });
  const Heading = heading;
  return (
    <section className="card" aria-label={title}>
      <div className="card-head">
        <Heading>{title}</Heading>
        <span className={`small row ${footing.foots ? 'pos' : 'neg'}`} data-testid="bs-footing">
          {footing.foots ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
          {footing.foots ? 'Foots: assets = liabilities + equity' : 'Does not foot'}
        </span>
      </div>
      {!footing.foots && (
        <div className="callout danger small" role="alert" style={{ margin: '0 16px 12px' }}>
          <strong>This balance sheet does not foot.</strong> Total assets {amount(footing.assets)} against total liabilities and equity {amount(footing.liabilitiesAndEquity)}: out by {amount(footing.difference)}.
          {footing.unclassified.length > 0 && <> Lines that are not assets, liabilities or equity: {footing.unclassified.join(', ')}.</>} Do not rely on these numbers; regenerate the statement.
        </div>
      )}
      <div className="table-wrap">
        <table className="table statement">
          <thead>
            <tr>
              <th>Line</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {SIDES.map(({ side, total }) => (
              <Fragment key={side}>
                {sections
                  .filter((s) => sideOfSection(s) === side)
                  .map((s) => (
                    <Fragment key={s.name}>
                      <tr className="section-row">
                        <td colSpan={2}>{s.name}</td>
                      </tr>
                      {s.lines
                        .filter((l) => l.amount !== 0 || (l.accounts?.length ?? 0) > 0 || l.key === 'BS.EQ.CYE')
                        .map((l) => (
                          <Fragment key={l.key}>
                            <tr>
                              <td style={{ paddingLeft: 22 }}>
                                {onDrill && (l.accounts?.length ?? 0) > 0 ? (
                                  <button type="button" className="link-button row" aria-expanded={open.has(l.key)} onClick={() => toggle(l.key)}>
                                    {open.has(l.key) ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                                    {l.label}
                                  </button>
                                ) : (
                                  l.label
                                )}
                              </td>
                              <td className="num">{amount(l.amount)}</td>
                            </tr>
                            {onDrill &&
                              open.has(l.key) &&
                              (l.accounts ?? []).map((a) => (
                                <tr key={a.accountId} className="sub-row">
                                  <td style={{ paddingLeft: 48 }}>
                                    <button type="button" className="link-button" onClick={() => onDrill(a.number)}>
                                      <span className="mono">{a.number}</span> {a.name}
                                    </button>
                                  </td>
                                  <td className="num small">{money(a.amount, currency)}</td>
                                </tr>
                              ))}
                          </Fragment>
                        ))}
                      <tr className="total-row">
                        <td>Total {s.name.toLowerCase()}</td>
                        <td className="num">{amount(s.lines.reduce((t, l) => t + l.amount, 0))}</td>
                      </tr>
                    </Fragment>
                  ))}
                {total && (
                  <tr className="total-row grand-row">
                    <td>{total}</td>
                    <td className="num">{amount(side === 'assets' ? footing.assets : footing.liabilities)}</td>
                  </tr>
                )}
              </Fragment>
            ))}
            <tr className="total-row grand-row">
              <td>Total liabilities and equity</td>
              <td className="num">{amount(footing.liabilitiesAndEquity)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

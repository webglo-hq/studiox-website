import { ChevronDown, ChevronRight, FileSpreadsheet } from 'lucide-react';
import { Fragment, useState } from 'react';
import { footBalanceSheet } from '../../packs/accounting/domain/footing';
import { closeOntology } from '../../packs/accounting/ontology';
import { qs } from '../lib/api';
import { date, label, money } from '../lib/format';
import { navigate, useApi } from '../lib/hooks';
import { periodLabel, periodOptions, useReference } from '../lib/reference';
import { BalanceSheetTable } from '../components/BalanceSheet';
import { Badge, Drawer, Empty, ErrorBox, Skeleton, Tabs, Term } from '../components/ui';

interface TbRow {
  accountId: string;
  number: string;
  name: string;
  accountClass: string;
  normalBalance: 'debit' | 'credit';
  subtype: string;
  fsLine: string;
  net: number;
  debit: number;
  credit: number;
  balance: number;
}

interface TrialBalance {
  label: string;
  currency: string;
  mode: 'balance' | 'activity';
  periodName: string;
  period: string;
  rows: TbRow[];
  totalDebit: number;
  totalCredit: number;
  columns?: Array<{ code: string; currency: string; kind: string; rates?: { closing: number; historical: number }; cta: number }>;
  byColumn?: Record<string, Record<string, number>>;
}

interface StatementLine {
  key: string;
  label: string;
  section: string;
  amount: number;
  accounts: Array<{ accountId: string; number: string; name: string; amount: number }>;
}

interface Statement {
  sections: Array<{ name: string; lines: StatementLine[]; total: number }>;
}

interface Statements {
  balanceSheet: Statement & { totalAssets: number; totalLiabilities: number; totalEquity: number; currentEarnings: number; totalLiabilitiesAndEquity: number; balances: boolean };
  incomeStatement: Statement & { revenue: number; grossProfit: number; operatingIncome: number; netIncome: number };
  incomeStatementYtd: Statement & { revenue: number; grossProfit: number; operatingIncome: number; netIncome: number };
  currency: string;
  period: string;
  label: string;
}

interface Activity {
  account: { number: string; name: string; subtype: string; normalBalance: string; fsLine: string; definition: string | null };
  period: string;
  lines: Array<{ lineId: string; entryId: string; entryNumber: string; entity: string; currency: string; date: string; description: string; memo: string | null; debit: number; credit: number; department: string | null; type: string }>;
}

type View = 'tb' | 'bs' | 'is';

export function ReportsScreen({ query }: { query: URLSearchParams }) {
  const ref = useReference();
  const view = (query.get('view') as View | null) ?? 'tb';
  const entity = query.get('entity') ?? 'consolidated';
  const period = query.get('period') ?? ref.data?.period ?? '';
  const mode = query.get('mode') === 'activity' ? 'activity' : 'balance';
  const [drill, setDrill] = useState<{ account: string; entity: string } | null>(null);
  const set = (key: string, value: string) => {
    const p = new URLSearchParams(query);
    p.set(key, value);
    navigate(`/reports?${p.toString()}`);
  };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Statements and trial balance</h1>
          <div className="sub">
            Live from posted entries. The consolidated view translates each entity under <Term id="bh:Consolidation">consolidation</Term> rules and nets <Term id="bh:Elimination">eliminations</Term>. Click any account to see the entries behind it.
          </div>
        </div>
      </div>
      <div className="row-wrap report-controls">
        <div className="field">
          <label htmlFor="rp-entity">Entity</label>
          <select id="rp-entity" className="select" value={entity} onChange={(e) => set('entity', e.target.value)}>
            <option value="consolidated">Consolidated (USD)</option>
            {ref.data?.entities
              .filter((e) => e.kind !== 'elimination')
              .map((e) => (
                <option key={e.id} value={e.code}>
                  {e.code} · {e.name} ({e.currency})
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rp-period">Period</label>
          <select id="rp-period" className="select" value={period} onChange={(e) => set('period', e.target.value)}>
            {periodOptions(ref.data?.period ?? null).map((p) => (
              <option key={p} value={p}>
                {periodLabel(p)}
                {p === ref.data?.period ? ' (open)' : ''}
              </option>
            ))}
          </select>
        </div>
        {view === 'tb' && (
          <div className="field">
            <label htmlFor="rp-mode">Amounts</label>
            <select id="rp-mode" className="select" value={mode} onChange={(e) => set('mode', e.target.value)}>
              <option value="balance">Balances at period end</option>
              <option value="activity">Activity in the period</option>
            </select>
          </div>
        )}
      </div>
      <Tabs<View>
        label="Report"
        value={view}
        onChange={(v) => set('view', v)}
        tabs={[
          { id: 'tb', label: 'Trial balance' },
          { id: 'bs', label: 'Balance sheet' },
          { id: 'is', label: 'Income statement' },
        ]}
      />
      {ref.error && <ErrorBox error={ref.error} onRetry={ref.reload} />}
      {period && view === 'tb' && <TbView entity={entity} period={period} mode={mode} onDrill={(account, ent) => setDrill({ account, entity: ent })} />}
      {period && view !== 'tb' && <StatementsView view={view} entity={entity} period={period} onDrill={(account) => setDrill({ account, entity })} />}
      {drill && <ActivityDrawer account={drill.account} entity={drill.entity} period={period} onClose={() => setDrill(null)} />}
    </div>
  );
}

function TbView({ entity, period, mode, onDrill }: { entity: string; period: string; mode: string; onDrill: (account: string, entity: string) => void }) {
  const { data, error, reload } = useApi<TrialBalance>(`/api/reports/trial-balance${qs({ entity, period, mode })}`);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={12} />;
  const cols = data.columns ?? [];
  const consolidated = cols.length > 0;
  const balanced = data.totalDebit === data.totalCredit;
  if (!data.rows.length)
    return (
      <div className="card">
        <Empty title="Nothing posted" icon={<FileSpreadsheet size={26} aria-hidden="true" />}>
          No posted activity for {data.label} in {data.periodName}.
        </Empty>
      </div>
    );
  return (
    <section className="card" aria-label="Trial balance">
      <div className="card-head">
        <div>
          <h2>
            {data.label} trial balance · {data.periodName}
          </h2>
          <div className="small muted">
            {mode === 'activity' ? 'Postings in the period' : 'Balance sheet cumulative, income statement year to date'} · {data.currency}
            {consolidated && cols.some((c) => c.rates) && ' · foreign entities translated (assets and liabilities at closing rate, P&L at average, equity at historical; difference to CTA)'}
          </div>
        </div>
        <Badge tone={balanced ? 'success' : 'danger'}>{balanced ? 'Debits equal credits' : 'OUT OF BALANCE'}</Badge>
      </div>
      <div className="table-wrap tb-wrap">
        <table className="table tb">
          <thead>
            <tr>
              <th>Account</th>
              {consolidated &&
                cols.map((c) => (
                  <th key={c.code} className="num hide-sm" title={c.rates ? `Closing ${c.rates.closing.toFixed(4)} · historical ${c.rates.historical.toFixed(4)}` : undefined}>
                    {c.code}
                  </th>
                ))}
              <th className="num">Debit</th>
              <th className="num">Credit</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.accountId} className="clickable" onClick={() => onDrill(r.number, entity)}>
                <td>
                  <button type="button" className="link-button" onClick={(e) => { e.stopPropagation(); onDrill(r.number, entity); }}>
                    <span className="mono">{r.number}</span> {r.name}
                  </button>
                  <div className="tiny muted">
                    <Term id={r.subtype}>{label(r.accountClass)}</Term>
                  </div>
                </td>
                {consolidated &&
                  cols.map((c) => (
                    <td key={c.code} className="num small muted hide-sm">
                      {data.byColumn?.[r.accountId]?.[c.code] ? money(data.byColumn[r.accountId]![c.code]!, data.currency, { cents: false }) : ''}
                    </td>
                  ))}
                <td className="num">{r.debit ? money(r.debit, data.currency) : ''}</td>
                <td className="num">{r.credit ? money(r.credit, data.currency) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              {consolidated &&
                cols.map((c) => (
                  <td key={c.code} className="num small hide-sm">
                    {c.cta ? <span title="Cumulative translation adjustment">CTA {money(c.cta, data.currency, { cents: false })}</span> : ''}
                  </td>
                ))}
              <td className="num">{money(data.totalDebit, data.currency)}</td>
              <td className="num">{money(data.totalCredit, data.currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function StatementsView({ view, entity, period, onDrill }: { view: 'bs' | 'is'; entity: string; period: string; onDrill: (account: string) => void }) {
  const { data, error, reload } = useApi<Statements>(`/api/reports/statements${qs({ entity, period })}`);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton rows={12} />;
  const cur = data.currency;
  if (view === 'bs') {
    const bs = data.balanceSheet;
    const footing = footBalanceSheet(bs.sections);
    return (
      <div className="stack">
        <div className="grid grid-4">
          <div className="card stat">
            <div className="label">Total assets</div>
            <div className="value">{money(bs.totalAssets, cur, { compact: true })}</div>
          </div>
          <div className="card stat">
            <div className="label">Total liabilities</div>
            <div className="value">{money(bs.totalLiabilities, cur, { compact: true })}</div>
          </div>
          <div className="card stat">
            <div className="label">Total equity</div>
            <div className="value">{money(footing.equity, cur, { compact: true })}</div>
            <div className="delta">incl. current-year earnings {money(bs.currentEarnings, cur, { compact: true })}</div>
          </div>
          <div className="card stat">
            <div className="label">Check</div>
            <div className="value" style={{ fontSize: 18, marginTop: 10 }}>
              <Badge tone={footing.foots ? 'success' : 'danger'}>{footing.foots ? 'Assets = liabilities + equity' : 'Does not foot'}</Badge>
            </div>
          </div>
        </div>
        <BalanceSheetTable title={`${data.label} balance sheet · ${periodLabel(data.period)}`} sections={bs.sections} currency={cur} onDrill={onDrill} />
      </div>
    );
  }
  const is = data.incomeStatement;
  const ytd = data.incomeStatementYtd;
  return (
    <div className="stack">
      <div className="grid grid-4">
        <div className="card stat">
          <div className="label">Revenue</div>
          <div className="value">{money(is.revenue, cur, { compact: true })}</div>
          <div className="delta">YTD {money(ytd.revenue, cur, { compact: true })}</div>
        </div>
        <div className="card stat">
          <div className="label">Gross profit</div>
          <div className="value">{money(is.grossProfit, cur, { compact: true })}</div>
          <div className="delta">{is.revenue ? `${((is.grossProfit / is.revenue) * 100).toFixed(1)}% margin` : '—'}</div>
        </div>
        <div className="card stat">
          <div className="label">Operating income</div>
          <div className="value">{money(is.operatingIncome, cur, { compact: true })}</div>
          <div className="delta">YTD {money(ytd.operatingIncome, cur, { compact: true })}</div>
        </div>
        <div className="card stat">
          <div className="label">Net income</div>
          <div className="value">{money(is.netIncome, cur, { compact: true })}</div>
          <div className="delta">YTD {money(ytd.netIncome, cur, { compact: true })}</div>
        </div>
      </div>
      <StatementTable title={`${data.label} income statement · ${periodLabel(data.period)}`} statement={is} ytd={ytd} currency={cur} onDrill={onDrill} extra={[{ label: 'Net income', amount: is.netIncome, ytd: ytd.netIncome }]} />
    </div>
  );
}

function StatementTable({ title, statement, ytd, currency, onDrill, extra }: { title: string; statement: Statement; ytd?: Statement; currency: string; onDrill: (account: string) => void; extra: Array<{ label: string; amount: number; ytd?: number }> }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const ytdLine = (key: string) => ytd?.sections.flatMap((s) => s.lines).find((l) => l.key === key)?.amount ?? 0;
  const ytdSection = (name: string) => ytd?.sections.find((s) => s.name === name)?.total ?? 0;
  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  return (
    <section className="card" aria-label={title}>
      <div className="card-head">
        <h2>{title}</h2>
        <span className="small muted">{currency} · click a line to see its accounts</span>
      </div>
      <div className="table-wrap">
        <table className="table statement">
          <thead>
            <tr>
              <th>Line</th>
              <th className="num">{ytd ? 'Month' : 'Amount'}</th>
              {ytd && <th className="num">Year to date</th>}
            </tr>
          </thead>
          <tbody>
            {statement.sections.map((s) => (
              <Fragment key={s.name}>
                <tr className="section-row">
                  <td colSpan={ytd ? 3 : 2}>{s.name}</td>
                </tr>
                {s.lines
                  .filter((l) => l.amount !== 0 || l.accounts.length > 0 || (ytd && ytdLine(l.key) !== 0))
                  .map((l) => (
                    <Fragment key={l.key}>
                      <tr>
                        <td style={{ paddingLeft: 22 }}>
                          <button type="button" className="link-button row" aria-expanded={open.has(l.key)} onClick={() => toggle(l.key)}>
                            {open.has(l.key) ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                            {l.label}
                          </button>
                        </td>
                        <td className="num">{money(l.amount, currency, { cents: false })}</td>
                        {ytd && <td className="num muted">{money(ytdLine(l.key), currency, { cents: false })}</td>}
                      </tr>
                      {open.has(l.key) &&
                        l.accounts.map((a) => (
                          <tr key={a.accountId} className="sub-row">
                            <td style={{ paddingLeft: 48 }}>
                              <button type="button" className="link-button" onClick={() => onDrill(a.number)}>
                                <span className="mono">{a.number}</span> {a.name}
                              </button>
                            </td>
                            <td className="num small">{money(a.amount, currency)}</td>
                            {ytd && <td />}
                          </tr>
                        ))}
                    </Fragment>
                  ))}
                <tr className="total-row">
                  <td>Total {s.name.toLowerCase()}</td>
                  <td className="num">{money(s.total, currency, { cents: false })}</td>
                  {ytd && <td className="num">{money(ytdSection(s.name), currency, { cents: false })}</td>}
                </tr>
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            {extra.map((x) => (
              <tr key={x.label}>
                <td>{x.label}</td>
                <td className="num">{money(x.amount, currency, { cents: false })}</td>
                {ytd && <td className="num">{x.ytd !== undefined ? money(x.ytd, currency, { cents: false }) : ''}</td>}
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function ActivityDrawer({ account, entity, period, onClose }: { account: string; entity: string; period: string; onClose: () => void }) {
  const { data, error, reload } = useApi<Activity>(`/api/reports/activity${qs({ account, entity, period })}`);
  const totals = data ? data.lines.reduce((t, l) => ({ d: t.d + l.debit, c: t.c + l.credit }), { d: 0, c: 0 }) : null;
  const currencies = data ? [...new Set(data.lines.map((l) => l.currency))] : [];
  const single = currencies.length <= 1 ? currencies[0] ?? 'USD' : null;
  return (
    <Drawer
      title={data ? `${data.account.number} ${data.account.name}` : `Account ${account}`}
      subtitle={data ? `${entity === 'consolidated' ? 'All entities' : entity} · ${periodLabel(data.period)} · posted activity` : undefined}
      onClose={onClose}
      footer={
        <a className="btn" href={`#/ledger?account=${encodeURIComponent(account)}&period=${period}${entity !== 'consolidated' ? `&entity=${encodeURIComponent(entity)}` : ''}`}>
          Open in journal entries
        </a>
      }
    >
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Skeleton rows={8} />}
      {data && (
        <div className="stack" style={{ gap: 14 }}>
          {data.account.definition && (
            <div className="callout small">
              <strong>
                <Term id={data.account.subtype}>{closeOntology.term(data.account.subtype)?.label ?? data.account.subtype}</Term>
              </strong>
              : {data.account.definition} Normal balance: {data.account.normalBalance}.
            </div>
          )}
          {data.lines.length === 0 ? (
            <Empty title="No activity">Nothing posted to this account in the period.</Empty>
          ) : (
            <div className="table-wrap card">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Entry</th>
                    <th className="num">Debit</th>
                    <th className="num">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.lineId}>
                      <td className="nowrap">{date(l.date)}</td>
                      <td>
                        <a href={`#/ledger/${l.entryId}`} className="mono">
                          {l.entryNumber}
                        </a>{' '}
                        <Badge>{l.entity}</Badge>
                        <div className="small">{l.description}</div>
                        {l.memo && l.memo !== l.description && <div className="tiny muted">{l.memo}</div>}
                      </td>
                      <td className="num">{l.debit ? money(l.debit, l.currency) : ''}</td>
                      <td className="num">{l.credit ? money(l.credit, l.currency) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                {totals && single && (
                  <tfoot>
                    <tr>
                      <td colSpan={2}>Net {money(totals.d - totals.c, single, { signed: true })}</td>
                      <td className="num">{money(totals.d, single)}</td>
                      <td className="num">{money(totals.c, single)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          {!single && <p className="tiny muted">Amounts are in each entity&apos;s functional currency ({currencies.join(', ')}).</p>}
        </div>
      )}
    </Drawer>
  );
}

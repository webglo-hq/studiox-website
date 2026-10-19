/** Trial balance per entity and financial statements per entity or consolidated (ASC 830/810). */
import { api, qs, type Statements, type TrialBalance } from '../api';
import { Badge, ErrorBox, Loading, Money, Segmented, Term } from '../components/ui';
import { useApp, useData, useMe } from '../lib/app-state';
import { date, periodName } from '../lib/format';
import { setQuery, useRoute } from '../lib/router';

export function Reports() {
  const me = useMe();
  const { period } = useApp();
  const route = useRoute();
  const view = (route.query.get('view') as 'tb' | 'fs' | null) ?? 'fs';
  const scope = route.query.get('scope') ?? 'consolidated';
  const tbEntity = route.query.get('entity') ?? me.entities[0]!.id;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Trial balance & statements</h1>
          <p className="lede">
            Posted balances only. The consolidated view translates the UK subsidiary at closing (balance sheet) and average (income statement) rates, adds the elimination ledger, and balances through the{' '}
            <Term id="tie:CumulativeTranslationAdjustment">cumulative translation adjustment</Term>.
          </p>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <Segmented label="Report" value={view} onChange={(v) => setQuery('view', v)} options={[{ value: 'fs', label: 'Financial statements' }, { value: 'tb', label: 'Trial balance' }]} />
        {view === 'fs' ? (
          <>
            <label className="sr-only" htmlFor="fs-scope">
              Scope
            </label>
            <select id="fs-scope" value={scope} onChange={(e) => setQuery('scope', e.target.value)}>
              <option value="consolidated">Consolidated (USD)</option>
              {me.entities
                .filter((e) => e.kind === 'legal')
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code} ({e.currency})
                  </option>
                ))}
            </select>
          </>
        ) : (
          <>
            <label className="sr-only" htmlFor="tb-ent">
              Entity
            </label>
            <select id="tb-ent" value={tbEntity} onChange={(e) => setQuery('entity', e.target.value)}>
              {me.entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.code} · {e.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {view === 'tb' ? <TB entity={tbEntity} period={period} /> : <FS scope={scope} period={period} />}
    </div>
  );
}

function TB({ entity, period }: { entity: string; period: string }) {
  const { data, error, loading, reload } = useData(() => api<TrialBalance>(`/reports/tb${qs({ entity, period })}`), [entity, period]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const ccy = data.entity.functional_currency;
  return (
    <section className={`card${loading ? ' skeleton' : ''}`} aria-label="Trial balance">
      <div className="card-head">
        <h2>
          {data.entity.code} trial balance at {date(data.asOf, true)}
        </h2>
        <span className="right">{data.balanced ? <Badge tone="good">Debits = credits</Badge> : <Badge tone="bad">Out of balance</Badge>}</span>
      </div>
      <div className="table-wrap" style={{ maxHeight: '70vh' }}>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Class</th>
              <th scope="col" className="r">
                Debit
              </th>
              <th scope="col" className="r">
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.accountId}>
                <td>
                  <a className="row-link" href={`#/journal?entity=${data.entity.id}&q=`}>
                    <span className="mono">{r.code}</span> {r.name}
                  </a>
                </td>
                <td className="muted">{r.accountClass}</td>
                <td className="r">{r.debitMinor ? <Money minor={r.debitMinor} currency={ccy} /> : ''}</td>
                <td className="r">{r.creditMinor ? <Money minor={r.creditMinor} currency={ccy} /> : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Total</td>
              <td className="r">
                <Money minor={data.totalDebitMinor} currency={ccy} />
              </td>
              <td className="r">
                <Money minor={data.totalCreditMinor} currency={ccy} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function FS({ scope, period }: { scope: string; period: string }) {
  const { data, error, loading, reload } = useData(() => api<Statements>(`/reports/statements${qs({ entity: scope, period })}`), [scope, period]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const ccy = data.currency;
  const block = (title: string, lines: Statements['balanceSheet'], showPrior: boolean) => (
    <section className="card" aria-label={title}>
      <div className="card-head">
        <h2>{title}</h2>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col" className="r">
                {periodName(period)}
              </th>
              {showPrior ? (
                <th scope="col" className="r">
                  Prior
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.code} style={l.isTotal ? { fontWeight: 650, background: 'var(--surface-2)' } : undefined}>
                <td style={{ paddingLeft: l.isTotal ? 12 : 24 }} title={l.xbrl}>
                  {l.label}
                </td>
                <td className="r">
                  <Money minor={l.amountMinor} currency={ccy} />
                </td>
                {showPrior ? <td className="r">{l.priorMinor === undefined ? '' : <Money minor={l.priorMinor} currency={ccy} />}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
  return (
    <div className={`stack${loading ? ' skeleton' : ''}`}>
      <div className="row">
        {data.checks.balanced ? <Badge tone="good">Balance sheet balances</Badge> : <Badge tone="bad">Out of balance by {(data.checks.differenceMinor / 100).toFixed(2)}</Badge>}
        {data.consolidation ? (
          <span className="muted" style={{ fontSize: 13 }}>
            GBP/USD closing {data.consolidation.closingRate} · average {data.consolidation.averageRate?.toFixed(6)} · CTA <Money minor={data.consolidation.ctaMinor} /> · eliminations <Money minor={data.consolidation.eliminationsMinor} />
          </span>
        ) : null}
      </div>
      <div className="grid cols-2">
        {block('Income statement (month)', data.incomeStatement, data.scope !== 'consolidated')}
        {block('Balance sheet', data.balanceSheet, data.scope !== 'consolidated')}
      </div>
    </div>
  );
}

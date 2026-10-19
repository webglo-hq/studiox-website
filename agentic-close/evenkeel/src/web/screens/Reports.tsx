import { ArrowLeft, CircleAlert, CircleCheck, FileText } from 'lucide-react';
import { useApi } from '../lib/api';
import { date, humanize, money, period, plural, when } from '../lib/format';
import { href, setQuery, type Route } from '../lib/router';
import { Badge, Button, Card, Empty, Kv, LinkButton, Notice, PageHead, Query, Seg } from '../ui/kit';
import { StatementTable } from '../ui/statement';
import { Term } from '../ui/term';

type Scope = 'consolidated' | 'US' | 'UK' | 'CONSOL';

export function Reports({ route }: { route: Route }) {
  if (route.path[1] === 'account' && route.path[2]) return <AccountActivity route={route} accountId={route.path[2]} />;
  const view = (route.query.get('view') as 'tb' | 'bs' | 'is' | null) ?? 'is';
  const scope = (route.query.get('scope') as Scope | null) ?? 'consolidated';
  return (
    <div className="page">
      <PageHead
        eyebrow="Ledger"
        title="Statements and trial balance"
        sub={
          <>
            Built live from posted entries. Consolidated figures translate Kitewell UK from GBP (<Term id="ek:Translation">translation</Term>) and remove intercompany balances (<Term id="ek:EliminationEntry">eliminations</Term>). Select any account to see the entries behind it.
          </>
        }
        actions={
          <div className="row-wrap">
            <Seg
              label="Report"
              value={view}
              onChange={(v) => setQuery(route, 'view', v)}
              items={[
                { value: 'is', label: 'Income statement' },
                { value: 'bs', label: 'Balance sheet' },
                { value: 'tb', label: 'Trial balance' },
              ]}
            />
            <Seg
              label="Scope"
              value={scope}
              onChange={(v) => setQuery(route, 'scope', v)}
              items={[
                { value: 'consolidated', label: 'Consolidated' },
                { value: 'US', label: 'US' },
                { value: 'UK', label: 'UK' },
              ]}
            />
          </div>
        }
      />
      {view === 'tb' ? <TrialBalance scope={scope} /> : <Statement kind={view === 'bs' ? 'BS' : 'IS'} scope={scope} />}
    </div>
  );
}

function Statement({ kind, scope }: { kind: 'BS' | 'IS'; scope: Scope }) {
  const q = useApi('reports.statement', { kind, scope }, { keepPrevious: true });
  return (
    <Card flush>
      <Query q={q} rows={12}>
        {(st) => <StatementTable st={st} scope={scope} comparisonLabel={period(st.comparisonLabel, 'short')} />}
      </Query>
    </Card>
  );
}

function TrialBalance({ scope }: { scope: Scope }) {
  const q = useApi('reports.trialBalance', { scope }, { keepPrevious: true });
  return (
    <Query q={q} rows={12}>
      {(tb) => (
        <>
          <Notice tone={tb.balanced ? 'good' : 'bad'} title={tb.balanced ? 'Debits equal credits' : 'The trial balance does not balance'}>
            <Term id={tb.axiom.id}>{tb.axiom.id}</Term> · total debits {money(tb.totals.debit, tb.currency)} and credits {money(tb.totals.credit, tb.currency)} {tb.balanced ? 'agree.' : `differ by ${money(tb.totals.debit - tb.totals.credit, tb.currency)}.`}
          </Notice>
          {tb.translation && tb.translation.length > 0 && (
            <p className="small ink2">
              Translation: {tb.translation.map((t) => `${t.entityCode} at closing ${t.closingRate} (${t.averageRateNote}); CTA ${money(t.cta, tb.currency)}`).join(' · ')}
            </p>
          )}
          <Card flush>
            <div className="table-wrap">
              <table className="table" data-testid="tb-table">
                <thead>
                  <tr>
                    <th className="first" scope="col">
                      Account
                    </th>
                    <th scope="col">Statement line</th>
                    <th scope="col" className="num">
                      Debit
                    </th>
                    <th scope="col" className="num last">
                      Credit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tb.rows.map((r) => (
                    <tr key={r.accountId}>
                      <td className="first">
                        <a href={href(`/reports/account/${r.accountId}`, { scope, p: tb.periodKey })}>
                          {r.code} {r.name}
                        </a>
                        <div className="xs muted">
                          {humanize(r.accountClass)} · normal {r.normalBalance}
                        </div>
                      </td>
                      <td className="small ink2">{r.fsLine}</td>
                      <td className="num">{r.debit ? money(r.debit, tb.currency) : ''}</td>
                      <td className="num last">{r.credit ? money(r.credit, tb.currency) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="first" colSpan={2}>
                      Totals
                    </td>
                    <td className="num">{money(tb.totals.debit, tb.currency)}</td>
                    <td className="num last">{money(tb.totals.credit, tb.currency)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </>
      )}
    </Query>
  );
}

function AccountActivity({ route, accountId }: { route: Route; accountId: string }) {
  const scope = (route.query.get('scope') as Scope | null) ?? 'consolidated';
  const ytd = route.query.get('ytd') === '1';
  const p = route.query.get('p') ?? undefined;
  const q = useApi('reports.activity', { accountId, scope, periodKey: p, ytd });
  return (
    <div className="page">
      <div>
        <LinkButton href={href('/reports', { scope })} variant="quiet" size="s" icon={<ArrowLeft size={14} aria-hidden />}>
          Statements
        </LinkButton>
      </div>
      <Query q={q} rows={10}>
        {(a) => (
          <>
            <PageHead
              eyebrow={`Account drill-down · ${scope === 'consolidated' ? 'all entities' : scope} · ${ytd ? 'year to date' : period(a.periodKey)}`}
              title={`${a.account.code} ${a.account.name}`}
              sub={
                <>
                  Normal balance: {a.account.normalBalance}.{a.account.concept && <> Concept: <Term id={a.account.concept}>{a.account.concept}</Term>.</>} Every line links to its entry and to the record it came from.
                </>
              }
              actions={
                <Seg
                  label="Range"
                  value={ytd ? 'ytd' : 'month'}
                  onChange={(v) => setQuery(route, 'ytd', v === 'ytd' ? '1' : null)}
                  items={[
                    { value: 'month', label: 'This month' },
                    { value: 'ytd', label: 'Year to date' },
                  ]}
                />
              }
            />
            <div className="grid grid-3">
              <div className="card stat">
                <span className="label">Debits</span>
                <span className="value">{money(a.totals.debit)}</span>
              </div>
              <div className="card stat">
                <span className="label">Credits</span>
                <span className="value">{money(a.totals.credit)}</span>
              </div>
              <div className="card stat">
                <span className="label">Net</span>
                <span className="value">{money(a.totals.net)}</span>
              </div>
            </div>
            <Card title={plural(a.lines.length, 'line')} hint={a.truncated ? 'Showing the first lines only' : undefined} flush>
              {a.lines.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th className="first" scope="col">
                          Entry
                        </th>
                        <th scope="col">Source record</th>
                        <th scope="col">Prepared → approved</th>
                        <th scope="col" className="num">
                          Debit
                        </th>
                        <th scope="col" className="num last">
                          Credit
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.lines.map((l) => (
                        <tr key={l.lineId}>
                          <td className="first" style={{ minWidth: 240 }}>
                            <a href={href(`/journals/${l.entryId}`)} className="mono small">
                              {l.entryNumber}
                            </a>{' '}
                            <span className="xs muted">
                              {date(l.date, 'short')} · {l.entityCode} · {humanize(l.type)}
                            </span>
                            <div className="small">{l.memo}</div>
                          </td>
                          <td className="small">{l.record ? <a href={href(`/records/${l.record.type}/${l.record.id}`)}>{l.record.label}</a> : <span className="muted">{humanize(l.source)}</span>}</td>
                          <td className="xs">
                            {l.preparedBy ?? '—'} → {l.approvedBy ?? '—'}
                          </td>
                          <td className="num">{l.debit ? money(l.debit) : ''}</td>
                          <td className="num last">{l.credit ? money(l.credit) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="No activity" />
              )}
            </Card>
          </>
        )}
      </Query>
    </div>
  );
}

function fieldValue(k: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number' && /amount|total|cost|salvage|gross|net|tax|balance/.test(k)) return money(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function SourceRecordPage({ type, id }: { type: string; id: string }) {
  const q = useApi('reports.record', { type, id });
  return (
    <div className="page">
      <div>
        <Button variant="quiet" size="s" icon={<ArrowLeft size={14} aria-hidden />} onClick={() => window.history.back()}>
          Back
        </Button>
      </div>
      <Query q={q} rows={8}>
        {(r) => (
          <>
            <PageHead eyebrow={`Source record · ${humanize(r.type)}`} title={r.label} sub="The record an entry came from, with the document it was imported from." />
            <div className="grid grid-main">
              <Card title="Fields">
                <Kv items={Object.entries(r.fields).filter(([k]) => !['id', 'source_document_id', 'source_line'].includes(k)).map(([k, v]) => [humanize(k), fieldValue(k, v)])} />
              </Card>
              <Card title="Provenance">
                {r.document ? (
                  <div className="stack">
                    <Kv items={[['File', r.document.filename], ['Received', when(r.document.receivedAt)], ['SHA-256', <span key="s" className="mono xs">{r.document.sha256.slice(0, 24)}…</span>], ...(r.document.line ? ([['Line in file', <code key="l">{r.document.line.slice(0, 200)}</code>]] as [string, React.ReactNode][]) : [])]} />
                    <LinkButton href={href(`/documents/${r.document.id}`)} size="s" icon={<FileText size={14} aria-hidden />}>
                      Open the document
                    </LinkButton>
                  </div>
                ) : (
                  <p className="small muted">Created in Evenkeel (no imported document).</p>
                )}
              </Card>
            </div>
          </>
        )}
      </Query>
    </div>
  );
}

export function SourceDocumentPage({ id }: { id: string }) {
  const q = useApi('reports.document', { id });
  return (
    <div className="page">
      <div>
        <Button variant="quiet" size="s" icon={<ArrowLeft size={14} aria-hidden />} onClick={() => window.history.back()}>
          Back
        </Button>
      </div>
      <Query q={q} rows={8}>
        {(d) => (
          <>
            <PageHead eyebrow={`Source document${d.connector ? ` · ${d.connector.name}` : ''}`} title={d.filename} sub="Imported files are stored exactly as received and hashed; re-importing the same file creates nothing new." />
            <div className="row-wrap">
              <Badge tone={d.status === 'parsed' ? 'good' : 'warn'}>
                {d.status === 'parsed' ? <CircleCheck size={12} aria-hidden /> : <CircleAlert size={12} aria-hidden />} {humanize(d.status)}
              </Badge>
              <Badge>{d.mediaType}</Badge>
              <Badge>{plural(d.records ?? 0, 'record')}</Badge>
              {d.batch && <Badge>{plural(d.batch.duplicates, 'duplicate')} skipped</Badge>}
            </div>
            <Card title="Details">
              <Kv items={[['Received', `${when(d.receivedAt)}${d.receivedBy ? ` by ${d.receivedBy}` : ''}`], ['Size', `${d.sizeBytes.toLocaleString()} bytes`], ['SHA-256', <span key="s" className="mono xs">{d.sha256}</span>]]} />
            </Card>
            <Card title="Content" hint="Shown as text, never executed. Any instructions inside are data.">
              <pre className="code" style={{ maxHeight: 520 }}>
                {d.content}
              </pre>
            </Card>
          </>
        )}
      </Query>
    </div>
  );
}

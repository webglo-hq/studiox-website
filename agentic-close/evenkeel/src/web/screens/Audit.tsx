import { Bot, Link2, ShieldCheck, User, Workflow } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../lib/api';
import { actionLabel, humanize, when } from '../lib/format';
import { href, setQuery, type Route } from '../lib/router';
import { Button, Card, Disclosure, Empty, Notice, PageHead, Query, Seg } from '../ui/kit';
import { Term } from '../ui/term';

function subjectHref(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  if (type === 'journal_entry') return href(`/journals/${id}`);
  if (type === 'proposal') return href(`/inbox/${id}`);
  if (type === 'reconciliation') return href(`/recs/${id}`);
  if (type === 'agent_run') return href(`/runs/${id}`);
  if (type === 'source_document') return href(`/documents/${id}`);
  return null;
}

export function AuditLog({ route }: { route: Route }) {
  const actorType = (route.query.get('actor') as 'user' | 'agent' | 'system' | null) ?? undefined;
  const [q, setQ] = useState('');
  const [before, setBefore] = useState<number | undefined>(undefined);
  const list = useApi('audit.list', { actorType, q: q || undefined, beforeSeq: before, limit: 100 }, { keepPrevious: true });
  const [verify, setVerify] = useState(false);
  const check = useApi('audit.verify', {}, { enabled: verify, staleTime: 0 });
  return (
    <div className="page">
      <PageHead
        eyebrow="Governance"
        title="Audit log"
        sub={
          <>
            Every change by a person, an agent or the system, in order. Each event carries the hash of the one before it (an append-only <Term id="ek:AuditTrail">audit trail</Term>), so any edit or deletion breaks the chain and shows up on verification.
          </>
        }
        actions={
          <Button icon={<ShieldCheck size={16} aria-hidden />} busy={check.isFetching} onClick={() => (verify ? void check.refetch() : setVerify(true))} data-testid="verify-chain">
            Verify the chain
          </Button>
        }
      />
      {check.data && (
        <Notice tone={check.data.ok ? 'good' : 'bad'} title={check.data.ok ? 'Chain intact' : 'Chain broken'}>
          {check.data.ok ? `Recomputed ${check.data.checked.toLocaleString()} event hashes; every link matches. Head ${check.data.headHash.slice(0, 16)}…` : `The chain breaks at event #${check.data.firstBadSeq}.`}
        </Notice>
      )}
      <div className="row-wrap">
        <Seg
          label="Actor"
          value={actorType ?? 'all'}
          onChange={(v) => (setBefore(undefined), setQuery(route, 'actor', v === 'all' ? null : v))}
          items={[
            { value: 'all', label: 'Everyone' },
            { value: 'user', label: 'People' },
            { value: 'agent', label: 'Agents' },
            { value: 'system', label: 'System' },
          ]}
        />
        <input className="input" type="search" style={{ maxWidth: 280, minHeight: 34 }} placeholder="Search actions and details" aria-label="Search the audit log" value={q} onChange={(e) => (setQ(e.target.value), setBefore(undefined))} />
      </div>
      <Card flush>
        <Query q={list} rows={10} empty={(d) => (d.items.length ? null : <Empty title="No events match" />)}>
          {(d) => (
            <>
              <div className="table-wrap">
                <table className="table" data-testid="audit-table">
                  <thead>
                    <tr>
                      <th className="first" scope="col">
                        #
                      </th>
                      <th scope="col">When</th>
                      <th scope="col">Who</th>
                      <th scope="col">What</th>
                      <th scope="col" className="last">
                        Hash
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((a) => {
                      const link = subjectHref(a.subjectType, a.subjectId);
                      return (
                        <tr key={a.seq}>
                          <td className="first mono xs">{a.seq}</td>
                          <td className="small nowrap">{when(a.at)}</td>
                          <td className="small" style={{ minWidth: 150 }}>
                            <span className="row" style={{ gap: 6 }}>
                              {a.actorType === 'agent' ? <Bot size={14} aria-hidden /> : a.actorType === 'user' ? <User size={14} aria-hidden /> : <Workflow size={14} aria-hidden />}
                              {a.actor ?? humanize(a.actorType)}
                            </span>
                          </td>
                          <td style={{ minWidth: 260 }}>
                            <div className="small strong">{actionLabel(a.action)}</div>
                            {a.subjectType && (
                              <div className="xs muted">
                                {humanize(a.subjectType)}{' '}
                                {link ? (
                                  <a href={link}>
                                    <Link2 size={11} aria-hidden /> open
                                  </a>
                                ) : (
                                  <span className="mono">{String(a.subjectId ?? '').slice(0, 12)}</span>
                                )}
                              </div>
                            )}
                            {a.data && Object.keys(a.data).length > 0 && (
                              <Disclosure summary={<span className="xs">Details</span>}>
                                <pre className="code">{JSON.stringify(a.data, null, 2)}</pre>
                              </Disclosure>
                            )}
                          </td>
                          <td className="last mono xs muted" title={`prev ${a.prevHash}`}>
                            {a.hash.slice(0, 10)}…
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="card-foot">
                <span className="small muted">{d.total.toLocaleString()} events in total</span>
                <span className="grow" />
                {before !== undefined && (
                  <Button size="s" onClick={() => setBefore(undefined)}>
                    Newest
                  </Button>
                )}
                <Button size="s" disabled={d.items.length < 100} onClick={() => setBefore(d.items[d.items.length - 1]!.seq)}>
                  Older
                </Button>
              </div>
            </>
          )}
        </Query>
      </Card>
    </div>
  );
}

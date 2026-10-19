/** Tamper-evident audit log: every mutation by people and agents, hash-chained (AX-AUD-01). */
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, qs, type AuditData, type AuditVerify } from '../api';
import { Badge, ErrorBox, Loading } from '../components/ui';
import { can, useApp, useMe } from '../lib/app-state';
import { dateTime } from '../lib/format';
import { setQuery, useRoute } from '../lib/router';

type Item = AuditData['items'][number];

const PREFIXES: [string, string][] = [
  ['', 'All activity'],
  ['proposal.', 'Proposals'],
  ['je.', 'Journal entries'],
  ['period.', 'Period lock & reopen'],
  ['agent.', 'Agent runs'],
  ['skill.', 'Skills & policy'],
  ['close.', 'Close & sign-off'],
  ['recon.', 'Reconciliations'],
  ['auth.', 'Sign-in & security'],
  ['admin.', 'Administration'],
  ['import.', 'Imports'],
];

export function Audit() {
  const me = useMe();
  const route = useRoute();
  const action = route.query.get('action') ?? '';
  const subject = route.query.get('subject') ?? '';
  const { version, toast } = useApp();
  const [items, setItems] = useState<Item[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [more, setMore] = useState(true);
  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    let alive = true;
    setItems(null);
    api<AuditData>(`/audit${qs({ limit: 100, action: action || null, subject: subject || null })}`)
      .then((d) => {
        if (!alive) return;
        setItems(d.items);
        setTotal(d.total);
        setMore(d.items.length === 100);
      })
      .catch((e: Error) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [action, subject, version]);

  async function loadMore() {
    if (!items?.length) return;
    const d = await api<AuditData>(`/audit${qs({ limit: 100, before: items[items.length - 1]!.seq, action: action || null, subject: subject || null })}`);
    setItems([...items, ...d.items]);
    setMore(d.items.length === 100);
  }

  async function runVerify() {
    setVerifying(true);
    try {
      setVerify(await api<AuditVerify>('/audit/verify', { body: {} }));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Verification failed to run.', 'bad');
    } finally {
      setVerifying(false);
    }
  }

  if (error) return <ErrorBox error={error} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="lede">
            Append-only and hash-chained: each event stores the SHA-256 of its content and of the event before it, so any edit or deletion breaks the chain. The database rejects updates and deletes on this table. {total.toLocaleString()} events.
          </p>
        </div>
        {can(me, 'audit.verify') ? (
          <div className="actions">
            <button className="btn primary" onClick={() => void runVerify()} disabled={verifying}>
              <ShieldCheck className="icon" aria-hidden="true" /> {verifying ? 'Verifying…' : 'Verify chain'}
            </button>
          </div>
        ) : null}
      </div>
      {verify ? (
        <div className={`callout ${verify.ok ? 'good' : 'bad'}`} role="status" style={{ marginBottom: 14 }}>
          <div>
            {verify.ok ? (
              <>
                <strong>Chain intact.</strong> {verify.count.toLocaleString()} events re-hashed from the first; head <span className="mono">{verify.head?.slice(0, 16)}</span> (<a href="#/ontology?axiom=AX-AUD-01">AX-AUD-01</a>).
              </>
            ) : (
              <>
                <strong>Chain broken at event {verify.firstBadSeq}.</strong> {verify.reason}
              </>
            )}
          </div>
        </div>
      ) : null}
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="sr-only" htmlFor="audit-filter">
          Filter
        </label>
        <select id="audit-filter" value={action} onChange={(e) => setQuery('action', e.target.value || null)}>
          {PREFIXES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {subject ? (
          <button className="btn ghost small" onClick={() => setQuery('subject', null)}>
            Showing one record · clear
          </button>
        ) : null}
      </div>
      {!items ? (
        <Loading />
      ) : (
        <section className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col" className="r">
                    #
                  </th>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col" className="hide-sm">
                    Hash
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.seq}>
                    <td className="r num muted">{r.seq}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dateTime(r.at)}</td>
                    <td>
                      {r.actor}
                      {r.actorType === 'agent' ? (
                        <>
                          {' '}
                          <Badge tone="info" icon={false}>
                            Agent
                          </Badge>
                        </>
                      ) : null}
                      {r.onBehalfOf ? <div className="muted" style={{ fontSize: 12 }}>for {r.onBehalfOf}</div> : null}
                    </td>
                    <td>
                      <div>{r.summary}</div>
                      <div className="muted mono" style={{ fontSize: 12 }}>
                        {r.action}
                        {r.subjectId ? (
                          <>
                            {' · '}
                            <button className="linklike mono" onClick={() => setQuery('subject', r.subjectId)} title="Show every event for this record">
                              {r.subjectType}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                    <td className="mono muted hide-sm" style={{ fontSize: 12 }} title={`prev ${r.prevHash ?? '—'}`}>
                      {r.hash.slice(0, 10)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more ? (
            <div className="card-pad">
              <button className="btn" onClick={() => void loadMore()}>
                Load older events
              </button>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

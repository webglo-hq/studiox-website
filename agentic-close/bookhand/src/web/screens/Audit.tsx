import { Bot, Link2, ScrollText, Search, ShieldCheck, User, X, Zap } from 'lucide-react';
import { type FormEvent, Fragment, useState } from 'react';
import { api, qs } from '../lib/api';
import { date } from '../lib/format';
import { useAction, useApi, useCan } from '../lib/hooks';
import { Badge, Empty, ErrorBox, Skeleton, Term } from '../components/ui';

interface AuditEvent {
  seq: number;
  at: string;
  actorType: string;
  actor: string;
  action: string;
  objectType: string;
  objectId: string | null;
  summary: string;
  hash: string;
  prevHash: string;
  record: string;
  ip: string | null;
}

interface Verification {
  ok: boolean;
  checked: number;
  headHash: string;
  firstBadSeq?: number;
  reason?: string;
}

const OBJECT_TYPES = ['journal_entry', 'proposal', 'agent_run', 'reconciliation', 'flux_analysis', 'close', 'close_task', 'period', 'skill_policy', 'sod_rule', 'user', 'session', 'import_batch', 'audit_log'];

function objectLink(type: string, id: string | null): string | null {
  if (!id) return null;
  switch (type) {
    case 'journal_entry':
      return `#/ledger/${id}`;
    case 'proposal':
      return `#/inbox/${id}?view=all`;
    case 'agent_run':
      return `#/runs/${id}`;
    case 'reconciliation':
      return `#/recs/${id}`;
    case 'close':
      return `#/close/${id}`;
    default:
      return null;
  }
}

function ActorIcon({ type }: { type: string }) {
  if (type === 'agent') return <Bot size={14} aria-label="Agent" />;
  if (type === 'user') return <User size={14} aria-label="Person" />;
  return <Zap size={14} aria-label={type === 'connector' ? 'Connector' : 'System'} />;
}

export function AuditScreen() {
  const can = useCan();
  const [filters, setFilters] = useState({ action: '', actor: '', objectType: '' });
  const [draft, setDraft] = useState({ action: '', actor: '' });
  const [pages, setPages] = useState<number[]>([]);
  const before = pages[pages.length - 1];
  const { data, error, reload } = useApi<{ total: number; events: AuditEvent[] }>(`/api/audit${qs({ ...filters, limit: 100, before })}`);
  const [open, setOpen] = useState<number | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const { run, busy } = useAction();
  const apply = (e: FormEvent) => {
    e.preventDefault();
    setPages([]);
    setFilters({ ...filters, action: draft.action.trim(), actor: draft.actor.trim() });
  };
  const verify = () => run(async () => setVerification(await api.post<Verification>('/api/audit/verify')));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <div className="sub" style={{ maxWidth: 820 }}>
            Every change by a person, agent or connector, append-only. Each <Term id="bh:AuditEvent">audit event</Term> stores a SHA-256 hash of the event before it, so editing or deleting any record breaks the chain. The database rejects updates and deletes.
          </div>
        </div>
        {can('audit.verify') && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void verify()}>
            <ShieldCheck size={16} aria-hidden="true" /> Verify the chain
          </button>
        )}
      </div>
      {verification && (
        <div className={`callout ${verification.ok ? 'success' : 'danger'}`} role="status">
          {verification.ok ? (
            <>
              <strong>Chain intact.</strong> Recomputed {verification.checked.toLocaleString('en-US')} hashes from the first event; head <code>{verification.headHash.slice(0, 20)}...</code>
            </>
          ) : (
            <>
              <strong>Chain broken at event {verification.firstBadSeq}:</strong> {verification.reason}
            </>
          )}
        </div>
      )}
      <form className="card card-pad filter-grid" onSubmit={apply} aria-label="Filter events">
        <div className="field">
          <label htmlFor="au-action">Action contains</label>
          <input id="au-action" className="input" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} placeholder="e.g. approve, policy, lock" />
        </div>
        <div className="field">
          <label htmlFor="au-actor">Actor contains</label>
          <input id="au-actor" className="input" value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} placeholder="Name or agent" />
        </div>
        <div className="field">
          <label htmlFor="au-type">Object</label>
          <select
            id="au-type"
            className="select"
            value={filters.objectType}
            onChange={(e) => {
              setPages([]);
              setFilters({ ...filters, objectType: e.target.value });
            }}
          >
            <option value="">Any object</option>
            {OBJECT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="field filter-actions">
          <button type="submit" className="btn">
            <Search size={15} aria-hidden="true" /> Filter
          </button>
          {(filters.action || filters.actor || filters.objectType) && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setDraft({ action: '', actor: '' });
                setPages([]);
                setFilters({ action: '', actor: '', objectType: '' });
              }}
            >
              <X size={15} aria-hidden="true" /> Clear
            </button>
          )}
        </div>
      </form>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Skeleton rows={12} />}
      {data && (
        <section className="card" aria-label="Events">
          <div className="card-head">
            <h2>{data.total.toLocaleString('en-US')} events in the chain</h2>
            <div className="row">
              {pages.length > 0 && (
                <button type="button" className="btn btn-sm" onClick={() => setPages(pages.slice(0, -1))}>
                  Newer
                </button>
              )}
              {data.events.length === 100 && (
                <button type="button" className="btn btn-sm" onClick={() => setPages([...pages, data.events[data.events.length - 1]!.seq])}>
                  Older
                </button>
              )}
            </div>
          </div>
          {data.events.length === 0 ? (
            <Empty title="No events match" icon={<ScrollText size={26} aria-hidden="true" />} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                    <th className="hide-sm">Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((ev) => {
                    const link = objectLink(ev.objectType, ev.objectId);
                    const isOpen = open === ev.seq;
                    return (
                      <Fragment key={ev.seq}>
                        <tr>
                          <td className="num mono tiny">{ev.seq}</td>
                          <td className="nowrap small">{date(ev.at, 'time')}</td>
                          <td className="small">
                            <span className="row" style={{ gap: 6 }}>
                              <ActorIcon type={ev.actorType} />
                              {ev.actor}
                            </span>
                          </td>
                          <td>
                            <div className="row-wrap">
                              <code className="tiny">{ev.action}</code>
                              {link && (
                                <a href={link} className="tiny row" style={{ gap: 3 }}>
                                  <Link2 size={12} aria-hidden="true" /> {ev.objectType.replace(/_/g, ' ')}
                                </a>
                              )}
                            </div>
                            <div className="small">{ev.summary}</div>
                            <button type="button" className="link-button tiny" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : ev.seq)}>
                              {isOpen ? 'Hide record' : 'Show hashed record'}
                            </button>
                          </td>
                          <td className="hide-sm">
                            <code className="tiny muted" title={ev.hash}>
                              {ev.hash.slice(0, 10)}
                            </code>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="sub-row">
                            <td colSpan={5}>
                              <div className="tiny muted" style={{ marginBottom: 4 }}>
                                sha256(prev_hash + &quot;\n&quot; + record) = <code>{ev.hash}</code>; prev_hash <code>{ev.prevHash}</code>
                              </div>
                              <pre className="code">{prettyRecord(ev.record)}</pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <p className="tiny muted">
        <Badge>Auditor</Badge> users can read everything here; nobody can change it.
      </p>
    </div>
  );
}

function prettyRecord(record: string): string {
  try {
    return JSON.stringify(JSON.parse(record), null, 2);
  } catch {
    return record;
  }
}

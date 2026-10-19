import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { MethodOutput } from '../../app/methods';
import { useAction, useApi } from '../lib/api';
import { humanize, money, when } from '../lib/format';
import { href } from '../lib/router';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Dialog, Empty, Field, PageHead, Person, Query, Status, Tabs } from '../ui/kit';
import { Term } from '../ui/term';

type Issue = MethodOutput<'issues.list'>[number];
type Action = 'acknowledge' | 'resolve' | 'dismiss' | 'reopen';

const CATEGORY_TERM: Record<string, string> = { sod_break: 'ek:SegregationOfDuties', duplicate_payment: 'ek:Exception', intercompany_mismatch: 'ek:IntercompanyBalance', unexplained_bank_item: 'ek:UnexplainedDifference', control_account_posting: 'ek:ControlAccount' };

function refHref(r: { type: string; id: string }): string {
  if (r.type === 'journal_entry') return href(`/journals/${r.id}`);
  if (r.type === 'reconciliation') return href(`/recs/${r.id}`);
  if (r.type === 'source_document') return href(`/documents/${r.id}`);
  if (r.type === 'proposal') return href(`/inbox/${r.id}`);
  return href(`/records/${r.type}/${r.id}`);
}

function ActionDialog({ issue, action, onClose }: { issue: Issue; action: Action; onClose: () => void }) {
  const [note, setNote] = useState('');
  const update = useAction('issues.update', { success: `Exception ${action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : action === 'dismiss' ? 'dismissed' : 'reopened'}.`, onSuccess: onClose });
  const needsNote = action === 'resolve' || action === 'dismiss';
  return (
    <Dialog
      title={`${humanize(action)}: ${issue.title}`}
      description={action === 'resolve' ? 'Record what was done. Resolved exceptions appear in the close package with your note.' : action === 'dismiss' ? 'Dismiss only if this is not a real exception. Say why.' : undefined}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={needsNote && note.trim().length < 3} busy={update.isPending} onClick={() => update.mutate({ issueId: issue.id, action, note: note || undefined })} data-testid="confirm-issue">
            {humanize(action)}
          </Button>
        </>
      }
    >
      <Field label={needsNote ? 'Note' : 'Note (optional)'} htmlFor="issue-note">
        <textarea id="issue-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} data-autofocus />
      </Field>
    </Dialog>
  );
}

export function Issues() {
  const { can } = useSession();
  const [tab, setTab] = useState<'open' | 'all'>('open');
  const q = useApi('issues.list', tab === 'open' ? { status: ['open', 'acknowledged'] } : {});
  const [acting, setActing] = useState<{ issue: Issue; action: Action } | null>(null);
  return (
    <div className="page">
      <PageHead
        eyebrow="Exceptions"
        title="What the agents found"
        sub={
          <>
            Duplicate payments, <Term id="ek:SegregationOfDuties">segregation-of-duties</Term> breaks, unexplained bank items and other <Term id="ek:Exception">exceptions</Term>. Each must be resolved or knowingly accepted before the month locks.
          </>
        }
      />
      <Tabs
        label="Exception views"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'open', label: 'Open' },
          { value: 'all', label: 'All' },
        ]}
      />
      <Query q={q} rows={6} empty={(d) => (d.length ? null : <Empty icon={<ShieldCheck size={22} />} title={tab === 'open' ? 'No open exceptions' : 'No exceptions this period'} />)}>
        {(issues) => (
          <div className="stack">
            {issues.map((i) => (
              <Card
                key={i.id}
                title={
                  <span className="row" style={{ alignItems: 'flex-start' }}>
                    <ShieldAlert size={18} aria-hidden color={i.severity === 'critical' || i.severity === 'high' ? 'var(--bad)' : 'var(--warn)'} style={{ marginTop: 2 }} />
                    <span>{i.title}</span>
                  </span>
                }
                hint={
                  <span className="row-wrap">
                    <Status value={i.severity} label={humanize(i.severity)} />
                    <Badge>
                      {CATEGORY_TERM[i.category] ? <Term id={CATEGORY_TERM[i.category]!}>{humanize(i.category)}</Term> : humanize(i.category)}
                    </Badge>
                    <Status value={i.status} />
                    {i.entityCode && <span>{i.entityCode}</span>}
                    {i.amount !== null && <strong>{money(i.amount)}</strong>}
                  </span>
                }
                actions={
                  can('issue.resolve') ? (
                    <>
                      {i.status === 'open' && (
                        <Button size="s" onClick={() => setActing({ issue: i, action: 'acknowledge' })}>
                          Acknowledge
                        </Button>
                      )}
                      {(i.status === 'open' || i.status === 'acknowledged') && (
                        <>
                          <Button size="s" variant="primary" onClick={() => setActing({ issue: i, action: 'resolve' })} data-testid="resolve-issue">
                            Resolve…
                          </Button>
                          <Button size="s" variant="quiet" onClick={() => setActing({ issue: i, action: 'dismiss' })}>
                            Dismiss…
                          </Button>
                        </>
                      )}
                      {(i.status === 'resolved' || i.status === 'dismissed') && (
                        <Button size="s" variant="quiet" onClick={() => setActing({ issue: i, action: 'reopen' })}>
                          Reopen
                        </Button>
                      )}
                    </>
                  ) : null
                }
              >
                <div className="stack">
                  <p className="small" style={{ whiteSpace: 'pre-line' }}>
                    {i.description}
                  </p>
                  <div className="sunken small">
                    <strong>Recommended:</strong> {i.recommendedAction}
                  </div>
                  {i.subjectRefs.length > 0 && (
                    <div className="row-wrap small">
                      <span className="muted">Evidence:</span>
                      {i.subjectRefs.slice(0, 8).map((r, k) => (
                        <a key={k} href={refHref(r)} className="badge t-outline">
                          {r.label ?? humanize(r.type)}
                        </a>
                      ))}
                    </div>
                  )}
                  <div className="row-wrap xs muted">
                    <span>Raised {when(i.createdAt)}</span>
                    {i.owner && (
                      <span className="row" style={{ gap: 4 }}>
                        · owner <Person name={i.owner.name} />
                      </span>
                    )}
                    {i.proposalId && (
                      <a href={href(`/inbox/${i.proposalId}`)} className="xs">
                        · agent proposal
                      </a>
                    )}
                    {i.resolvedBy && <span>· {i.status} by {i.resolvedBy.name}</span>}
                  </div>
                  {i.resolutionNote && <div className="small ink2">“{i.resolutionNote}”</div>}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Query>
      {acting && <ActionDialog issue={acting.issue} action={acting.action} onClose={() => setActing(null)} />}
    </div>
  );
}

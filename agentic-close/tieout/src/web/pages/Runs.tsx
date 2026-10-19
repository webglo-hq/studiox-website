/** Agent runs and the run trace: plan → act → observe → verify → propose → route → post → audit. */
import { ArrowLeft, Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError, qs, type RunDetail, type RunsList, type SkillsCatalog } from '../api';
import { Badge, ErrorBox, Loading, ProposalStatus, Term } from '../components/ui';
import { can, useApp, useData, useMe } from '../lib/app-state';
import { dateTime, KIND_LABEL } from '../lib/format';
import { navigate, useRoute } from '../lib/router';

const RUN_TONE: Record<string, 'good' | 'bad' | 'warn' | 'info' | 'neutral'> = { succeeded: 'good', failed: 'bad', budget_exceeded: 'warn', running: 'info', queued: 'neutral', cancelled: 'neutral' };
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(micros && micros < 10_000 ? 4 : 2)}`;

export function Runs() {
  const route = useRoute();
  if (route.path[1]) return <RunTrace id={route.path[1]} />;
  return <RunList />;
}

function RunList() {
  const me = useMe();
  const { period, toast, bump } = useApp();
  const { data, error, loading, reload } = useData(() => api<RunsList>(`/runs${qs({ period })}`), [period]);
  const skills = useData(() => api<SkillsCatalog>('/skills'), []);
  const [skill, setSkill] = useState('bank-reconciliation');
  const [entity, setEntity] = useState(me.entities.find((e) => e.kind === 'legal')?.id ?? '');
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const group = skill === 'intercompany-matching' || skill === 'close-package';
      const r = await api<{ id: string; ref: string; summary: { headline?: string } }>('/runs', { body: { skillKey: skill, entityId: group ? null : entity, periodKey: period } });
      toast(`${r.ref}: ${r.summary.headline ?? 'finished'}`);
      bump();
      navigate(`runs/${r.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'The run could not start.', 'bad');
    } finally {
      setBusy(false);
    }
  }
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Agent runs</h1>
          <p className="lede">
            Every run is durable and replayable: each step is recorded as it happens, tool results are stored, and an interrupted run resumes from its last step without duplicating proposals. Runs use the
            requesting person’s permissions, narrowed to the skill’s manifest (least privilege).
          </p>
        </div>
      </div>
      {can(me, 'agent.run') ? (
        <div className="card card-pad row" style={{ marginBottom: 16 }}>
          <label className="field">
            Skill
            <select value={skill} onChange={(e) => setSkill(e.target.value)}>
              {(skills.data?.items ?? []).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Entity
            <select value={entity} onChange={(e) => setEntity(e.target.value)} disabled={skill === 'intercompany-matching' || skill === 'close-package'}>
              {me.entities
                .filter((e) => e.kind === 'legal')
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code}
                  </option>
                ))}
            </select>
          </label>
          <button className="btn primary" style={{ alignSelf: 'flex-end' }} disabled={busy} onClick={() => void run()}>
            <Play className="icon" aria-hidden="true" /> {busy ? 'Running…' : 'Run skill'}
          </button>
          <span className="muted" style={{ alignSelf: 'flex-end', fontSize: 13 }}>
            {me.liveAgents ? 'Live: Claude via the Anthropic API.' : 'Offline engine (deterministic). Set ANTHROPIC_API_KEY on the server for live Claude.'}
          </span>
        </div>
      ) : null}
      {!data ? (
        <Loading />
      ) : (
        <section className={`card${loading ? ' skeleton' : ''}`}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Skill</th>
                  <th scope="col">Result</th>
                  <th scope="col">Mode</th>
                  <th scope="col" className="r">
                    Steps
                  </th>
                  <th scope="col" className="r">
                    Cost
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`runs/${r.id}`)}>
                    <td>
                      <a className="row-link mono" href={`#/runs/${r.id}`}>
                        {r.ref}
                      </a>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {me.entities.find((e) => e.id === r.entityId)?.code ?? 'Group'} · {r.requestedBy}
                      </div>
                    </td>
                    <td>
                      {r.skillKey}
                      <div className="muted" style={{ fontSize: 12 }}>
                        v{r.skillVersion} · {r.autonomy}
                      </div>
                    </td>
                    <td style={{ maxWidth: 420, fontSize: 14 }}>{r.headline}</td>
                    <td>{r.mode === 'live' ? <Badge tone="info">live · {r.model}</Badge> : <Badge>offline</Badge>}</td>
                    <td className="r num">{r.steps}</td>
                    <td className="r num">{usd(r.costMicros)}</td>
                    <td>
                      <Badge tone={RUN_TONE[r.status] ?? 'neutral'}>{r.status.replace('_', ' ')}</Badge>
                      {r.attempts > 1 ? <div className="muted" style={{ fontSize: 12 }}>resumed ×{r.attempts - 1}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function RunTrace({ id }: { id: string }) {
  const me = useMe();
  const { toast, bump } = useApp();
  const { data, error, reload } = useData(() => api<RunDetail>(`/runs/${id}`), [id]);
  const [showCalls, setShowCalls] = useState(false);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading the trace" />;
  const r = data.run;
  const counts = data.steps.reduce<Record<string, number>>((m, s) => ((m[s.phase] = (m[s.phase] ?? 0) + 1), m), {});
  async function resume() {
    try {
      await api(`/runs/${id}/resume`, { body: {} });
      toast('Run resumed.');
      bump();
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not resume.', 'bad');
    }
  }
  return (
    <div>
      <a href="#/runs" className="row" style={{ gap: 6, marginBottom: 10 }}>
        <ArrowLeft className="icon" aria-hidden="true" /> All runs
      </a>
      <div className="page-head">
        <div>
          <h1>
            {r.ref} · {r.skillTitle}
          </h1>
          <p className="lede">{r.summary.headline}</p>
        </div>
        <div className="actions">
          <Badge tone={RUN_TONE[r.status] ?? 'neutral'}>{r.status.replace('_', ' ')}</Badge>
          {(r.status === 'running' || r.status === 'queued') && can(me, 'agent.run') ? (
            <button className="btn" onClick={() => void resume()}>
              <RefreshCw className="icon" aria-hidden="true" /> Resume
            </button>
          ) : null}
        </div>
      </div>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="label">Mode</div>
          <div className="value" style={{ fontSize: 22 }}>
            {r.mode === 'live' ? `Live · ${r.model}` : 'Offline engine'}
          </div>
          <div className="sub">
            Autonomy <Term id="tie:AutonomyLevel">{r.autonomy_level}</Term> · policy v{r.policy_version}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Steps</div>
          <div className="value">{r.steps_used}</div>
          <div className="sub">
            {counts.act ?? 0} tool calls · {counts.propose ?? 0} proposals · {counts.post ?? 0} posts
          </div>
        </div>
        <div className="card stat">
          <div className="label">Cost</div>
          <div className="value">{usd(r.cost_micros)}</div>
          <div className="sub">
            {r.input_tokens.toLocaleString()} in · {r.output_tokens.toLocaleString()} out · {r.cache_read_tokens.toLocaleString()} cached
          </div>
        </div>
        <div className="card stat">
          <div className="label">Requested by</div>
          <div className="value" style={{ fontSize: 22 }}>
            {r.requestedByName}
          </div>
          <div className="sub">
            {dateTime(r.created_at)}
            {r.attempts > 1 ? ` · resumed ${r.attempts - 1}×` : ''}
          </div>
        </div>
      </div>
      {r.summary.plan?.length ? (
        <section className="card card-pad" style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 8 }}>Plan</h2>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {r.summary.plan.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {r.summary.notes?.length ? (
            <ul className="checks" style={{ marginTop: 10 }}>
              {r.summary.notes.map((n) => (
                <li key={n} className="muted">
                  {n}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <div className="grid main-side">
        <section className="card" aria-labelledby="h-trace">
          <div className="card-head">
            <h2 id="h-trace">Trace</h2>
            <span className="right">
              <button className="btn small ghost" aria-pressed={showCalls} onClick={() => setShowCalls((s) => !s)}>
                {showCalls ? 'Hide tool payloads' : 'Show tool payloads'}
              </button>
            </span>
          </div>
          <ol className="trace" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            {data.steps.map((s) => (
              <li key={s.seq}>
                <span className="mono muted">#{s.seq}</span>
                <span className={`phase ${s.status === 'failed' ? 'failed' : s.phase}`}>{s.phase}</span>
                <span>
                  {s.title}
                  {showCalls && s.phase === 'act' ? (
                    <pre className="doc" style={{ maxHeight: 160, marginTop: 6 }}>
                      {JSON.stringify(data.toolCalls.find((c) => c.seq === (s.detail as { actionSeq?: number }).actionSeq)?.input ?? {}, null, 1)}
                      {'\n→ '}
                      {data.toolCalls.find((c) => c.seq === (s.detail as { actionSeq?: number }).actionSeq)?.outputPreview.slice(0, 600)}
                    </pre>
                  ) : null}
                </span>
                <span className="muted num t-right">{s.durationMs ? `${s.durationMs} ms` : ''}</span>
              </li>
            ))}
          </ol>
        </section>
        <div className="stack">
          <section className="card" aria-labelledby="h-props">
            <div className="card-head">
              <h2 id="h-props">Proposals ({data.proposals.length})</h2>
            </div>
            <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {data.proposals.map((p) => (
                <div className="prop" key={p.id} style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
                  <div>
                    <a className="title" href={`#/inbox?status=all&open=${p.id}`}>
                      <span className="mono muted">{p.ref}</span> {p.title}
                    </a>
                    <div className="meta">
                      {KIND_LABEL[p.kind]} <ProposalStatus status={p.status} route={p.route} reviewStatus={p.reviewStatus} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
          {data.toolCalls.some((c) => c.flags.length) ? (
            <section className="card card-pad">
              <h2 style={{ marginBottom: 8 }}>
                <Term id="tie:PromptInjection">Untrusted text flagged</Term>
              </h2>
              <ul className="checks">
                {data.toolCalls.flatMap((c) =>
                  c.flags.map((f, i) => (
                    <li key={`${c.seq}-${i}`}>
                      <Badge tone="bad" icon={false}>
                        {f.pattern.replace('_', ' ')}
                      </Badge>
                      <span style={{ fontSize: 13 }}>
                        <code>{c.tool}</code> {f.path}: “{f.excerpt}”
                      </span>
                    </li>
                  )),
                )}
              </ul>
              <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                Treated as data, never as instructions. Anything derived from it waits for a person (AX-AGT-02).
              </p>
            </section>
          ) : null}
          {data.transcript.length ? (
            <section className="card card-pad">
              <h2 style={{ marginBottom: 8 }}>Model transcript</h2>
              <pre className="doc">{JSON.stringify(data.transcript, null, 1).slice(0, 20000)}</pre>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

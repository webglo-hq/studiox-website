import { ArrowLeft, Download, ExternalLink, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { MethodOutput } from '../../app/methods';
import { useApi, useBackend } from '../lib/api';
import { humanize } from '../lib/format';
import { href, navigate, setQuery, type Route } from '../lib/router';
import { useToast } from '../lib/toast';
import { Badge, Button, Card, Dialog, Disclosure, Empty, Kv, LinkButton, PageHead, Query, Status, Tabs } from '../ui/kit';

type Graph = MethodOutput<'ontology.graph'>;

const MODULE_COLORS = ['#2a49c4', '#1c6a4a', '#8a5300', '#b3261e', '#1f5fae', '#6b3fa0', '#0f766e', '#9d174d', '#4d7c0f', '#7c2d12', '#334155', '#a16207'];

export function OntologyExplorer({ route, termId }: { route: Route; termId: string | null }) {
  if (termId) return <TermPage id={termId} />;
  return <Overview route={route} />;
}

function download(filename: string, mediaType: string, content: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
}

function Overview({ route }: { route: Route }) {
  const tab = (route.query.get('tab') as 'classes' | 'axioms' | 'graph' | null) ?? 'classes';
  const q = useApi('ontology.overview', {});
  const [search, setSearch] = useState('');
  const results = useApi('ontology.search', { q: search }, { enabled: search.trim().length >= 2, keepPrevious: true });
  const backend = useBackend();
  const toast = useToast();
  const [exported, setExported] = useState<{ filename: string; content: string } | null>(null);
  const exportAs = async (format: 'jsonld' | 'ttl') => {
    try {
      const r = await backend.call('ontology.export', { format });
      if (!download(r.filename, r.mediaType, r.content)) setExported({ filename: r.filename, content: r.content });
    } catch (e) {
      toast.push({ tone: 'bad', text: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="page">
      <Query q={q} rows={10}>
        {(o) => {
          const modules = o.modules.map((m) => m.id);
          return (
            <>
              <PageHead
                eyebrow={`Close ontology · v${o.version}`}
                title="The vocabulary the agents reason with"
                sub="A formal, versioned model of the month-end close, grounded in REA, double entry, XBRL, COSO, audit assertions and US GAAP. Axioms validate every entry and proposal; tool schemas and skill inputs are typed by these classes; every hover definition in the app comes from here."
                actions={
                  <>
                    <Button size="s" icon={<Download size={14} aria-hidden />} onClick={() => void exportAs('jsonld')}>
                      JSON-LD
                    </Button>
                    <Button size="s" icon={<Download size={14} aria-hidden />} onClick={() => void exportAs('ttl')}>
                      Turtle
                    </Button>
                  </>
                }
              />
              <div className="grid grid-4">
                <div className="card stat">
                  <span className="label">Classes</span>
                  <span className="value">{o.counts.classes}</span>
                </div>
                <div className="card stat">
                  <span className="label">Relations</span>
                  <span className="value">{o.counts.relations}</span>
                </div>
                <div className="card stat">
                  <span className="label">Executable axioms</span>
                  <span className="value">{o.counts.axioms}</span>
                </div>
                <div className="card stat">
                  <span className="label">Individuals</span>
                  <span className="value">{o.counts.individuals}</span>
                </div>
              </div>
              <div className="row" style={{ maxWidth: 520 }}>
                <Search size={16} aria-hidden className="muted" />
                <input className="input" type="search" placeholder="Look up a term: accrual, materiality, deposit in transit…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search the ontology" />
              </div>
              {search.trim().length >= 2 && (
                <Card title="Matches" flush>
                  {results.data?.length ? (
                    <div className="list">
                      {results.data.map((t) => (
                        <a key={t.id} className="list-item" href={href(`/ontology/${encodeURIComponent(t.id)}`)}>
                          <span className="grow stack" style={{ gap: 2 }}>
                            <strong className="small">{t.label}</strong>
                            <span className="xs ink2">{t.plain}</span>
                          </span>
                          <Badge>{t.kind}</Badge>
                          <span className="xs mono muted">{t.id}</span>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <Empty title="No matching terms" />
                  )}
                </Card>
              )}
              <Tabs
                label="Ontology views"
                value={tab}
                onChange={(v) => setQuery(route, 'tab', v)}
                items={[
                  { value: 'classes', label: 'Classes', count: o.counts.classes },
                  { value: 'axioms', label: 'Axioms', count: o.counts.axioms },
                  { value: 'graph', label: 'Graph' },
                ]}
              />
              {tab === 'classes' && (
                <div className="grid grid-2">
                  {o.modules.map((m) => (
                    <Card key={m.id} title={humanize(m.id)} hint={`${m.classes} classes`}>
                      <div className="chip-list">
                        {o.classes
                          .filter((c) => c.module === m.id)
                          .map((c) => (
                            <a key={c.id} href={href(`/ontology/${encodeURIComponent(c.id)}`)} className="chip" title={c.plain} style={{ textDecoration: 'none' }}>
                              {c.label}
                            </a>
                          ))}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
              {tab === 'axioms' && (
                <Card flush>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th className="first" scope="col">
                            Axiom
                          </th>
                          <th scope="col">Applies to</th>
                          <th scope="col" className="last">
                            Severity
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {o.axioms.map((a) => (
                          <tr key={a.id}>
                            <td className="first" style={{ minWidth: 320 }}>
                              <a href={href(`/ontology/${encodeURIComponent(a.id)}`)} className="strong small">
                                <span className="mono">{a.id}</span> {a.name}
                              </a>
                              <div className="small ink2">{a.plain}</div>
                              <div className="xs muted mono">{a.formal}</div>
                            </td>
                            <td className="small">
                              <a href={href(`/ontology/${encodeURIComponent(a.appliesTo)}`)}>{a.appliesTo}</a>
                            </td>
                            <td className="last">
                              <Status value={a.severity === 'error' ? 'blocked' : 'pending'} label={a.severity} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
              {tab === 'graph' && <GraphView modules={modules} />}
              {exported && (
                <Dialog title={exported.filename} wide description="Downloads are blocked here, so the export is shown instead. Copy it from the box." onClose={() => setExported(null)}>
                  <pre className="code" style={{ maxHeight: '60vh' }}>
                    {exported.content}
                  </pre>
                </Dialog>
              )}
            </>
          );
        }}
      </Query>
    </div>
  );
}

interface P {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Deterministic force layout (no randomness, so screenshots are stable). */
function layout(g: Graph, width: number, height: number): Map<string, { x: number; y: number }> {
  const nodes: P[] = g.nodes.map((n, i) => {
    const a = (i / g.nodes.length) * Math.PI * 2 * 7.3;
    const r = 60 + (i % 17) * 14;
    return { id: n.id, x: width / 2 + Math.cos(a) * r, y: height / 2 + Math.sin(a) * r, vx: 0, vy: 0 };
  });
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = g.edges.map((e) => [idx.get(e.source), idx.get(e.target)] as const).filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined);
  for (let it = 0; it < 260; it++) {
    const alpha = 1 - it / 260;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = 0.1 * (i - j);
          dy = 0.1;
          d2 = dx * dx + dy * dy;
        }
        const f = (1400 / d2) * alpha;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
    }
    for (const [s, t] of edges) {
      const a = nodes[s]!;
      const b = nodes[t]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - 46) / d) * 0.05 * alpha;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx += (width / 2 - n.x) * 0.004 * alpha;
      n.vy += (height / 2 - n.y) * 0.004 * alpha;
      n.x += Math.max(-20, Math.min(20, n.vx));
      n.y += Math.max(-20, Math.min(20, n.vy));
      n.vx *= 0.55;
      n.vy *= 0.55;
    }
  }
  // Fit the layout to the canvas. Bounds come from the 3rd–97th percentiles so a few
  // loosely connected classes cannot shrink the rest to a dot; those few sit on the edge.
  const pct = (vals: number[], p: number) => [...vals].sort((a, b) => a - b)[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * p)))]!;
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const [x0, x1, y0, y1] = [pct(xs, 0.03), pct(xs, 0.97), pct(ys, 0.03), pct(ys, 0.97)];
  const pad = 60;
  const s = Math.min((width - 2 * pad) / Math.max(1, x1 - x0), (height - 2 * pad) / Math.max(1, y1 - y0));
  const ox = (width - (x1 - x0) * s) / 2;
  const oy = (height - (y1 - y0) * s) / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return new Map(nodes.map((n) => [n.id, { x: clamp(ox + (n.x - x0) * s, 16, width - 16), y: clamp(oy + (n.y - y0) * s, 16, height - 16) }]));
}

function GraphView({ modules }: { modules: string[] }) {
  const q = useApi('ontology.graph', {}, { staleTime: Infinity });
  const [module, setModule] = useState<string>('');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const W = 1200;
  const H = 800;
  const data = q.data;
  const filtered = useMemo(() => {
    if (!data) return null;
    const keep = new Set(data.nodes.filter((n) => n.kind === 'class' && (!module || n.module === module)).map((n) => n.id));
    if (module) for (const e of data.edges) if (keep.has(e.source) && e.kind !== 'instanceOf') keep.add(e.target);
    return { nodes: data.nodes.filter((n) => keep.has(n.id)), edges: data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
  }, [data, module]);
  const pos = useMemo(() => (filtered ? layout(filtered, W, H) : null), [filtered]);
  // Choosing another module recentres the graph.
  const [viewModule, setViewModule] = useState(module);
  if (viewModule !== module) {
    setViewModule(module);
    setView({ x: 0, y: 0, k: 1 });
  }
  const color = (m: string) => MODULE_COLORS[Math.max(0, modules.indexOf(m)) % MODULE_COLORS.length]!;
  return (
    <Card title="Class graph" hint="Drag to pan, scroll or pinch to zoom, select a class to open it" actions={
      <select className="select" style={{ width: 'auto', minHeight: 32 }} aria-label="Module" value={module} onChange={(e) => setModule(e.target.value)}>
        <option value="">All modules</option>
        {modules.map((m) => (
          <option key={m} value={m}>
            {humanize(m)}
          </option>
        ))}
      </select>
    }>
      <Query q={q} rows={6}>
        {() =>
          filtered && pos ? (
            <div className="graph-wrap">
              <svg
                viewBox={`0 0 ${W} ${H}`}
                role="group"
                aria-label={`Graph of ${filtered.nodes.length} ontology classes and ${filtered.edges.length} relations`}
                onWheel={(e) => {
                  const k = Math.max(0.4, Math.min(4, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
                  setView((v) => ({ ...v, k }));
                }}
                onPointerDown={(e) => {
                  drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!drag.current) return;
                  const d = drag.current;
                  setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x) / v.k, y: d.vy + (e.clientY - d.y) / v.k }));
                }}
                onPointerUp={() => (drag.current = null)}
              >
                <g transform={`translate(${W / 2} ${H / 2}) scale(${view.k}) translate(${-W / 2 + view.x} ${-H / 2 + view.y})`}>
                  {filtered.edges.map((e, i) => {
                    const a = pos.get(e.source);
                    const b = pos.get(e.target);
                    if (!a || !b) return null;
                    const hot = hover && (e.source === hover || e.target === hover);
                    return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={hot ? 'var(--accent)' : 'var(--line-strong)'} strokeOpacity={hot ? 0.9 : 0.35} strokeWidth={e.kind === 'subClassOf' ? 1.2 : 0.8} strokeDasharray={e.kind === 'relation' ? '3 3' : undefined} />;
                  })}
                  {filtered.nodes.map((n) => {
                    const p = pos.get(n.id)!;
                    const r = 4 + Math.min(10, n.degree * 0.7);
                    return (
                      <g key={n.id} className={`graph-node ${hover === n.id ? 'sel' : ''}`} transform={`translate(${p.x} ${p.y})`} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)} onClick={() => navigate(href(`/ontology/${encodeURIComponent(n.id)}`))} role="link" aria-label={n.label} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(href(`/ontology/${encodeURIComponent(n.id)}`))}>
                        <circle r={r} fill={color(n.module)} />
                        {(n.degree >= 5 || hover === n.id || module) && (
                          <text x={r + 3} y={4}>
                            {n.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              </svg>
            </div>
          ) : null
        }
      </Query>
      <div className="row-wrap xs" style={{ marginTop: 10 }}>
        {modules.map((m) => (
          <span key={m} className="row" style={{ gap: 4 }}>
            <span className="dot" style={{ background: color(m) }} aria-hidden /> {humanize(m)}
          </span>
        ))}
        <span className="muted">· solid: is-a · dashed: relation</span>
      </div>
    </Card>
  );
}

function TermPage({ id }: { id: string }) {
  const q = useApi('ontology.term', { id });
  return (
    <div className="page">
      <div>
        <LinkButton href="#/ontology" variant="quiet" size="s" icon={<ArrowLeft size={14} aria-hidden />}>
          Ontology
        </LinkButton>
      </div>
      <Query q={q} rows={10}>
        {(t) => (
          <>
            <PageHead eyebrow={`${humanize(t.kind)}${t.module ? ` · ${humanize(t.module)}` : ''} · ${t.id}`} title={t.label} sub={t.plain} />
            {t.ancestors.length > 0 && (
              <div className="row-wrap small">
                <span className="muted">Is a</span>
                {t.ancestors.map((a) => (
                  <a key={a} href={href(`/ontology/${encodeURIComponent(a)}`)} className="chip" style={{ textDecoration: 'none' }}>
                    {a}
                  </a>
                ))}
              </div>
            )}
            <div className="grid grid-main">
              <div className="stack-l">
                <Card title="Definition">
                  <div className="stack">
                    <p>{t.definition}</p>
                    {t.why && (
                      <p className="ink2">
                        <strong>Why it matters.</strong> {t.why}
                      </p>
                    )}
                    {t.example && (
                      <p className="ink2">
                        <strong>Example.</strong> {t.example}
                      </p>
                    )}
                    {t.synonyms.length > 0 && <p className="small muted">Also called: {t.synonyms.join(', ')}</p>}
                  </div>
                </Card>
                {t.axioms.length > 0 && (
                  <Card title="Axioms" hint="Executable rules checked on every entry and proposal">
                    <ul className="stack small" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 10 }}>
                      {t.axioms.map((a) => (
                        <li key={a.id}>
                          <a href={href(`/ontology/${encodeURIComponent(a.id)}`)} className="strong">
                            <span className="mono">{a.id}</span> {a.name}
                          </a>{' '}
                          <Badge tone={a.severity === 'error' ? 'bad' : 'warn'}>{a.severity}</Badge>
                          <div className="ink2">{a.plain}</div>
                          <div className="xs muted mono">{a.formal}</div>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                {(t.relations.outgoing.length > 0 || t.relations.incoming.length > 0) && (
                  <Card title="Relations">
                    <div className="stack small">
                      {t.relations.outgoing.map((r) => (
                        <div key={`o-${r.id}`}>
                          {t.label} <strong>{r.label}</strong> <a href={href(`/ontology/${encodeURIComponent(r.range)}`)}>{r.range}</a> <span className="muted">({r.cardinality})</span>
                        </div>
                      ))}
                      {t.relations.incoming.map((r) => (
                        <div key={`i-${r.id}`}>
                          <a href={href(`/ontology/${encodeURIComponent(r.domain)}`)}>{r.domain}</a> <strong>{r.label}</strong> {t.label} <span className="muted">({r.cardinality})</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
                {t.properties.length > 0 && (
                  <Card title="Properties" flush>
                    <div className="table-wrap">
                      <table className="table">
                        <tbody>
                          {t.properties.map((p) => (
                            <tr key={p.id}>
                              <td className="first small strong">{p.label}</td>
                              <td className="small mono">{p.range}</td>
                              <td className="last small ink2">
                                {p.definition} <span className="muted">({p.cardinality})</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
                {t.jsonSchema && (
                  <Card title="Payload shape" hint="The JSON Schema agents must produce for this class (validated on every proposal)">
                    <Disclosure summary="Show JSON Schema">
                      <pre className="code">{JSON.stringify(t.jsonSchema, null, 2)}</pre>
                    </Disclosure>
                  </Card>
                )}
              </div>
              <div className="stack-l">
                {Object.keys(t.mappings).length > 0 && (
                  <Card title="Aligned standards">
                    <Kv items={Object.entries(t.mappings).map(([k, v]) => [humanize(k), Array.isArray(v) ? v.join(', ') : String(v)])} />
                  </Card>
                )}
                {t.children.length > 0 && (
                  <Card title="Kinds of this">
                    <div className="chip-list">
                      {t.children.map((c) => (
                        <a key={c.id} href={href(`/ontology/${encodeURIComponent(c.id)}`)} className="chip" style={{ textDecoration: 'none' }}>
                          {c.label}
                        </a>
                      ))}
                    </div>
                  </Card>
                )}
                {t.individuals.length > 0 && (
                  <Card title="Values">
                    <ul className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
                      {t.individuals.map((i) => (
                        <li key={i.id}>
                          <strong>{i.label}</strong> <span className="ink2">{i.definition}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                {t.sources.length > 0 && (
                  <Card title="Sources">
                    <ul className="stack small" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
                      {t.sources.map((s) => (
                        <li key={s.id}>
                          {s.url ? (
                            <a href={s.url} target="_blank" rel="noopener noreferrer">
                              {s.title} <ExternalLink size={11} aria-hidden />
                            </a>
                          ) : (
                            s.title
                          )}
                          {s.publisher && <span className="muted"> · {s.publisher}</span>}
                          {s.year && <span className="muted"> · {s.year}</span>}
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
            </div>
          </>
        )}
      </Query>
    </div>
  );
}

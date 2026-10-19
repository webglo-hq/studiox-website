import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { Download, Network, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { closeOntology } from '../../packs/accounting/ontology';
import { toJsonLd, toTurtle } from '../../ontology/export';
import { qs } from '../lib/api';
import { label } from '../lib/format';
import { navigate, useApi } from '../lib/hooks';
import { Badge, Empty, ErrorBox, Skeleton } from '../components/ui';

interface OntologyIndex {
  iri: string;
  version: string;
  contentHash: string;
  modules: string[];
  classes: Array<{ id: string; label: string; module: string; parents: string[]; definition: string; accountClass: string | null; normalBalance: string | null }>;
  axioms: Array<{ id: string; label: string; appliesTo: string; severity: string; plainEnglish: string; formal: string; citations: string[] }>;
  relations: Array<{ id: string; label: string; domain: string; range: string }>;
}

interface TermDetail {
  id: string;
  kind: 'class' | 'individual' | 'axiom';
  label: string;
  definition: string;
  whyItMatters: string;
  example: string;
  module?: string;
  parents?: string[];
  citations?: Array<{ key: string; text: string; url?: string }>;
  standards?: Array<{ source: string; ref: string; note?: string }>;
  formal?: string;
  ancestors: Array<{ id: string; label: string }>;
  children: Array<{ id: string; label: string }>;
  axioms: Array<{ id: string; label: string; plainEnglish: string; severity: string }>;
  properties: Array<{ id: string; label: string; range: string; cardinality: string; definition: string; column?: string }>;
  table: string | null;
  accountClass: string | null;
  normalBalance: string | null;
  fsLine: string | null;
  bucketing: { keywords: string[]; mcc?: string[]; capitalizable?: boolean } | null;
  assertions: string[];
}

interface GraphData {
  nodes: Array<{ id: string; label: string; module: string; depth: number; degree: number }>;
  edges: Array<{ source: string; target: string; kind: 'subClassOf' | 'relation'; label?: string }>;
}

const MODULE_LABEL = new Map(closeOntology.spec.modules.map((m) => [m.id, m.label]));
const MODULE_HUE = new Map(closeOntology.spec.modules.map((m, i) => [m.id, (i * 47 + 150) % 360]));

function download(filename: string, text: string, type: string) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* downloads can be blocked in sandboxed frames */
  }
}

export function OntologyScreen({ termId }: { termId: string | null }) {
  const { data: index, error, reload } = useApi<OntologyIndex>('/api/ontology');
  const term = useApi<TermDetail>(termId ? `/api/ontology/terms/${encodeURIComponent(termId)}` : null);
  const [q, setQ] = useState('');
  const [module, setModule] = useState<string | null>(null);
  const [resolved, setResolved] = useState<string | null>(null);
  useEffect(() => setModule(null), [termId]);
  const activeModule = module ?? term.data?.module ?? (termId ? null : 'reconciliation');
  const results = useMemo(() => {
    if (!index || !q.trim()) return null;
    const needle = q.trim().toLowerCase();
    const classes = index.classes.filter((c) => c.label.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle) || c.definition.toLowerCase().includes(needle));
    const axioms = index.axioms.filter((a) => a.label.toLowerCase().includes(needle) || a.id.toLowerCase().includes(needle) || a.plainEnglish.toLowerCase().includes(needle));
    return { classes: classes.slice(0, 40), axioms: axioms.slice(0, 20) };
  }, [index, q]);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setResolved(null);
      return;
    }
    // The lexicon resolves synonyms and abbreviations ("AP", "DIT", "PP&E") the way agents ground free text.
    const t = setTimeout(() => {
      const id = closeOntology.lookup(text);
      setResolved(id ?? null);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!index) return <Skeleton rows={10} />;
  const moduleClasses = activeModule ? index.classes.filter((c) => c.module === activeModule) : [];
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Close ontology</h1>
          <div className="sub" style={{ maxWidth: 860 }}>
            The shared vocabulary behind every screen and agent: {index.classes.length} classes, {index.relations.length} relations and {index.axioms.length} executable axioms. Agents ground their tools and outputs in it; the ledger enforces its axioms before anything posts.
          </div>
          <div className="tiny muted" style={{ marginTop: 6 }}>
            v{index.version} · <code>{index.iri}</code> · sha256 <code>{index.contentHash.slice(0, 12)}</code>
          </div>
        </div>
        <div className="row-wrap">
          <button type="button" className="btn btn-sm" onClick={() => download(`bookhand-close-ontology-${index.version}.ttl`, toTurtle(closeOntology), 'text/turtle')}>
            <Download size={14} aria-hidden="true" /> Turtle
          </button>
          <button type="button" className="btn btn-sm" onClick={() => download(`bookhand-close-ontology-${index.version}.jsonld`, JSON.stringify(toJsonLd(closeOntology), null, 2), 'application/ld+json')}>
            <Download size={14} aria-hidden="true" /> JSON-LD
          </button>
        </div>
      </div>
      <div className="onto-layout">
        <aside className="stack" style={{ gap: 12 }} aria-label="Browse the ontology">
          <div className="card card-pad stack">
            <label htmlFor="onto-q" className="label">
              Search terms
            </label>
            <div className="input-icon">
              <Search size={15} aria-hidden="true" />
              <input id="onto-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. deposit in transit, AP, accrual" autoComplete="off" />
            </div>
            {resolved && (
              <div className="small">
                Lexicon match:{' '}
                <a href={`#/ontology/${encodeURIComponent(resolved)}`}>
                  {closeOntology.term(resolved)?.label ?? resolved}
                </a>
              </div>
            )}
          </div>
          {results ? (
            <div className="card">
              <div className="card-head">
                <h2>{results.classes.length + results.axioms.length} matches</h2>
              </div>
              <ul className="list small term-list">
                {results.classes.map((c) => (
                  <li key={c.id}>
                    <a href={`#/ontology/${encodeURIComponent(c.id)}`} aria-current={c.id === termId ? 'true' : undefined}>
                      {c.label}
                    </a>
                    <span className="tiny muted"> · {MODULE_LABEL.get(c.module) ?? c.module}</span>
                  </li>
                ))}
                {results.axioms.map((a) => (
                  <li key={a.id}>
                    <a href={`#/ontology/${encodeURIComponent(a.id)}`}>{a.label}</a>
                    <span className="tiny muted"> · axiom {a.id}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="card">
              <div className="card-head">
                <h2>Modules</h2>
              </div>
              <div className="card-pad row-wrap" style={{ paddingTop: 12 }}>
                {closeOntology.spec.modules.map((m) => (
                  <button key={m.id} type="button" className={`chip${activeModule === m.id ? ' active' : ''}`} aria-pressed={activeModule === m.id} onClick={() => setModule(m.id)} title={m.description}>
                    {m.label}
                  </button>
                ))}
              </div>
              {activeModule && (
                <ul className="list small term-list">
                  {moduleClasses.map((c) => (
                    <li key={c.id}>
                      <a href={`#/ontology/${encodeURIComponent(c.id)}`} aria-current={c.id === termId ? 'true' : undefined}>
                        {c.label}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </aside>
        <div className="stack" style={{ gap: 16, minWidth: 0 }}>
          {termId && term.error && <ErrorBox error={term.error} onRetry={term.reload} />}
          {termId && !term.data && !term.error && <Skeleton rows={6} />}
          {term.data && <TermCard t={term.data} />}
          {!termId && (
            <div className="callout small">
              Pick a term on the left or click a node in the graph. Dotted words throughout Bookhand open the same definitions inline.
            </div>
          )}
          {activeModule && <OntologyGraph module={activeModule} selected={termId} />}
        </div>
      </div>
    </div>
  );
}

function TermCard({ t }: { t: TermDetail }) {
  return (
    <section className="card" aria-labelledby="term-h">
      <div className="card-head">
        <div>
          <h2 id="term-h" style={{ fontSize: 20 }}>
            {t.label}
          </h2>
          <div className="tiny muted mono">
            {t.id} · {t.kind}
            {t.module ? ` · ${MODULE_LABEL.get(t.module) ?? t.module}` : ''}
          </div>
        </div>
        {t.table && <Badge tone="info">table {t.table}</Badge>}
      </div>
      <div className="card-pad stack" style={{ gap: 14 }}>
        {t.ancestors.length > 0 && (
          <nav aria-label="Ancestors" className="row-wrap small">
            {[...t.ancestors].reverse().map((a) => (
              <span key={a.id} className="row" style={{ gap: 6 }}>
                <a href={`#/ontology/${encodeURIComponent(a.id)}`}>{a.label}</a>
                <span className="muted" aria-hidden="true">
                  ›
                </span>
              </span>
            ))}
            <strong>{t.label}</strong>
          </nav>
        )}
        <p style={{ fontSize: 15 }}>{t.definition}</p>
        {t.whyItMatters && (
          <div className="callout small">
            <strong>Why it matters:</strong> {t.whyItMatters}
          </div>
        )}
        {t.example && (
          <p className="small text-2">
            <strong>Example:</strong> {t.example}
          </p>
        )}
        {t.formal && <pre className="code">{t.formal}</pre>}
        {(t.accountClass || t.normalBalance || t.fsLine) && (
          <dl className="facts small">
            {t.accountClass && (
              <>
                <dt>Account class</dt>
                <dd>{label(t.accountClass)}</dd>
              </>
            )}
            {t.normalBalance && (
              <>
                <dt>Normal balance</dt>
                <dd>{label(t.normalBalance)}</dd>
              </>
            )}
            {t.fsLine && (
              <>
                <dt>Statement line</dt>
                <dd>{closeOntology.term(`bh:FS_${t.fsLine.replace(/\./g, '_')}`)?.label ?? t.fsLine}</dd>
              </>
            )}
          </dl>
        )}
        {t.bucketing && (
          <div className="small">
            <div className="label" style={{ marginBottom: 4 }}>
              Bucketing profile {t.bucketing.capitalizable ? '(capitalizable above the threshold)' : ''}
            </div>
            <div className="row-wrap">
              {t.bucketing.keywords.slice(0, 18).map((k) => (
                <Badge key={k}>{k}</Badge>
              ))}
              {t.bucketing.mcc?.map((m) => (
                <Badge key={m} tone="info">
                  MCC {m}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {t.assertions.length > 0 && (
          <div className="row-wrap small">
            <span className="label">Assertions</span>
            {t.assertions.map((a) => (
              <Badge key={a}>{label(a)}</Badge>
            ))}
          </div>
        )}
        {t.properties.length > 0 && (
          <div className="table-wrap card">
            <table className="table">
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Range</th>
                  <th>Cardinality</th>
                </tr>
              </thead>
              <tbody>
                {t.properties.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.label}
                      <div className="tiny muted">{p.definition}</div>
                    </td>
                    <td className="mono small">{p.range.startsWith('bh:') ? <a href={`#/ontology/${encodeURIComponent(p.range)}`}>{p.range}</a> : p.range}</td>
                    <td className="mono small">{p.cardinality}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {t.axioms.length > 0 && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Axioms enforced ({t.axioms.length})
            </div>
            <ul className="list card small">
              {t.axioms.map((a) => (
                <li key={a.id}>
                  <div className="row">
                    <a href={`#/ontology/${encodeURIComponent(a.id)}`} className="mono tiny">
                      {a.id}
                    </a>
                    <strong className="grow">{a.label}</strong>
                    <Badge tone={a.severity === 'error' ? 'danger' : 'attention'}>{a.severity}</Badge>
                  </div>
                  <div className="text-2">{a.plainEnglish}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {t.children.length > 0 && (
          <div className="row-wrap small">
            <span className="label">Narrower terms</span>
            {t.children.map((c) => (
              <a key={c.id} href={`#/ontology/${encodeURIComponent(c.id)}`}>
                <Badge tone="info">{c.label}</Badge>
              </a>
            ))}
          </div>
        )}
        {((t.standards?.length ?? 0) > 0 || (t.citations?.length ?? 0) > 0) && (
          <div className="small">
            <div className="label" style={{ marginBottom: 4 }}>
              Grounding
            </div>
            <ul className="refs">
              {t.standards?.map((s, i) => (
                <li key={`s${i}`}>
                  <strong>{s.source}</strong> {s.ref}
                  {s.note ? ` · ${s.note}` : ''}
                </li>
              ))}
              {t.citations?.map((c) => (
                <li key={c.key}>{c.text}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

interface GNode extends SimulationNodeDatum {
  id: string;
  label: string;
  module: string;
  degree: number;
}

interface GLink extends SimulationLinkDatum<GNode> {
  kind: 'subClassOf' | 'relation';
  label?: string;
}

function OntologyGraph({ module, selected }: { module: string; selected: string | null }) {
  const { data, error, reload } = useApi<GraphData>(`/api/ontology/graph${qs({ module })}`);
  const layout = useMemo(() => {
    if (!data) return null;
    const nodes: GNode[] = data.nodes.map((n) => ({ id: n.id, label: n.label, module: n.module, degree: n.degree }));
    const ids = new Set(nodes.map((n) => n.id));
    const links: GLink[] = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target).map((e) => ({ source: e.source, target: e.target, kind: e.kind, label: e.label }));
    const sim = forceSimulation<GNode>(nodes)
      .force('link', forceLink<GNode, GLink>(links).id((d) => d.id).distance((l) => (l.kind === 'subClassOf' ? 56 : 96)).strength(0.5))
      .force('charge', forceManyBody<GNode>().strength(-190))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide<GNode>(26))
      .force('x', forceX<GNode>(0).strength(0.05))
      .force('y', forceY<GNode>(0).strength(0.08))
      .stop();
    for (let i = 0; i < 320; i++) sim.tick();
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const minX = Math.min(...xs) - 90;
    const minY = Math.min(...ys) - 40;
    const w = Math.max(...xs) - minX + 90;
    const h = Math.max(...ys) - minY + 40;
    return { nodes, links, viewBox: `${minX} ${minY} ${w} ${h}`, width: Math.round(w), height: Math.round(h) };
  }, [data]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!layout) return <Skeleton rows={6} />;
  if (!layout.nodes.length) return <Empty title="Nothing to draw" icon={<Network size={26} aria-hidden="true" />} />;
  return (
    <section className="card" aria-labelledby="graph-h">
      <div className="card-head">
        <h2 id="graph-h">
          {MODULE_LABEL.get(module) ?? module}: {layout.nodes.length} terms
        </h2>
        <span className="tiny muted row-wrap">
          <span className="legend-line" aria-hidden="true" /> is a
          <span className="legend-line dashed" aria-hidden="true" /> related to
        </span>
      </div>
      <div className="graph-wrap">
        <svg viewBox={layout.viewBox} width={layout.width} height={layout.height} className="onto-graph" role="group" aria-label={`Graph of ${MODULE_LABEL.get(module) ?? module} terms. Each node links to its definition.`}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="arrowhead" />
            </marker>
          </defs>
          {layout.links.map((l, i) => {
            const s = l.source as GNode;
            const t = l.target as GNode;
            return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} className={`edge ${l.kind}`} markerEnd={l.kind === 'subClassOf' ? 'url(#arrow)' : undefined} />;
          })}
          {layout.nodes.map((n) => {
            const hue = MODULE_HUE.get(n.module) ?? 200;
            const r = 6 + Math.min(10, Math.sqrt(n.degree) * 2);
            const isSel = n.id === selected;
            return (
              <a
                key={n.id}
                href={`#/ontology/${encodeURIComponent(n.id)}`}
                className={`node${isSel ? ' selected' : ''}${n.module !== module ? ' foreign' : ''}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/ontology/${encodeURIComponent(n.id)}`);
                }}
              >
                <title>{n.label}</title>
                <circle cx={n.x} cy={n.y} r={isSel ? r + 4 : r} style={{ fill: `hsl(${hue} 55% 50%)` }} />
                <text x={(n.x ?? 0) + r + 4} y={(n.y ?? 0) + 4}>
                  {n.label}
                </text>
              </a>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

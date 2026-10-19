/**
 * Ontology explorer: the versioned close ontology (classes, relations, executable axioms,
 * glossary, standards mappings and citations), with deep links and JSON-LD / Turtle export.
 */
import { Download, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiText, type OntologyData } from '../api';
import { Badge, Dialog, ErrorBox, Loading, Segmented } from '../components/ui';
import { useData } from '../lib/app-state';
import { titleCase } from '../lib/format';
import { setQuery, useRoute } from '../lib/router';

type Cls = OntologyData['classes'][number];

export function Ontology() {
  const route = useRoute();
  const { data, error, reload } = useData(() => api<OntologyData>('/ontology'), []);
  const axiomParam = route.query.get('axiom');
  const view = (route.query.get('view') as 'classes' | 'axioms' | 'glossary' | 'changelog' | null) ?? (axiomParam ? 'axioms' : 'classes');
  const [exporting, setExporting] = useState<null | { format: 'jsonld' | 'ttl'; text: string }>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;

  async function openExport(format: 'jsonld' | 'ttl') {
    const text = await apiText(`/ontology/export.${format}`);
    setExporting({ format, text });
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Close ontology</h1>
          <p className="lede">
            The shared vocabulary of the close. Agents are grounded in it, proposals are validated against its axioms, transactions are bucketed by its classes, and every underlined term in the app explains itself from here.
          </p>
          <div className="muted mono" style={{ fontSize: 12 }}>
            v{data.version} · {data.hash.slice(0, 16)} · {data.stats.classes} classes · {data.stats.relations} relations · {data.stats.axioms} axioms ({data.stats.executableAxioms} executable) · {data.stats.terms} terms · {data.stats.citations} sources
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => void openExport('jsonld')}>
            <Download className="icon" aria-hidden="true" /> JSON-LD
          </button>
          <button className="btn" onClick={() => void openExport('ttl')}>
            <Download className="icon" aria-hidden="true" /> Turtle
          </button>
        </div>
      </div>
      <div style={{ marginBottom: 14 }}>
        <Segmented
          label="View"
          value={view}
          onChange={(v) => {
            setQuery('axiom', null);
            setQuery('view', v === 'classes' ? null : v);
          }}
          options={[
            { value: 'classes', label: 'Classes' },
            { value: 'axioms', label: 'Axioms' },
            { value: 'glossary', label: 'Glossary' },
            { value: 'changelog', label: 'Versions & sources' },
          ]}
        />
      </div>
      {view === 'classes' ? <Classes data={data} selected={route.query.get('class')} /> : null}
      {view === 'axioms' ? <Axioms data={data} focus={axiomParam} /> : null}
      {view === 'glossary' ? <Glossary data={data} /> : null}
      {view === 'changelog' ? <Sources data={data} /> : null}
      <ExportDialog value={exporting} onClose={() => setExporting(null)} />
    </div>
  );
}

function ExportDialog({ value, onClose }: { value: null | { format: 'jsonld' | 'ttl'; text: string }; onClose: () => void }) {
  const url = useMemo(() => {
    if (!value) return null;
    try {
      return URL.createObjectURL(new Blob([value.text], { type: value.format === 'jsonld' ? 'application/ld+json' : 'text/turtle' }));
    } catch {
      return null;
    }
  }, [value]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title={value?.format === 'jsonld' ? 'Ontology as JSON-LD' : 'Ontology as Turtle (RDF)'}
      actions={
        <>
          {url ? (
            <a className="btn" href={url} download={`tieout-ontology.${value?.format === 'jsonld' ? 'jsonld' : 'ttl'}`}>
              <Download className="icon" aria-hidden="true" /> Download
            </a>
          ) : null}
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Classes are OWL classes with SKOS labels and definitions; axioms carry their formal statement. Load it into Protégé or any RDF store.
      </p>
      <pre className="doc" tabIndex={0} style={{ maxHeight: 360 }}>
        {value?.text.slice(0, 60_000)}
        {value && value.text.length > 60_000 ? '\n…' : ''}
      </pre>
    </Dialog>
  );
}

function Classes({ data, selected }: { data: OntologyData; selected: string | null }) {
  const [q, setQ] = useState('');
  const byId = useMemo(() => new Map(data.classes.map((c) => [c.id, c])), [data]);
  const sel = (selected && byId.get(selected)) || data.classes.find((c) => c.id === 'tie:BankReconciliation') || data.classes[0]!;
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (c: Cls) => !needle || c.label.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle) || c.synonyms.some((s) => s.toLowerCase().includes(needle)) || c.definition.toLowerCase().includes(needle);
    const m = new Map<string, Cls[]>();
    for (const c of data.classes) if (match(c)) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m.entries()];
  }, [data, q]);
  const children = data.classes.filter((c) => c.parents.includes(sel.id));
  const axioms = data.axioms.filter((a) => a.appliesTo.includes(sel.id) || sel.parents.some((p) => a.appliesTo.includes(p)));
  const rels = data.relations.filter((r) => r.domain === sel.id || r.range === sel.id);
  const cites = data.citations.filter((c) => sel.citations.includes(c.id));
  const detailRef = useRef<HTMLElement>(null);

  function pick(id: string) {
    setQuery('class', id);
    window.setTimeout(() => detailRef.current?.focus(), 0);
  }

  return (
    <div className="onto-layout">
      <nav className="card card-pad" aria-label="Ontology classes" style={{ maxHeight: '75vh', overflow: 'auto' }}>
        <label className="field" style={{ marginBottom: 10 }}>
          <span className="sr-only">Search classes</span>
          <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <Search className="icon muted" aria-hidden="true" />
            <input type="search" placeholder="Search classes, synonyms…" value={q} onChange={(e) => setQ(e.target.value)} />
          </span>
        </label>
        {groups.length === 0 ? <p className="muted">No class matches “{q}”.</p> : null}
        {groups.map(([g, list]) => (
          <details key={g} open={!!q || list.some((c) => c.id === sel.id)}>
            <summary style={{ fontWeight: 650, padding: '4px 0' }}>
              {titleCase(g)} <span className="muted">({list.length})</span>
            </summary>
            <ul className="tree">
              {list.map((c) => (
                <li key={c.id}>
                  <button aria-current={c.id === sel.id} onClick={() => pick(c.id)} title={c.id}>
                    {c.label}
                    {c.abstract ? <span className="muted"> (abstract)</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </nav>

      <article className="card card-pad stack" ref={detailRef} tabIndex={-1} aria-labelledby="cls-h" style={{ outline: 'none' }}>
        <div>
          <div className="muted mono" style={{ fontSize: 12 }}>
            {sel.id}
          </div>
          <h2 id="cls-h" style={{ margin: '2px 0 4px', fontSize: 26 }}>
            {sel.label}
          </h2>
          <div className="row" style={{ gap: 6 }}>
            <Badge icon={false}>{titleCase(sel.group)}</Badge>
            {sel.rea ? (
              <Badge tone="info" icon={false} title="Role in the REA accounting model (McCarthy 1982)">
                REA: {sel.rea}
              </Badge>
            ) : null}
            {sel.abstract ? <Badge icon={false}>Abstract</Badge> : null}
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 17 }}>{sel.definition}</p>
        <div className="split">
          <div>
            <h3>Why it matters</h3>
            <p style={{ margin: 0 }}>{sel.whyItMatters}</p>
          </div>
          <div>
            <h3>Example</h3>
            <p style={{ margin: 0 }}>{sel.example}</p>
          </div>
        </div>
        <dl className="kv">
          {sel.synonyms.length ? (
            <>
              <dt>Also called</dt>
              <dd>{sel.synonyms.join(', ')}</dd>
            </>
          ) : null}
          <dt>Is a kind of</dt>
          <dd>
            {sel.parents.length
              ? sel.parents.map((p, i) => (
                  <span key={p}>
                    {i ? ', ' : ''}
                    <button className="linklike" onClick={() => pick(p)}>
                      {byId.get(p)?.label ?? p}
                    </button>
                  </span>
                ))
              : '—'}
          </dd>
          {children.length ? (
            <>
              <dt>Kinds</dt>
              <dd>
                {children.map((c, i) => (
                  <span key={c.id}>
                    {i ? ', ' : ''}
                    <button className="linklike" onClick={() => pick(c.id)}>
                      {c.label}
                    </button>
                  </span>
                ))}
              </dd>
            </>
          ) : null}
          {sel.mappings.length ? (
            <>
              <dt>Standards</dt>
              <dd>
                {sel.mappings.map((m, i) => (
                  <span key={i}>
                    {i ? ' · ' : ''}
                    <span className="mono" style={{ fontSize: 13 }}>
                      {m.scheme} {m.ref}
                    </span>
                    {m.match ? <span className="muted"> ({m.match})</span> : null}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
        {sel.properties.length ? (
          <section>
            <h3>Properties</h3>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Property</th>
                    <th scope="col">Type</th>
                    <th scope="col">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {sel.properties.map((p) => (
                    <tr key={p.name}>
                      <td>
                        <span className="mono">{p.name}</span>
                        {p.required ? <span className="muted"> · required</span> : null}
                      </td>
                      <td className="mono muted">{p.range}</td>
                      <td>{p.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
        {rels.length ? (
          <section>
            <h3>Relations</h3>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {rels.map((r) => (
                <li key={r.id}>
                  <button className="linklike" onClick={() => pick(r.domain)}>
                    {byId.get(r.domain)?.label ?? r.domain}
                  </button>{' '}
                  <em>{r.label}</em>{' '}
                  <button className="linklike" onClick={() => pick(r.range)}>
                    {byId.get(r.range)?.label ?? r.range}
                  </button>
                  {r.cardinality ? <span className="muted"> ({r.cardinality})</span> : null}
                  <span className="muted"> · {r.description}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {axioms.length ? (
          <section>
            <h3>Axioms</h3>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {axioms.map((a) => (
                <li key={a.id}>
                  <a href={`#/ontology?axiom=${a.id}`} className="mono">
                    {a.id}
                  </a>{' '}
                  {a.title}: <span className="muted">{a.plainEnglish}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {cites.length ? (
          <section>
            <h3>Sources</h3>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
              {cites.map((c) => (
                <li key={c.id}>{c.full}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </article>
    </div>
  );
}

function Axioms({ data, focus }: { data: OntologyData; focus: string | null }) {
  const [sev, setSev] = useState<'all' | 'error' | 'warning'>('all');
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'center' });
    if (focus) ref.current?.focus();
  }, [focus]);
  const byId = new Map(data.classes.map((c) => [c.id, c.label]));
  const list = data.axioms.filter((a) => sev === 'all' || a.severity === sev);
  return (
    <section className="stack">
      <div className="row">
        <Segmented
          label="Severity"
          value={sev}
          onChange={setSev}
          options={[
            { value: 'all', label: `All (${data.axioms.length})` },
            { value: 'error', label: 'Errors' },
            { value: 'warning', label: 'Warnings' },
          ]}
        />
        <span className="muted" style={{ fontSize: 13 }}>
          Enforced by: ontology checks in the app, database constraints and triggers, the agent runtime, and the UI.
        </span>
      </div>
      <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {list.map((a) => (
          <li key={a.id} ref={a.id === focus ? ref : undefined} tabIndex={a.id === focus ? -1 : undefined} className="card card-pad stack" style={{ gap: 8, outline: a.id === focus ? '2px solid var(--accent)' : undefined }} id={a.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>
                <span className="mono">{a.id}</span> {a.title}
              </h2>
              <div className="row" style={{ gap: 6 }}>
                {a.severity === 'error' ? <Badge tone="bad">Blocks</Badge> : <Badge tone="warn">Warns</Badge>}
                {a.executable ? <Badge tone="good">Executable</Badge> : null}
              </div>
            </div>
            <p style={{ margin: 0 }}>{a.plainEnglish}</p>
            <div className="formal" aria-label="Formal statement">
              {a.formal}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              Applies to {a.appliesTo.map((x) => byId.get(x) ?? x).join(', ')} · enforced by {a.enforcedBy.join(', ')}
              {a.citations.length ? ` · ${a.citations.map((c) => data.citations.find((x) => x.id === c)?.short ?? c).join('; ')}` : ''}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Glossary({ data }: { data: OntologyData }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const terms = data.terms.filter((t) => !needle || t.label.toLowerCase().includes(needle) || t.synonyms.some((s) => s.toLowerCase().includes(needle))).sort((a, b) => a.label.localeCompare(b.label));
  return (
    <section className="card card-pad stack">
      <label className="field">
        Find a term
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="accrual, cut-off, CTA…" />
      </label>
      <dl className="stack" style={{ margin: 0, gap: 12 }}>
        {terms.map((t) => (
          <div key={t.id}>
            <dt style={{ fontWeight: 650 }}>
              {t.label}
              {t.synonyms.length ? <span className="muted" style={{ fontWeight: 400 }}> · {t.synonyms.join(', ')}</span> : null}
              {t.classId ? (
                <>
                  {' '}
                  <a href={`#/ontology?class=${encodeURIComponent(t.classId)}`} style={{ fontSize: 13, fontWeight: 400 }}>
                    class
                  </a>
                </>
              ) : null}
            </dt>
            <dd style={{ margin: 0 }}>{t.definition}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Sources({ data }: { data: OntologyData }) {
  return (
    <div className="grid cols-2">
      <section className="card card-pad">
        <h2 style={{ marginTop: 0 }}>Versions</h2>
        <ul style={{ paddingLeft: 18 }}>
          {[...data.changelog].reverse().map((c) => (
            <li key={c.version}>
              <strong className="mono">{c.version}</strong> <span className="muted">({c.date})</span>: {c.notes}
            </li>
          ))}
        </ul>
        <p className="muted" style={{ fontSize: 13 }}>
          The ontology is code: it is versioned with the app, hashed (the hash is stamped on every agent run) and checked in CI.
        </p>
      </section>
      <section className="card card-pad">
        <h2 style={{ marginTop: 0 }}>Sources</h2>
        <ul style={{ paddingLeft: 18, fontSize: 14 }}>
          {data.citations.map((c) => (
            <li key={c.id}>
              {c.full} <span className="muted">({c.kind})</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

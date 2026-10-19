import { z } from 'zod';
import { stableStringify } from '../util/canonical';
import { sha256Hex } from '../util/sha256';
import type {
  Axiom,
  Citation,
  GraphEdge,
  GraphNode,
  Individual,
  OntologyClass,
  OntologyRelation,
  OntologySpec,
  TermExplanation,
  ValidationResult,
  Violation,
} from './types';

export class OntologyIntegrityError extends Error {
  constructor(readonly problems: string[]) {
    super(`Ontology integrity check failed:\n - ${problems.join('\n - ')}`);
    this.name = 'OntologyIntegrityError';
  }
}

const XSD = new Set([
  'xsd:string', 'xsd:decimal', 'xsd:integer', 'xsd:boolean', 'xsd:date', 'xsd:dateTime', 'xsd:gYearMonth', 'xsd:anyURI',
]);

/**
 * Compiled, queryable ontology. Construction fails fast when the spec is not internally
 * consistent (dangling references, cycles, missing definitions), so a broken ontology can
 * never ship: the integrity check runs in unit tests and at application start.
 */
export class OntologyModel {
  readonly spec: OntologySpec;
  readonly version: string;
  readonly contentHash: string;
  private readonly classes = new Map<string, OntologyClass>();
  private readonly relations = new Map<string, OntologyRelation>();
  private readonly individuals = new Map<string, Individual>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly axioms = new Map<string, Axiom<any, any>>();
  private readonly citations = new Map<string, Citation>();
  private readonly ancestorCache = new Map<string, string[]>();

  constructor(spec: OntologySpec) {
    this.spec = spec;
    this.version = spec.version;
    const problems: string[] = [];
    const seen = new Set<string>();
    const register = <T extends { id: string }>(map: Map<string, T>, items: T[], kind: string) => {
      for (const item of items) {
        if (seen.has(item.id)) problems.push(`duplicate id ${item.id} (${kind})`);
        seen.add(item.id);
        map.set(item.id, item);
      }
    };
    register(this.classes, spec.classes, 'class');
    register(this.relations, spec.relations, 'relation');
    register(this.individuals, spec.individuals, 'individual');
    register(this.axioms, spec.axioms, 'axiom');
    for (const c of spec.citations) {
      if (this.citations.has(c.id)) problems.push(`duplicate citation ${c.id}`);
      this.citations.set(c.id, c);
    }
    const moduleIds = new Set(spec.modules.map((m) => m.id));

    for (const c of spec.classes) {
      if (!c.id.startsWith(`${spec.prefix}:`)) problems.push(`class ${c.id} outside prefix ${spec.prefix}`);
      if (!moduleIds.has(c.module)) problems.push(`class ${c.id} has unknown module ${c.module}`);
      for (const p of c.parents) if (!this.classes.has(p)) problems.push(`class ${c.id} has unknown parent ${p}`);
      for (const f of ['label', 'definition', 'plain', 'why', 'example'] as const) {
        if (!c[f] || c[f].trim().length < 3) problems.push(`class ${c.id} is missing ${f}`);
      }
      for (const s of c.sources ?? []) if (!this.citations.has(s)) problems.push(`class ${c.id} cites unknown source ${s}`);
      for (const p of c.properties ?? []) {
        if (!XSD.has(p.range) && !this.classes.has(p.range)) problems.push(`property ${c.id}.${p.id} has unknown range ${p.range}`);
      }
    }
    for (const r of spec.relations) {
      if (!this.classes.has(r.domain)) problems.push(`relation ${r.id} has unknown domain ${r.domain}`);
      if (!this.classes.has(r.range) && !XSD.has(r.range)) problems.push(`relation ${r.id} has unknown range ${r.range}`);
      if (r.inverse && !spec.relations.some((x) => x.id === r.inverse)) problems.push(`relation ${r.id} has unknown inverse ${r.inverse}`);
      for (const s of r.sources ?? []) if (!this.citations.has(s)) problems.push(`relation ${r.id} cites unknown source ${s}`);
    }
    for (const i of spec.individuals) {
      if (!this.classes.has(i.type)) problems.push(`individual ${i.id} has unknown type ${i.type}`);
      for (const s of i.sources ?? []) if (!this.citations.has(s)) problems.push(`individual ${i.id} cites unknown source ${s}`);
    }
    for (const a of spec.axioms) {
      if (!this.classes.has(a.appliesTo)) problems.push(`axiom ${a.id} applies to unknown class ${a.appliesTo}`);
      if (!a.formal || !a.plain) problems.push(`axiom ${a.id} needs formal and plain statements`);
      for (const s of a.sources) if (!this.citations.has(s)) problems.push(`axiom ${a.id} cites unknown source ${s}`);
    }
    for (const key of Object.keys(spec.shapes)) {
      if (!this.classes.has(key)) problems.push(`shape for unknown class ${key}`);
    }
    // Acyclic subclass hierarchy
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string, path: string[]) => {
      if (done.has(id)) return;
      if (visiting.has(id)) {
        problems.push(`subclass cycle: ${[...path, id].join(' -> ')}`);
        return;
      }
      visiting.add(id);
      for (const p of this.classes.get(id)?.parents ?? []) visit(p, [...path, id]);
      visiting.delete(id);
      done.add(id);
    };
    for (const id of this.classes.keys()) visit(id, []);

    if (problems.length) throw new OntologyIntegrityError(problems);
    this.contentHash = sha256Hex(stableStringify(this.toJsonLd()));
  }

  // ---------------------------------------------------------------- queries

  hasClass(id: string): boolean {
    return this.classes.has(id);
  }

  cls(id: string): OntologyClass {
    const c = this.classes.get(id);
    if (!c) throw new Error(`unknown ontology class ${id}`);
    return c;
  }

  allClasses(): OntologyClass[] {
    return [...this.classes.values()];
  }

  allRelations(): OntologyRelation[] {
    return [...this.relations.values()];
  }

  allIndividuals(): Individual[] {
    return [...this.individuals.values()];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  allAxioms(): Axiom<any, any>[] {
    return [...this.axioms.values()];
  }

  individual(id: string): Individual {
    const i = this.individuals.get(id);
    if (!i) throw new Error(`unknown ontology individual ${id}`);
    return i;
  }

  individualsOf(classId: string): Individual[] {
    return this.allIndividuals().filter((i) => this.isA(i.type, classId));
  }

  axiom(id: string): Axiom<unknown, unknown> {
    const a = this.axioms.get(id);
    if (!a) throw new Error(`unknown axiom ${id}`);
    return a;
  }

  citation(id: string): Citation | undefined {
    return this.citations.get(id);
  }

  ancestors(id: string): string[] {
    const cached = this.ancestorCache.get(id);
    if (cached) return cached;
    const out: string[] = [];
    const walk = (cid: string) => {
      for (const p of this.classes.get(cid)?.parents ?? []) {
        if (!out.includes(p)) {
          out.push(p);
          walk(p);
        }
      }
    };
    walk(id);
    this.ancestorCache.set(id, out);
    return out;
  }

  isA(id: string, ancestor: string): boolean {
    return id === ancestor || this.ancestors(id).includes(ancestor);
  }

  descendants(id: string): string[] {
    return this.allClasses()
      .filter((c) => c.id !== id && this.isA(c.id, id))
      .map((c) => c.id);
  }

  children(id: string): OntologyClass[] {
    return this.allClasses().filter((c) => c.parents.includes(id));
  }

  relationsOf(classId: string): { outgoing: OntologyRelation[]; incoming: OntologyRelation[] } {
    const chain = [classId, ...this.ancestors(classId)];
    return {
      outgoing: this.allRelations().filter((r) => chain.includes(r.domain)),
      incoming: this.allRelations().filter((r) => chain.includes(r.range)),
    };
  }

  /** Axioms that apply to a class, including those inherited from ancestors. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  axiomsFor(classId: string): Axiom<any, any>[] {
    const chain = new Set([classId, ...this.ancestors(classId)]);
    return this.allAxioms().filter((a) => chain.has(a.appliesTo));
  }

  shape(classId: string): z.ZodType | undefined {
    if (this.spec.shapes[classId]) return this.spec.shapes[classId];
    for (const a of this.ancestors(classId)) if (this.spec.shapes[a]) return this.spec.shapes[a];
    return undefined;
  }

  /** JSON Schema for a class shape (used to type LLM tool inputs). */
  jsonSchema(classId: string): Record<string, unknown> {
    const shape = this.shape(classId);
    if (!shape) throw new Error(`class ${classId} has no shape`);
    return z.toJSONSchema(shape, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  }

  /** Classes carrying a given annotation key (e.g. "keywords" for bucketing). */
  annotated(key: string): OntologyClass[] {
    return this.allClasses().filter((c) => c.annotations && key in c.annotations);
  }

  // ------------------------------------------------------------- validation

  /**
   * Validate an instance against its class: first the shape (structure/types), then every
   * applicable axiom (semantics). Axiom checks that throw are reported, never swallowed.
   */
  validate<S, C>(classId: string, subject: S, ctx: C, opts: { only?: string[]; skip?: string[] } = {}): ValidationResult {
    const violations: Violation[] = [];
    const checked: string[] = [];
    const shape = this.shape(classId);
    if (shape) {
      const parsed = shape.safeParse(subject);
      checked.push(`shape:${classId}`);
      if (!parsed.success) {
        for (const issue of parsed.error.issues.slice(0, 20)) {
          violations.push({
            axiomId: `shape:${classId}`,
            axiomName: `${this.cls(classId).label} structure`,
            severity: 'error',
            message: issue.message,
            path: issue.path.join('.'),
          });
        }
        return { ok: false, violations, checked };
      }
    }
    for (const ax of this.axiomsFor(classId)) {
      if (opts.only && !opts.only.includes(ax.id)) continue;
      if (opts.skip?.includes(ax.id)) continue;
      checked.push(ax.id);
      try {
        for (const f of ax.check(subject, ctx)) {
          violations.push({ axiomId: ax.id, axiomName: ax.name, severity: ax.severity, message: f.message, path: f.path, data: f.data });
        }
      } catch (e) {
        violations.push({
          axiomId: ax.id,
          axiomName: ax.name,
          severity: 'error',
          message: `rule could not be evaluated: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    return { ok: !violations.some((v) => v.severity === 'error'), violations, checked };
  }

  // ------------------------------------------------------------ explanation

  explain(id: string): TermExplanation | undefined {
    const cites = (ids: string[] | undefined) => (ids ?? []).map((s) => this.citations.get(s)).filter((c): c is Citation => !!c);
    const c = this.classes.get(id);
    if (c) {
      return {
        id,
        label: c.label,
        kind: 'class',
        plain: c.plain,
        definition: c.definition,
        why: c.why,
        example: c.example,
        sources: cites(c.sources),
        parents: c.parents.map((p) => ({ id: p, label: this.cls(p).label })),
      };
    }
    const i = this.individuals.get(id);
    if (i) {
      return { id, label: i.label, kind: 'individual', plain: i.plain ?? i.definition, definition: i.definition, sources: cites(i.sources), parents: [{ id: i.type, label: this.cls(i.type).label }] };
    }
    const r = this.relations.get(id);
    if (r) return { id, label: r.label, kind: 'relation', plain: r.definition, definition: `${r.domain} → ${r.range} (${r.cardinality})`, sources: cites(r.sources) };
    const a = this.axioms.get(id);
    if (a) return { id, label: a.name, kind: 'axiom', plain: a.plain, definition: a.formal, sources: cites(a.sources) };
    return undefined;
  }

  /** Case-insensitive search over labels, synonyms and definitions. */
  search(query: string, limit = 25): TermExplanation[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored: { id: string; score: number }[] = [];
    const consider = (id: string, label: string, extra: string[], text: string) => {
      const l = label.toLowerCase();
      let score = 0;
      if (l === q) score = 100;
      else if (l.startsWith(q)) score = 80;
      else if (l.includes(q)) score = 60;
      else if (extra.some((s) => s.toLowerCase().includes(q))) score = 50;
      else if (id.toLowerCase().includes(q)) score = 40;
      else if (text.toLowerCase().includes(q)) score = 20;
      if (score) scored.push({ id, score });
    };
    for (const c of this.classes.values()) consider(c.id, c.label, c.synonyms ?? [], `${c.plain} ${c.definition}`);
    for (const i of this.individuals.values()) consider(i.id, i.label, [], i.definition);
    for (const a of this.axioms.values()) consider(a.id, a.name, [], a.plain);
    for (const r of this.relations.values()) consider(r.id, r.label, [], r.definition);
    return scored
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((s) => this.explain(s.id)!)
      .filter(Boolean);
  }

  // -------------------------------------------------------------------- graph

  graph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const edges: GraphEdge[] = [];
    for (const c of this.classes.values()) {
      for (const p of c.parents) edges.push({ source: c.id, target: p, kind: 'subClassOf', label: 'is a' });
    }
    for (const r of this.relations.values()) {
      if (this.classes.has(r.range)) edges.push({ source: r.domain, target: r.range, kind: 'relation', label: r.label });
    }
    for (const i of this.individuals.values()) edges.push({ source: i.id, target: i.type, kind: 'instanceOf', label: 'instance of' });
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const nodes: GraphNode[] = [
      ...[...this.classes.values()].map((c) => ({ id: c.id, label: c.label, module: c.module, kind: 'class' as const, degree: degree.get(c.id) ?? 0 })),
      ...[...this.individuals.values()].map((i) => ({
        id: i.id,
        label: i.label,
        module: this.classes.get(i.type)?.module ?? 'misc',
        kind: 'individual' as const,
        degree: degree.get(i.id) ?? 0,
      })),
    ];
    return { nodes, edges };
  }

  // ------------------------------------------------------------------ export

  /** JSON-LD using OWL, RDFS, SKOS, SHACL and Dublin Core terms. */
  toJsonLd(): Record<string, unknown> {
    const p = this.spec.prefix;
    const graph: Record<string, unknown>[] = [];
    graph.push({
      '@id': this.spec.iri,
      '@type': 'owl:Ontology',
      'dcterms:title': this.spec.title,
      'dcterms:description': this.spec.description,
      'owl:versionInfo': this.spec.version,
    });
    const mapEntries = (m: OntologyClass['mappings']) =>
      Object.entries(m ?? {}).flatMap(([scheme, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${scheme}:${x}`));
    for (const c of this.classes.values()) {
      graph.push({
        '@id': c.id,
        '@type': 'owl:Class',
        'rdfs:label': c.label,
        'rdfs:subClassOf': c.parents.map((x) => ({ '@id': x })),
        'skos:definition': c.definition,
        'skos:scopeNote': c.why,
        'skos:example': c.example,
        'rdfs:comment': c.plain,
        'skos:altLabel': c.synonyms ?? [],
        'skos:closeMatch': mapEntries(c.mappings),
        'dcterms:source': (c.sources ?? []).map((s) => ({ '@id': `cite:${s}` })),
        [`${p}:module`]: c.module,
        ...(c.abstract ? { [`${p}:abstract`]: true } : {}),
      });
      if (c.properties?.length) {
        graph.push({
          '@id': `${c.id}Shape`,
          '@type': 'sh:NodeShape',
          'sh:targetClass': { '@id': c.id },
          'sh:property': c.properties.map((prop) => ({
            'sh:path': { '@id': `${p}:${prop.id}` },
            'sh:name': prop.label,
            'sh:description': prop.definition,
            ...(prop.range.startsWith('xsd:') ? { 'sh:datatype': { '@id': prop.range } } : { 'sh:class': { '@id': prop.range } }),
            ...(prop.cardinality.startsWith('1') ? { 'sh:minCount': 1 } : {}),
            ...(prop.cardinality.endsWith('1') ? { 'sh:maxCount': 1 } : {}),
          })),
        });
      }
    }
    for (const r of this.relations.values()) {
      graph.push({
        '@id': r.id,
        '@type': 'owl:ObjectProperty',
        'rdfs:label': r.label,
        'rdfs:domain': { '@id': r.domain },
        'rdfs:range': { '@id': r.range },
        'skos:definition': r.definition,
        ...(r.inverse ? { 'owl:inverseOf': { '@id': r.inverse } } : {}),
        ...(r.transitive ? { '@type': ['owl:ObjectProperty', 'owl:TransitiveProperty'] } : {}),
      });
    }
    for (const i of this.individuals.values()) {
      graph.push({
        '@id': i.id,
        '@type': ['owl:NamedIndividual', i.type],
        'rdfs:label': i.label,
        'skos:definition': i.definition,
        ...(i.properties ? Object.fromEntries(Object.entries(i.properties).map(([k, v]) => [`${p}:${k}`, v])) : {}),
      });
    }
    for (const a of this.axioms.values()) {
      graph.push({
        '@id': `${p}:axiom/${a.id}`,
        '@type': `${p}:Axiom`,
        'rdfs:label': a.name,
        [`${p}:appliesTo`]: { '@id': a.appliesTo },
        [`${p}:severity`]: a.severity,
        [`${p}:formal`]: a.formal,
        'rdfs:comment': a.plain,
        'dcterms:source': a.sources.map((s) => ({ '@id': `cite:${s}` })),
      });
    }
    for (const c of this.citations.values()) {
      graph.push({
        '@id': `cite:${c.id}`,
        '@type': 'dcterms:BibliographicResource',
        'dcterms:title': c.title,
        ...(c.authors ? { 'dcterms:creator': c.authors } : {}),
        ...(c.year ? { 'dcterms:date': String(c.year) } : {}),
        ...(c.publisher ? { 'dcterms:publisher': c.publisher } : {}),
        ...(c.url ? { 'schema:url': c.url } : {}),
      });
    }
    return {
      '@context': {
        [p]: `${this.spec.iri}#`,
        owl: 'http://www.w3.org/2002/07/owl#',
        rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
        xsd: 'http://www.w3.org/2001/XMLSchema#',
        skos: 'http://www.w3.org/2004/02/skos/core#',
        sh: 'http://www.w3.org/ns/shacl#',
        dcterms: 'http://purl.org/dc/terms/',
        schema: 'https://schema.org/',
        cite: `${this.spec.iri}/cite#`,
        rea: 'https://example.org/rea#',
        xbrlGl: 'http://www.xbrl.org/int/gl/cor/2016-12-01#',
        usGaap: 'http://fasb.org/us-gaap/2025#',
        fibo: 'https://spec.edmcouncil.org/fibo/ontology/',
        coso: 'https://example.org/coso2013#',
        asc: 'https://asc.fasb.org/',
        auditing: 'https://pcaobus.org/oversight/standards/auditing-standards#',
        iso: 'https://www.iso.org/standard/',
      },
      '@graph': graph,
    };
  }

  /** Turtle serialisation of the class/relation/individual layer (axioms as annotations). */
  toTurtle(): string {
    const p = this.spec.prefix;
    const esc = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
    const lines: string[] = [
      `@prefix ${p}: <${this.spec.iri}#> .`,
      '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
      '@prefix dcterms: <http://purl.org/dc/terms/> .',
      '',
      `<${this.spec.iri}> a owl:Ontology ; dcterms:title ${esc(this.spec.title)} ; owl:versionInfo ${esc(this.spec.version)} .`,
      '',
    ];
    for (const c of this.classes.values()) {
      const parts = [`${c.id} a owl:Class`, `rdfs:label ${esc(c.label)}`];
      for (const parent of c.parents) parts.push(`rdfs:subClassOf ${parent}`);
      parts.push(`skos:definition ${esc(c.definition)}`);
      parts.push(`rdfs:comment ${esc(c.plain)}`);
      for (const s of c.synonyms ?? []) parts.push(`skos:altLabel ${esc(s)}`);
      lines.push(`${parts.join(' ;\n    ')} .`, '');
    }
    for (const r of this.relations.values()) {
      const parts = [`${r.id} a owl:ObjectProperty`, `rdfs:label ${esc(r.label)}`, `rdfs:domain ${r.domain}`, `rdfs:range ${r.range}`, `skos:definition ${esc(r.definition)}`];
      if (r.inverse) parts.push(`owl:inverseOf ${r.inverse}`);
      lines.push(`${parts.join(' ;\n    ')} .`, '');
    }
    for (const i of this.individuals.values()) {
      lines.push(`${i.id} a owl:NamedIndividual, ${i.type} ;\n    rdfs:label ${esc(i.label)} ;\n    skos:definition ${esc(i.definition)} .`, '');
    }
    for (const a of this.axioms.values()) {
      lines.push(`# Axiom ${a.id} (${a.severity}) on ${a.appliesTo}: ${a.name}\n#   ${a.formal.replace(/\n/g, ' ')}`);
    }
    return lines.join('\n');
  }
}

export function defineOntology(spec: OntologySpec): OntologyModel {
  return new OntologyModel(spec);
}

/**
 * Ontology engine: indexes a module and makes it executable (validation, explanation, schema
 * generation for agent tools, prompt grounding slices, graph export). Deep module: small API,
 * large hidden functionality.
 */
import { hashObject } from '../util/hash';
import type { Axiom, AxiomOutcome, DataProperty, OntologyClass, OntologyModule, Relation, Term } from './types';

export interface Explanation {
  id: string;
  label: string;
  definition: string;
  whyItMatters: string;
  example: string;
  synonyms: readonly string[];
  classId: string | null;
  lineage: { id: string; label: string }[];
  axioms: { id: string; title: string; plainEnglish: string }[];
  mappings: { scheme: string; ref: string; match?: string }[];
  citations: { id: string; short: string; url?: string }[];
  related: { id: string; label: string }[];
}

export type JsonSchema = { [key: string]: unknown };

export class Ontology {
  readonly module: OntologyModule;
  readonly hash: string;
  private readonly classes = new Map<string, OntologyClass>();
  private readonly children = new Map<string, string[]>();
  private readonly terms = new Map<string, Term>();
  private readonly lookupIndex = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly axiomsById = new Map<string, Axiom<any>>();

  constructor(module: OntologyModule) {
    this.module = module;
    for (const c of module.classes) {
      if (this.classes.has(c.id)) throw new Error(`ontology: duplicate class ${c.id}`);
      this.classes.set(c.id, c);
    }
    for (const c of module.classes) {
      for (const p of c.parents) {
        if (!this.classes.has(p)) throw new Error(`ontology: ${c.id} has unknown parent ${p}`);
        const list = this.children.get(p) ?? [];
        list.push(c.id);
        this.children.set(p, list);
      }
    }
    this.assertAcyclic();
    for (const r of module.relations)
      for (const end of [r.domain, r.range])
        if (!this.classes.has(end)) throw new Error(`ontology: relation ${r.id} references unknown class ${end}`);
    for (const a of module.axioms) {
      if (this.axiomsById.has(a.id)) throw new Error(`ontology: duplicate axiom ${a.id}`);
      for (const c of a.appliesTo) if (!this.classes.has(c)) throw new Error(`ontology: axiom ${a.id} applies to unknown class ${c}`);
      for (const cit of a.citations) if (!module.citations.some((x) => x.id === cit)) throw new Error(`ontology: axiom ${a.id} cites unknown ${cit}`);
      this.axiomsById.set(a.id, a);
    }
    for (const c of module.classes)
      for (const cit of c.citations ?? []) if (!module.citations.some((x) => x.id === cit)) throw new Error(`ontology: ${c.id} cites unknown ${cit}`);
    // every class is also a term (explanations for non-experts)
    for (const c of module.classes) {
      this.addTerm({ id: c.id, label: c.label, definition: c.definition, whyItMatters: c.whyItMatters, example: c.example, classId: c.id, synonyms: c.synonyms ?? [], citations: c.citations ?? [] });
    }
    for (const t of module.terms) {
      if (t.classId && !this.classes.has(t.classId)) throw new Error(`ontology: term ${t.id} points to unknown class ${t.classId}`);
      this.addTerm(t);
    }
    this.hash = hashObject({
      version: module.version,
      classes: module.classes.map((c) => ({ id: c.id, parents: c.parents, definition: c.definition, properties: c.properties ?? [] })),
      relations: module.relations,
      axioms: module.axioms.map((a) => ({ id: a.id, formal: a.formal, appliesTo: a.appliesTo })),
      terms: module.terms.map((t) => t.id),
    });
  }

  private addTerm(t: Term) {
    if (this.terms.has(t.id)) throw new Error(`ontology: duplicate term ${t.id}`);
    this.terms.set(t.id, t);
    for (const key of [t.id, t.label, ...(t.synonyms ?? [])]) {
      const k = normalise(key);
      if (!this.lookupIndex.has(k)) this.lookupIndex.set(k, t.id);
    }
  }

  private assertAcyclic() {
    const state = new Map<string, 1 | 2>();
    const visit = (id: string, path: string[]) => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) throw new Error(`ontology: subclass cycle ${[...path, id].join(' -> ')}`);
      state.set(id, 1);
      for (const p of this.classes.get(id)!.parents) visit(p, [...path, id]);
      state.set(id, 2);
    };
    for (const id of this.classes.keys()) visit(id, []);
  }

  // ------------------------------------------------------------------ queries
  get version(): string {
    return this.module.version;
  }

  cls(id: string): OntologyClass {
    const c = this.classes.get(stripArray(id));
    if (!c) throw new Error(`ontology: unknown class ${id}`);
    return c;
  }

  hasClass(id: string): boolean {
    return this.classes.has(stripArray(id));
  }

  allClasses(): OntologyClass[] {
    return [...this.classes.values()];
  }

  ancestors(id: string): string[] {
    const out: string[] = [];
    const walk = (cid: string) => {
      for (const p of this.cls(cid).parents) {
        if (!out.includes(p)) {
          out.push(p);
          walk(p);
        }
      }
    };
    walk(stripArray(id));
    return out;
  }

  descendants(id: string): string[] {
    const out: string[] = [];
    const walk = (cid: string) => {
      for (const ch of this.children.get(cid) ?? []) {
        if (!out.includes(ch)) {
          out.push(ch);
          walk(ch);
        }
      }
    };
    walk(stripArray(id));
    return out;
  }

  isA(id: string, ancestor: string): boolean {
    const a = stripArray(ancestor);
    const c = stripArray(id);
    return c === a || this.ancestors(c).includes(a);
  }

  /** Properties including inherited ones (nearest definition wins). */
  properties(id: string): DataProperty[] {
    const seen = new Map<string, DataProperty>();
    for (const cid of [stripArray(id), ...this.ancestors(id)]) for (const p of this.cls(cid).properties ?? []) if (!seen.has(p.name)) seen.set(p.name, p);
    return [...seen.values()];
  }

  relationsOf(id: string): Relation[] {
    const lineage = [stripArray(id), ...this.ancestors(id)];
    return this.module.relations.filter((r) => lineage.includes(r.domain) || lineage.includes(r.range));
  }

  term(idOrLabel: string): Term | undefined {
    const direct = this.terms.get(idOrLabel);
    if (direct) return direct;
    const id = this.lookupIndex.get(normalise(idOrLabel));
    return id ? this.terms.get(id) : undefined;
  }

  allTerms(): Term[] {
    return [...this.terms.values()];
  }

  search(query: string, limit = 20): Term[] {
    const q = normalise(query);
    if (!q) return [];
    const scored: { t: Term; s: number }[] = [];
    for (const t of this.terms.values()) {
      const label = normalise(t.label);
      let s = 0;
      if (label === q) s = 100;
      else if (label.startsWith(q)) s = 60;
      else if (label.includes(q)) s = 40;
      else if ((t.synonyms ?? []).some((x) => normalise(x).includes(q))) s = 30;
      else if (normalise(t.definition).includes(q)) s = 10;
      if (s) scored.push({ t, s });
    }
    return scored.sort((a, b) => b.s - a.s || a.t.label.localeCompare(b.t.label)).slice(0, limit).map((x) => x.t);
  }

  axiom(id: string): Axiom<unknown> {
    const a = this.axiomsById.get(id);
    if (!a) throw new Error(`ontology: unknown axiom ${id}`);
    return a;
  }

  axiomsFor(classId: string): Axiom<unknown>[] {
    const lineage = new Set([stripArray(classId), ...this.ancestors(classId)]);
    return this.module.axioms.filter((a) => a.appliesTo.some((c) => lineage.has(c)));
  }

  explain(idOrLabel: string): Explanation | null {
    const t = this.term(idOrLabel);
    if (!t) return null;
    const classId = t.classId ?? null;
    const c = classId ? this.cls(classId) : null;
    const citationIds = new Set([...(t.citations ?? []), ...(c?.citations ?? [])]);
    return {
      id: t.id,
      label: t.label,
      definition: t.definition,
      whyItMatters: t.whyItMatters,
      example: t.example,
      synonyms: t.synonyms ?? [],
      classId,
      lineage: classId ? this.ancestors(classId).map((id) => ({ id, label: this.cls(id).label })) : [],
      axioms: classId ? this.axiomsFor(classId).map((a) => ({ id: a.id, title: a.title, plainEnglish: a.plainEnglish })) : [],
      mappings: (c?.mappings ?? []).map((m) => ({ scheme: m.scheme, ref: m.ref, match: m.match })),
      citations: [...citationIds].map((id) => this.module.citations.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x).map((x) => ({ id: x.id, short: x.short, url: x.url })),
      related: (t.related ?? []).map((id) => this.term(id)).filter((x): x is Term => !!x).map((x) => ({ id: x.id, label: x.label })),
    };
  }

  // --------------------------------------------------------------- validation
  /** Run one axiom's executable check. */
  check<F>(axiomId: string, facts: F): AxiomOutcome {
    const a = this.axiom(axiomId) as Axiom<F>;
    const messages = a.check ? a.check(facts) : [];
    return { axiomId: a.id, title: a.title, passed: messages.length === 0, severity: a.severity, messages };
  }

  /** Run every executable axiom that applies to `classId` (or its ancestors). */
  validate<F>(classId: string, facts: F): AxiomOutcome[] {
    return this.axiomsFor(classId)
      .filter((a) => a.check)
      .map((a) => {
        const messages = (a as Axiom<F>).check!(facts);
        return { axiomId: a.id, title: a.title, passed: messages.length === 0, severity: a.severity, messages };
      });
  }

  // ------------------------------------------------------------ schema / LLM
  /** JSON Schema for a class (used to type agent tool I/O and skill contracts). */
  jsonSchema(classId: string): JsonSchema {
    const many = classId.endsWith('[]');
    const c = this.cls(classId);
    const props: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const p of this.properties(c.id)) {
      let s: JsonSchema;
      switch (p.range) {
        case 'money':
        case 'integer':
          s = { type: 'integer', description: `${p.description}${p.range === 'money' ? ' (integer minor units, e.g. cents)' : ''}` };
          break;
        case 'decimal':
        case 'percent':
          s = { type: 'number', description: p.description };
          break;
        case 'boolean':
          s = { type: 'boolean', description: p.description };
          break;
        case 'date':
          s = { type: 'string', format: 'date', description: p.description };
          break;
        case 'datetime':
          s = { type: 'string', format: 'date-time', description: p.description };
          break;
        case 'enum':
          s = { type: 'string', enum: [...(p.enumValues ?? [])], description: p.description };
          break;
        case 'ref':
          s = { type: 'string', description: `${p.description} (id of ${p.refClass ?? 'record'})` };
          break;
        default:
          s = { type: 'string', description: p.description };
      }
      props[p.name] = p.many ? { type: 'array', items: s, description: p.description } : s;
      if (p.required) required.push(p.name);
    }
    const obj: JsonSchema = { type: 'object', title: c.label, description: c.definition, properties: props, required, additionalProperties: false };
    return many ? { type: 'array', items: obj } : obj;
  }

  /**
   * Compact grounding text for prompts: definitions, properties and axioms of the given classes
   * and their ancestors. Stable ordering so it caches well.
   */
  slice(classIds: readonly string[]): string {
    const ids = new Set<string>();
    for (const id of classIds) {
      ids.add(stripArray(id));
      for (const a of this.ancestors(id)) ids.add(a);
    }
    const lines: string[] = [`Ontology ${this.module.prefix} v${this.module.version} (excerpt)`];
    for (const id of [...ids].sort()) {
      const c = this.cls(id);
      lines.push(`- ${c.id} "${c.label}"${c.parents.length ? ` ⊑ ${c.parents.join(', ')}` : ''}: ${c.definition}`);
      for (const p of c.properties ?? []) lines.push(`    · ${p.name}: ${p.range}${p.required ? ' (required)' : ''} — ${p.description}`);
    }
    const axioms = new Map<string, Axiom<unknown>>();
    for (const id of ids) for (const a of this.axiomsFor(id)) axioms.set(a.id, a);
    if (axioms.size) {
      lines.push('Axioms:');
      for (const a of [...axioms.values()].sort((x, y) => x.id.localeCompare(y.id))) lines.push(`- ${a.id} ${a.title}: ${a.formal}`);
    }
    return lines.join('\n');
  }

  stats() {
    return {
      version: this.module.version,
      hash: this.hash,
      classes: this.classes.size,
      relations: this.module.relations.length,
      axioms: this.module.axioms.length,
      executableAxioms: this.module.axioms.filter((a) => a.check).length,
      terms: this.terms.size,
      citations: this.module.citations.length,
    };
  }

  /** Nodes/edges for the explorer graph. */
  graph() {
    const nodes = this.allClasses().map((c) => ({ id: c.id, label: c.label, group: c.group, abstract: !!c.abstract }));
    const edges = [
      ...this.allClasses().flatMap((c) => c.parents.map((p) => ({ from: c.id, to: p, kind: 'subClassOf' as const, label: 'is a' }))),
      ...this.module.relations.map((r) => ({ from: r.domain, to: r.range, kind: 'relation' as const, label: r.label })),
    ];
    return { nodes, edges };
  }
}

function normalise(s: string): string {
  return s
    .replace(/^[a-z]+:/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9+&]+/g, ' ')
    .trim();
}

function stripArray(id: string): string {
  return id.endsWith('[]') ? id.slice(0, -2) : id;
}

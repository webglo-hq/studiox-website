/**
 * Ontology kernel: a small, domain-agnostic meta-model (classes, relations, individuals, executable axioms,
 * bibliography) with reasoning helpers (subsumption, lookup) and machine-readable exports (Turtle, JSON-LD).
 * Domain packs (accounting is the first) supply the content.
 */

export type ReaCategory = 'Resource' | 'Event' | 'Agent' | 'Commitment' | 'Type' | 'Artifact';

export type AuditAssertion =
  | 'existence_occurrence'
  | 'completeness'
  | 'accuracy_valuation'
  | 'cutoff'
  | 'classification'
  | 'rights_obligations'
  | 'presentation_disclosure';

export interface StandardRef {
  /** e.g. XBRL-GL, US-GAAP, FIBO, COSO, ASC, PCAOB, ISA, REA, SOX */
  source: string;
  /** Element, paragraph or principle identifier in that source. */
  ref: string;
  note?: string;
}

export interface PropertyDef {
  id: string;
  label: string;
  /** Class id or a datatype: xsd:string, xsd:date, xsd:decimal, xsd:integer, xsd:boolean, bh:Money */
  range: string;
  cardinality: '1' | '0..1' | '1..*' | '0..*';
  definition: string;
  /** Column in the class's table, if materialized. */
  column?: string;
}

export interface BucketingProfile {
  keywords: string[];
  mcc?: string[];
  vendorCategories?: string[];
  negativeKeywords?: string[];
  /** Purchases above the capitalization threshold belong on the balance sheet (ASC 360). */
  capitalizable?: boolean;
}

export interface OntologyClass {
  id: string;
  label: string;
  parents: string[];
  module: string;
  definition: string;
  whyItMatters: string;
  example: string;
  formal?: string;
  synonyms?: string[];
  rea?: ReaCategory;
  standards?: StandardRef[];
  citations?: string[];
  table?: string;
  properties?: PropertyDef[];
  assertions?: AuditAssertion[];
  /** Account-subtype classes */
  accountClass?: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normalBalance?: 'debit' | 'credit';
  fsLine?: string;
  bucketing?: BucketingProfile;
  since: string;
}

export interface RelationDef {
  id: string;
  label: string;
  domain: string;
  range: string;
  definition: string;
  inverse?: string;
}

export interface Individual {
  id: string;
  label: string;
  type: string;
  definition: string;
  whyItMatters: string;
  example: string;
  synonyms?: string[];
  citations?: string[];
  order?: number;
}

export interface Citation {
  key: string;
  text: string;
  url?: string;
}

export interface AxiomViolation {
  axiom: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
  assertion?: AuditAssertion;
}

export interface Axiom<S = unknown, C = unknown> {
  id: string;
  label: string;
  appliesTo: string;
  formal: string;
  plainEnglish: string;
  severity: 'error' | 'warning';
  assertions?: AuditAssertion[];
  citations?: string[];
  /** Executable rule. Returns no violations when the subject satisfies the axiom. */
  check(subject: S, ctx: C): AxiomViolation[] | AxiomViolation | null | undefined | false;
}

export interface OntologySpec {
  iri: string;
  prefix: string;
  title: string;
  version: string;
  description: string;
  changelog: Array<{ version: string; date: string; notes: string }>;
  classes: OntologyClass[];
  relations: RelationDef[];
  individuals: Individual[];
  axioms: Axiom<never, never>[];
  bibliography: Citation[];
  modules: Array<{ id: string; label: string; description: string }>;
}

export interface TermEntry {
  id: string;
  kind: 'class' | 'individual' | 'axiom';
  label: string;
  definition: string;
  whyItMatters: string;
  example: string;
  module?: string;
  parents?: string[];
  citations?: Citation[];
  standards?: StandardRef[];
  formal?: string;
}

export class Ontology {
  readonly spec: OntologySpec;
  private readonly classById = new Map<string, OntologyClass>();
  private readonly individualById = new Map<string, Individual>();
  private readonly axiomById = new Map<string, Axiom<never, never>>();
  private readonly children = new Map<string, string[]>();
  private readonly lexicon = new Map<string, string>();
  private readonly ancestorCache = new Map<string, string[]>();
  readonly hash: string;

  constructor(spec: OntologySpec, hashFn: (text: string) => string) {
    this.spec = spec;
    for (const c of spec.classes) {
      if (this.classById.has(c.id)) throw new Error(`duplicate class ${c.id}`);
      this.classById.set(c.id, c);
    }
    for (const i of spec.individuals) {
      if (this.individualById.has(i.id) || this.classById.has(i.id)) throw new Error(`duplicate id ${i.id}`);
      this.individualById.set(i.id, i);
    }
    for (const a of spec.axioms) {
      if (this.axiomById.has(a.id)) throw new Error(`duplicate axiom ${a.id}`);
      this.axiomById.set(a.id, a);
    }
    for (const c of spec.classes) {
      for (const p of c.parents) {
        const list = this.children.get(p) ?? [];
        list.push(c.id);
        this.children.set(p, list);
      }
    }
    const addLex = (term: string, id: string) => {
      const key = normalizeTerm(term);
      if (key && !this.lexicon.has(key)) this.lexicon.set(key, id);
    };
    // Labels win over synonyms: register every label first, then local names, then synonyms.
    for (const c of spec.classes) addLex(c.label, c.id);
    for (const i of spec.individuals) addLex(i.label, i.id);
    for (const c of spec.classes) addLex(c.id.split(':')[1] ?? c.id, c.id);
    for (const c of spec.classes) for (const s of c.synonyms ?? []) addLex(s, c.id);
    for (const i of spec.individuals) for (const s of i.synonyms ?? []) addLex(s, i.id);
    this.hash = hashFn(stableSpecText(spec));
  }

  get version(): string {
    return this.spec.version;
  }

  classes(): OntologyClass[] {
    return this.spec.classes;
  }

  getClass(id: string): OntologyClass | undefined {
    return this.classById.get(id);
  }

  requireClass(id: string): OntologyClass {
    const c = this.classById.get(id);
    if (!c) throw new Error(`unknown ontology class ${id}`);
    return c;
  }

  getIndividual(id: string): Individual | undefined {
    return this.individualById.get(id);
  }

  individualsOf(typeId: string): Individual[] {
    return this.spec.individuals.filter((i) => i.type === typeId || this.isA(i.type, typeId)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  axioms(): Axiom<never, never>[] {
    return this.spec.axioms;
  }

  getAxiom(id: string): Axiom<never, never> | undefined {
    return this.axiomById.get(id);
  }

  /** All ancestors (transitive subClassOf), nearest first. */
  ancestors(id: string): string[] {
    const cached = this.ancestorCache.get(id);
    if (cached) return cached;
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [...(this.classById.get(id)?.parents ?? [])];
    while (queue.length) {
      const p = queue.shift()!;
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      queue.push(...(this.classById.get(p)?.parents ?? []));
    }
    this.ancestorCache.set(id, out);
    return out;
  }

  descendants(id: string): string[] {
    const out: string[] = [];
    const queue = [...(this.children.get(id) ?? [])];
    const seen = new Set<string>();
    while (queue.length) {
      const c = queue.shift()!;
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      queue.push(...(this.children.get(c) ?? []));
    }
    return out;
  }

  childrenOf(id: string): string[] {
    return this.children.get(id) ?? [];
  }

  /** Subsumption: is `id` the same as or a subclass of `ancestor`? */
  isA(id: string, ancestor: string): boolean {
    return id === ancestor || this.ancestors(id).includes(ancestor);
  }

  /** Resolve a word or phrase ("accrual", "WD+3", "flux") to a term id. */
  lookup(text: string): string | undefined {
    return this.lexicon.get(normalizeTerm(text));
  }

  lexiconEntries(): Array<[string, string]> {
    return Array.from(this.lexicon.entries());
  }

  citation(key: string): Citation | undefined {
    return this.spec.bibliography.find((b) => b.key === key);
  }

  /** Plain-English entry for the UI's hover definitions. */
  term(id: string): TermEntry | undefined {
    const c = this.classById.get(id);
    if (c) {
      return {
        id,
        kind: 'class',
        label: c.label,
        definition: c.definition,
        whyItMatters: c.whyItMatters,
        example: c.example,
        module: c.module,
        parents: c.parents,
        citations: (c.citations ?? []).map((k) => this.citation(k)).filter((x): x is Citation => !!x),
        standards: c.standards,
        formal: c.formal,
      };
    }
    const i = this.individualById.get(id);
    if (i) {
      return {
        id,
        kind: 'individual',
        label: i.label,
        definition: i.definition,
        whyItMatters: i.whyItMatters,
        example: i.example,
        parents: [i.type],
        citations: (i.citations ?? []).map((k) => this.citation(k)).filter((x): x is Citation => !!x),
      };
    }
    const a = this.axiomById.get(id);
    if (a) {
      return {
        id,
        kind: 'axiom',
        label: a.label,
        definition: a.plainEnglish,
        whyItMatters: `Applies to ${this.classById.get(a.appliesTo)?.label ?? a.appliesTo}; severity ${a.severity}.`,
        example: a.formal,
        formal: a.formal,
        citations: (a.citations ?? []).map((k) => this.citation(k)).filter((x): x is Citation => !!x),
      };
    }
    return undefined;
  }

  /** Axioms applicable to a class (including those declared on its ancestors). */
  axiomsFor(classId: string): Axiom<never, never>[] {
    const lineage = new Set([classId, ...this.ancestors(classId)]);
    return this.spec.axioms.filter((a) => lineage.has(a.appliesTo));
  }

  /** Run every applicable axiom; returns all violations (errors and warnings). */
  evaluate<S, C>(classId: string, subject: S, ctx: C): AxiomViolation[] {
    const out: AxiomViolation[] = [];
    for (const axiom of this.axiomsFor(classId) as unknown as Axiom<S, C>[]) {
      const r = axiom.check(subject, ctx);
      if (!r) continue;
      for (const v of Array.isArray(r) ? r : [r]) out.push({ ...v, axiom: v.axiom || axiom.id, severity: v.severity ?? axiom.severity });
    }
    return out;
  }

  /** Internal consistency (run in tests): parents/relations/axioms reference known classes; no cycles. */
  lint(): string[] {
    const problems: string[] = [];
    for (const c of this.spec.classes) {
      for (const p of c.parents) if (!this.classById.has(p)) problems.push(`${c.id}: unknown parent ${p}`);
      if (!c.definition || c.definition.length < 20) problems.push(`${c.id}: definition too short`);
      if (!c.whyItMatters || !c.example) problems.push(`${c.id}: missing why/example`);
      if (this.ancestors(c.id).includes(c.id)) problems.push(`${c.id}: subclass cycle`);
      for (const k of c.citations ?? []) if (!this.citation(k)) problems.push(`${c.id}: unknown citation ${k}`);
      for (const prop of c.properties ?? []) {
        if (!prop.range.includes(':')) problems.push(`${c.id}.${prop.id}: range must be a CURIE`);
        else if (prop.range.startsWith(`${this.spec.prefix}:`) && prop.range !== 'bh:Money' && !this.classById.has(prop.range)) {
          problems.push(`${c.id}.${prop.id}: unknown range ${prop.range}`);
        }
      }
    }
    for (const r of this.spec.relations) {
      if (!this.classById.has(r.domain)) problems.push(`relation ${r.id}: unknown domain ${r.domain}`);
      if (!this.classById.has(r.range)) problems.push(`relation ${r.id}: unknown range ${r.range}`);
    }
    for (const i of this.spec.individuals) if (!this.classById.has(i.type)) problems.push(`individual ${i.id}: unknown type ${i.type}`);
    for (const a of this.spec.axioms) {
      if (!this.classById.has(a.appliesTo)) problems.push(`axiom ${a.id}: unknown class ${a.appliesTo}`);
      for (const k of a.citations ?? []) if (!this.citation(k)) problems.push(`axiom ${a.id}: unknown citation ${k}`);
    }
    return problems;
  }
}

export function normalizeTerm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9+-]+/g, ' ')
    .trim()
    .replace(/s$/, '');
}

/** Canonical text of the spec (functions excluded) used for the content hash / version identity. */
export function stableSpecText(spec: OntologySpec): string {
  const data = {
    iri: spec.iri,
    version: spec.version,
    classes: spec.classes,
    relations: spec.relations,
    individuals: spec.individuals,
    axioms: spec.axioms.map(({ check: _check, ...rest }) => rest),
    bibliography: spec.bibliography,
  };
  return JSON.stringify(data, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}

import type { z } from 'zod';

/**
 * Domain-agnostic ontology meta-model. A domain pack supplies classes, relations,
 * individuals, axioms (executable invariants) and shapes (zod schemas typing instances).
 * The model is exported as JSON-LD (OWL/RDFS/SKOS/SHACL vocabulary) and Turtle.
 */

export interface Citation {
  id: string;
  title: string;
  authors?: string;
  year?: number;
  publisher?: string;
  url?: string;
  note?: string;
}

/** External vocabulary alignments (skos:closeMatch / exactMatch). */
export type MappingScheme = 'rea' | 'xbrlGl' | 'usGaap' | 'fibo' | 'coso' | 'asc' | 'auditing' | 'iso';

export interface PropertyDef {
  id: string;
  label: string;
  /** xsd datatype (e.g. "xsd:decimal") or a class id */
  range: string;
  cardinality: '1' | '0..1' | '0..*' | '1..*';
  definition: string;
}

export interface OntologyClass {
  id: string;
  label: string;
  /** rdfs:subClassOf */
  parents: string[];
  /** Logical module (e.g. "ledger", "reconciliation") for navigation. */
  module: string;
  /** Formal definition (skos:definition) */
  definition: string;
  /** One sentence a non-accountant understands. */
  plain: string;
  /** Why it matters in the close. */
  why: string;
  /** Concrete example. */
  example: string;
  synonyms?: string[];
  sources?: string[];
  mappings?: Partial<Record<MappingScheme, string | string[]>>;
  properties?: PropertyDef[];
  abstract?: boolean;
  /** Free-form machine annotations used by domain engines (e.g. keywords, merchant codes). */
  annotations?: Record<string, unknown>;
}

export interface OntologyRelation {
  id: string;
  label: string;
  domain: string;
  range: string;
  cardinality: '1' | '0..1' | '0..*' | '1..*';
  definition: string;
  inverse?: string;
  transitive?: boolean;
  sources?: string[];
}

export interface Individual {
  id: string;
  label: string;
  /** rdf:type (class id) */
  type: string;
  definition: string;
  plain?: string;
  properties?: Record<string, string | number | boolean | string[]>;
  sources?: string[];
  mappings?: Partial<Record<MappingScheme, string | string[]>>;
}

export type Severity = 'error' | 'warning';

export interface AxiomFinding {
  message: string;
  /** Optional pointer into the subject, e.g. "lines[2].accountId" */
  path?: string;
  data?: Record<string, unknown>;
}

/**
 * An axiom is a named invariant with a formal statement, a plain-English reading,
 * citations, and an executable check. `check` returns findings (empty = holds).
 */
export interface Axiom<S = unknown, C = unknown> {
  id: string;
  name: string;
  appliesTo: string;
  severity: Severity;
  formal: string;
  plain: string;
  sources: string[];
  check: (subject: S, ctx: C) => AxiomFinding[];
}

export interface Violation {
  axiomId: string;
  axiomName: string;
  severity: Severity;
  message: string;
  path?: string;
  data?: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  /** Errors and warnings; `ok` is false only when an error-severity finding exists. */
  violations: Violation[];
  /** Axioms evaluated (for evidence: "checked 9 rules, 9 passed"). */
  checked: string[];
}

export interface OntologySpec {
  iri: string;
  prefix: string;
  version: string;
  title: string;
  description: string;
  modules: { id: string; label: string; description: string }[];
  citations: Citation[];
  classes: OntologyClass[];
  relations: OntologyRelation[];
  individuals: Individual[];
  // Axioms are heterogeneous in subject type; the model narrows per call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  axioms: Axiom<any, any>[];
  shapes: Record<string, z.ZodType>;
  /** Changelog entries newest first. */
  changelog: { version: string; date: string; notes: string }[];
}

export interface TermExplanation {
  id: string;
  label: string;
  kind: 'class' | 'relation' | 'individual' | 'axiom';
  plain: string;
  definition: string;
  why?: string;
  example?: string;
  sources: Citation[];
  parents?: { id: string; label: string }[];
}

export interface GraphNode {
  id: string;
  label: string;
  module: string;
  kind: 'class' | 'individual';
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: 'subClassOf' | 'relation' | 'instanceOf';
  label: string;
}

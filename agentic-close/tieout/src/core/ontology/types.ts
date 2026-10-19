/**
 * Ontology model (domain-agnostic). A domain pack contributes an OntologyModule; the engine
 * (registry.ts) indexes it and makes it executable:
 *   - classes with plain-English definition / why-it-matters / example (in-app explanations)
 *   - typed data properties (JSON Schema generation for agent tools and skill I/O)
 *   - object relations (graph explorer, JSON-LD/Turtle export)
 *   - axioms with formal statements AND executable checks (validation of data and proposals)
 *   - mappings to external standards and citations to the literature
 */

export interface Citation {
  id: string;
  short: string;
  full: string;
  kind: 'paper' | 'book' | 'standard' | 'framework' | 'taxonomy' | 'regulation' | 'specification';
  url?: string;
}

export type MappingScheme = 'REA' | 'XBRL-GL' | 'US-GAAP' | 'FIBO' | 'COSO' | 'PCAOB' | 'AICPA' | 'IAASB' | 'ASC' | 'SOX' | 'ISO' | 'MCC';

export interface Mapping {
  scheme: MappingScheme;
  ref: string;
  match?: 'exact' | 'close' | 'broad' | 'related';
  note?: string;
}

export type PropertyRange =
  | 'string'
  | 'text'
  | 'date'
  | 'datetime'
  | 'money'
  | 'decimal'
  | 'integer'
  | 'boolean'
  | 'percent'
  | 'enum'
  | 'ref';

export interface DataProperty {
  name: string;
  label: string;
  range: PropertyRange;
  description: string;
  required?: boolean;
  many?: boolean;
  enumValues?: readonly string[];
  /** for range 'ref': the class referenced */
  refClass?: string;
}

export type ClassGroup =
  | 'foundations'
  | 'organization'
  | 'ledger'
  | 'accounts'
  | 'statements'
  | 'entries'
  | 'periods'
  | 'subledgers'
  | 'accruals'
  | 'reconciliation'
  | 'flux'
  | 'intercompany'
  | 'fx'
  | 'controls'
  | 'audit'
  | 'close'
  | 'agents'
  | 'revenue'
  | 'leases'
  | 'assets';

export interface OntologyClass {
  id: string;
  label: string;
  group: ClassGroup;
  parents: readonly string[];
  abstract?: boolean;
  definition: string;
  whyItMatters: string;
  example: string;
  synonyms?: readonly string[];
  /** REA role (McCarthy 1982; ISO/IEC 15944-4) */
  rea?: 'Resource' | 'Event' | 'Agent' | 'Commitment' | 'Contract' | 'Type' | 'Policy';
  properties?: readonly DataProperty[];
  mappings?: readonly Mapping[];
  citations?: readonly string[];
  /** Classification signals used by bucketing (keywords and ISO 18245 merchant category codes) */
  signals?: { keywords?: readonly string[]; mcc?: readonly string[] };
}

export interface Relation {
  id: string;
  label: string;
  domain: string;
  range: string;
  description: string;
  cardinality?: '1' | '0..1' | '1..*' | '0..*';
  inverse?: string;
}

export type Enforcement = 'ontology' | 'database' | 'runtime' | 'ui';

export interface Axiom<F = never> {
  id: string;
  title: string;
  /** First-order-logic style statement */
  formal: string;
  plainEnglish: string;
  appliesTo: readonly string[];
  severity: 'error' | 'warning';
  enforcedBy: readonly Enforcement[];
  citations: readonly string[];
  /** Executable check: returns violation messages (empty = satisfied). Undefined facts are skipped. */
  check?: (facts: F) => string[];
}

export interface Term {
  id: string;
  label: string;
  definition: string;
  whyItMatters: string;
  example: string;
  classId?: string;
  synonyms?: readonly string[];
  related?: readonly string[];
  citations?: readonly string[];
}

export interface OntologyModule {
  prefix: string;
  iri: string;
  version: string;
  title: string;
  description: string;
  classes: readonly OntologyClass[];
  relations: readonly Relation[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each axiom declares its own fact shape
  axioms: readonly Axiom<any>[];
  terms: readonly Term[];
  citations: readonly Citation[];
  changelog: readonly { version: string; date: string; notes: string }[];
}

export interface AxiomOutcome {
  axiomId: string;
  title: string;
  passed: boolean;
  severity: 'error' | 'warning';
  messages: string[];
}

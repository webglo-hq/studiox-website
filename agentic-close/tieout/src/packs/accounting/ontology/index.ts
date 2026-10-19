/**
 * The Tieout Close Ontology (prefix `tie:`), the semantic layer of the accounting pack.
 * Versioned with semver; the content hash changes whenever definitions, structure or axioms do.
 */
import { Ontology } from '../../../core/ontology/registry';
import type { OntologyModule } from '../../../core/ontology/types';
import { AXIOMS } from './axioms';
import { CITATIONS } from './citations';
import { GOVERNANCE_CLASSES } from './classes-governance';
import { LEDGER_CLASSES } from './classes-ledger';
import { OPERATIONS_CLASSES } from './classes-operations';
import { RELATIONS } from './relations';
import { TERMS } from './terms';

export const CLOSE_ONTOLOGY: OntologyModule = {
  prefix: 'tie',
  iri: 'https://tieout.example/ontology/close#',
  version: '1.3.0',
  title: 'Tieout Close Ontology',
  description:
    'A formal, machine-readable ontology of the financial close: REA economic primitives, double-entry structure, multi-entity GL and subledgers, periods, accruals and deferrals, reconciliation, variance analysis, intercompany and FX, internal control (COSO 2013 / SOX 404), audit assertions and materiality, close management and AI-agent governance.',
  classes: [...LEDGER_CLASSES, ...OPERATIONS_CLASSES, ...GOVERNANCE_CLASSES],
  relations: RELATIONS,
  axioms: AXIOMS,
  terms: TERMS,
  citations: CITATIONS,
  changelog: [
    { version: '1.0.0', date: '2026-06-02', notes: 'Initial release: ledger, subledgers, reconciliation, flux, controls.' },
    { version: '1.1.0', date: '2026-08-14', notes: 'Added AI-agent governance classes (Skill, AutonomyLevel, Proposal family, PromptInjection) and AX-AGT-01..03.' },
    { version: '1.2.0', date: '2026-10-01', notes: 'Added intercompany/FX translation axioms (AX-IC-02, AX-FX-02), capitalization threshold (AX-SCH-03), bucketing signals (ISO 18245 MCC).' },
    { version: '1.3.0', date: '2026-10-19', notes: 'Added year-end closing entries (tie:ClosingEntry) and AX-FS-01: every income statement ties to the ledger.' },
  ],
};

let instance: Ontology | null = null;

/** Singleton accessor (construction validates the whole graph). */
export function closeOntology(): Ontology {
  if (!instance) instance = new Ontology(CLOSE_ONTOLOGY);
  return instance;
}

import { Ontology, type OntologySpec } from '../../../ontology/kernel';
import { sha256Hex } from '../../../shared/hash';
import { allAxioms } from './axioms';
import { bibliography } from './bibliography';
import { ONTOLOGY_VERSION } from './builder';
import { accountClasses } from './classes-accounts';
import { closeClasses } from './classes-close';
import { coreClasses } from './classes-core';
import { individuals } from './individuals';
import { relations } from './relations';

export const MODULES: OntologySpec['modules'] = [
  { id: 'rea', label: 'REA backbone', description: 'Resources, events, agents and commitments (McCarthy 1982).' },
  { id: 'org', label: 'Organization', description: 'Tenants, entities, people.' },
  { id: 'ledger', label: 'General ledger', description: 'Accounts, entries, lines, periods, statements.' },
  { id: 'accounts', label: 'Account types', description: 'Account classes with normal balances, statement lines, XBRL elements and bucketing profiles.' },
  { id: 'dimensions', label: 'Dimensions', description: 'Entity, department, location, class, project.' },
  { id: 'subledgers', label: 'Subledgers', description: 'AP, AR, bank, card, fixed assets, prepaids, payroll.' },
  { id: 'accruals', label: 'Accruals & deferrals', description: 'Accruals, deferrals, amortization, depreciation, revenue recognition.' },
  { id: 'reconciliation', label: 'Reconciliation', description: 'Recs, matches, reconciling items, aging, certification.' },
  { id: 'flux', label: 'Flux & variance', description: 'Period-over-period and budget-vs-actual analysis with drivers.' },
  { id: 'intercompany', label: 'Intercompany', description: 'Intercompany balances, eliminations, consolidation.' },
  { id: 'fx', label: 'Foreign exchange', description: 'Functional vs reporting currency, remeasurement, translation.' },
  { id: 'controls', label: 'Controls', description: 'COSO controls, maker-checker, SoD, evidence, assertions, materiality.' },
  { id: 'close', label: 'Close calendar', description: 'Close, workdays, tasks, dependencies, sign-offs, packages.' },
  { id: 'agents', label: 'Agents', description: 'Skills, policies, autonomy, runs, proposals, untrusted text.' },
  { id: 'integration', label: 'Integration', description: 'Connectors, source documents, imports, provenance.' },
];

export const closeOntologySpec: OntologySpec = {
  iri: 'https://bookhand.example/ontology/close',
  prefix: 'bh',
  title: 'Bookhand Financial Close Ontology',
  version: ONTOLOGY_VERSION,
  description:
    'A formal, versioned ontology of the month-end financial close: REA backbone, double-entry axioms, general ledger, subledgers, reconciliation, accruals and deferrals, flux, intercompany, FX, controls (COSO / SOX 404), audit assertions, materiality, the close calendar and the agent layer. Grounded in McCarthy (1982), XBRL GL, the US-GAAP taxonomy, FIBO, COSO 2013 and PCAOB/ISA standards.',
  changelog: [
    { version: '1.0.0', date: '2026-10-19', notes: 'Initial release: REA, ledger, subledgers, recs, accruals, flux, IC, FX, controls, close, agents.' },
    { version: '1.1.0', date: '2026-10-19', notes: 'Bucketing profiles on account types; capitalization policy; untrusted text.' },
    { version: '1.2.0', date: '2026-10-19', notes: 'Executable axioms for reconciliations, flux, schedules, intercompany and proposals.' },
    { version: '1.3.0', date: '2026-10-19', notes: 'Bank account, corporate card, flux line, agent step and run budget classes; every database table now maps to an ontology class.' },
  ],
  classes: [...coreClasses, ...accountClasses, ...closeClasses],
  relations,
  individuals,
  axioms: allAxioms,
  bibliography,
  modules: MODULES,
};

export const closeOntology = new Ontology(closeOntologySpec, sha256Hex);

/** Ontology classes whose bucketing profile marks them capitalizable and whose keywords match the text. */
export function capitalizableMatches(text: string): string[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9&]+/g, ' ')} `;
  const out: string[] = [];
  for (const c of closeOntology.classes()) {
    if (!c.bucketing?.capitalizable) continue;
    const hit = c.bucketing.keywords.find((k) => t.includes(` ${k.toLowerCase()} `));
    if (hit) out.push(`${c.label}: "${hit}"`);
  }
  return out;
}

export { FS_LINES, JE_TYPE_INFO } from './individuals';
export * from './subjects';
export { ONTOLOGY_VERSION } from './builder';

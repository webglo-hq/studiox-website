import { defineOntology, type OntologyModel } from '../../../framework/ontology/model';
import { AXIOMS } from './axioms';
import { CITATIONS } from './citations';
import { CLOSE_CLASSES } from './classes-close';
import { CORE_CLASSES } from './classes-core';
import { SPEND_CLASSES } from './classes-spend';
import { INDIVIDUALS, RELATIONS } from './relations';
import {
  ClosePackageDraft,
  CodingDecision,
  EvidenceItem,
  FixedAssetDraft,
  FluxExplanationDraft,
  IssueDraft,
  JournalEntryDraft,
  PrepaidScheduleDraft,
  RecMatch,
  ReconcilingItemDraft,
  TaskUpdate,
} from './shapes';

export const ONTOLOGY_VERSION = '1.3.0';

let cached: OntologyModel | undefined;

/** The Evenkeel close ontology (compiled once; integrity-checked at construction). */
export function closeOntology(): OntologyModel {
  if (cached) return cached;
  cached = defineOntology({
    iri: 'https://evenkeel.example/ontology/close',
    prefix: 'ek',
    version: ONTOLOGY_VERSION,
    title: 'Evenkeel Financial Close Ontology',
    description:
      'A formal, executable ontology of the month-end close grounded in REA, double-entry axioms, XBRL US-GAAP / XBRL GL, FIBO, COSO 2013 / SOX 404, audit assertions, ASC 340/360/606/810/830/842 and materiality. Shapes type every agent tool and proposal; axioms validate data and proposals.',
    modules: [
      { id: 'foundation', label: 'Foundations (REA)', description: 'Resources, events, agents and commitments.' },
      { id: 'structure', label: 'Reporting structure', description: 'Entities, currencies, dimensions and periods.' },
      { id: 'ledger', label: 'Ledger', description: 'Chart of accounts, normal balances and journal entries.' },
      { id: 'statements', label: 'Statements', description: 'Trial balance and financial statement line items.' },
      { id: 'subledgers', label: 'Subledgers', description: 'AP, AR, bank, card, fixed assets, prepaids, payroll.' },
      { id: 'reconciliation', label: 'Reconciliation', description: 'Matches, reconciling items and certification.' },
      { id: 'accruals', label: 'Accruals & deferrals', description: 'Accruals, prepaids, depreciation and amortisation.' },
      { id: 'variance', label: 'Variance', description: 'Flux analysis, thresholds, drivers, budgets.' },
      { id: 'intercompany', label: 'Intercompany', description: 'Intercompany balances and eliminations.' },
      { id: 'fx', label: 'Foreign exchange', description: 'Rates, remeasurement, translation and CTA.' },
      { id: 'controls', label: 'Controls & assurance', description: 'COSO controls, SoD, evidence, assertions, materiality.' },
      { id: 'close', label: 'Close management', description: 'Close cycles, tasks, dependencies, workdays, packages.' },
      { id: 'agents', label: 'Agents', description: 'Skills, runs, proposals, autonomy and policies.' },
      { id: 'spend', label: 'Spend concepts', description: 'Semantic categories used to bucket transactions.' },
    ],
    citations: CITATIONS,
    classes: [...CORE_CLASSES, ...CLOSE_CLASSES, ...SPEND_CLASSES],
    relations: RELATIONS,
    individuals: INDIVIDUALS,
    axioms: AXIOMS,
    shapes: {
      'ek:JournalEntry': JournalEntryDraft,
      'ek:CodingDecision': CodingDecision,
      'ek:Match': RecMatch,
      'ek:ReconcilingItem': ReconcilingItemDraft,
      'ek:VarianceExplanation': FluxExplanationDraft,
      'ek:Exception': IssueDraft,
      'ek:PrepaidSchedule': PrepaidScheduleDraft,
      'ek:FixedAsset': FixedAssetDraft,
      'ek:CloseTask': TaskUpdate,
      'ek:ClosePackage': ClosePackageDraft,
      'ek:Evidence': EvidenceItem,
    },
    changelog: [
      { version: '1.3.0', date: '2026-10-01', notes: 'Spend concepts carry MCC + keyword annotations for bucketing; AX-PPD-01 prepaid deferral rule.' },
      { version: '1.2.0', date: '2026-08-14', notes: 'Autonomy ceiling axiom (AX-PRP-02); ISO/IEC 42001 alignment for agent evidence.' },
      { version: '1.1.0', date: '2026-06-02', notes: 'Intercompany module (ASC 810) and FX remeasurement/translation (ASC 830).' },
      { version: '1.0.0', date: '2026-04-20', notes: 'Initial REA + double-entry core, reconciliation, controls and close modules.' },
    ],
  });
  return cached;
}

export * from './shapes';
export * from './axioms';

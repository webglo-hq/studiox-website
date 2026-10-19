import type { InsertOf, RowOf, TableSpec } from '../dsl';
import * as core from './core';
import * as audit from './audit';
import * as ledger from './ledger';
import * as sub from './subledgers';
import * as docs from './documents';
import * as close from './close';
import * as recon from './recon';
import * as flux from './flux';
import * as agents from './agents';

/**
 * The complete data model, keyed by table name. Order matters only for documentation; the DDL generator
 * creates every table first and adds foreign keys afterwards, so circular references are fine.
 */
export const schema = {
  tenants: core.tenants,
  entities: core.entities,
  users: core.users,
  roles: core.roles,
  user_roles: core.userRoles,
  sessions: core.sessions,
  api_tokens: core.apiTokens,
  sod_rules: core.sodRules,
  holidays: core.holidays,
  idempotency_keys: core.idempotencyKeys,
  audit_log: audit.auditLog,
  accounts: ledger.accounts,
  departments: ledger.departments,
  locations: ledger.locations,
  classes: ledger.classes,
  projects: ledger.projects,
  periods: ledger.periods,
  fx_rates: ledger.fxRates,
  journal_entries: ledger.journalEntries,
  journal_lines: ledger.journalLines,
  recurring_templates: ledger.recurringTemplates,
  budgets: ledger.budgets,
  budget_lines: ledger.budgetLines,
  materiality_settings: ledger.materialitySettings,
  vendors: sub.vendors,
  purchase_orders: sub.purchaseOrders,
  purchase_order_lines: sub.purchaseOrderLines,
  goods_receipts: sub.goodsReceipts,
  bills: sub.bills,
  bill_lines: sub.billLines,
  vendor_payments: sub.vendorPayments,
  payment_applications: sub.paymentApplications,
  customers: sub.customers,
  invoices: sub.invoices,
  invoice_lines: sub.invoiceLines,
  customer_receipts: sub.customerReceipts,
  receipt_applications: sub.receiptApplications,
  bank_accounts: sub.bankAccounts,
  bank_statements: sub.bankStatements,
  bank_transactions: sub.bankTransactions,
  cards: sub.cards,
  card_transactions: sub.cardTransactions,
  fixed_assets: sub.fixedAssets,
  depreciation_lines: sub.depreciationLines,
  amortization_schedules: sub.amortizationSchedules,
  amortization_lines: sub.amortizationLines,
  payroll_runs: sub.payrollRuns,
  payroll_lines: sub.payrollLines,
  connectors: docs.connectors,
  source_documents: docs.sourceDocuments,
  import_batches: docs.importBatches,
  attachments: docs.attachments,
  comments: docs.comments,
  closes: close.closes,
  checklist_templates: close.checklistTemplates,
  checklist_template_tasks: close.checklistTemplateTasks,
  close_tasks: close.closeTasks,
  close_task_dependencies: close.closeTaskDependencies,
  signoffs: close.signoffs,
  close_packages: close.closePackages,
  reconciliations: recon.reconciliations,
  rec_matches: recon.recMatches,
  rec_match_items: recon.recMatchItems,
  reconciling_items: recon.reconcilingItems,
  flux_analyses: flux.fluxAnalyses,
  flux_lines: flux.fluxLines,
  skills: agents.skills,
  skill_versions: agents.skillVersions,
  skill_policies: agents.skillPolicies,
  agent_runs: agents.agentRuns,
  agent_steps: agents.agentSteps,
  agent_tool_calls: agents.agentToolCalls,
  proposals: agents.proposals,
  approvals: agents.approvals,
  ontology_versions: agents.ontologyVersions,
} as const;

export type Schema = typeof schema;
export type TableName = keyof Schema;
export type Row<T extends TableName> = RowOf<Schema[T]['columns']>;
export type Insert<T extends TableName> = InsertOf<Schema[T]['columns']>;

export function tableSpec(name: TableName): TableSpec {
  return schema[name] as unknown as TableSpec;
}

export const TABLE_NAMES = Object.keys(schema) as TableName[];

export { JOURNAL_ENTRY_TYPES } from './ledger';
export { PROPOSAL_KINDS, PROPOSAL_STATUSES, AUTONOMY_LEVELS } from './agents';
export { REC_TYPES } from './recon';
export { TASK_CATEGORIES } from './close';
export type { FluxDriver } from './flux';

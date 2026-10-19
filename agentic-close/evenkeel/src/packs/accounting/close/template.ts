import type { UserKey } from '../seed/scenario';

/**
 * Kitewell's monthly close calendar (WD = workday relative to period end; WD+1 is the first
 * business day of the next month). Agent-enabled tasks name the skill that prepares them;
 * dependencies encode the order accountants actually need (e.g. flux runs only after every
 * adjustment that could still move the numbers).
 */
export type TaskCategory = 'cash' | 'ap' | 'ar' | 'accruals' | 'prepaids' | 'fixed_assets' | 'payroll' | 'intercompany' | 'fx' | 'review' | 'reporting' | 'controls';

export interface TaskTemplate {
  code: string;
  title: string;
  description: string;
  category: TaskCategory;
  workday: number;
  owner: UserKey;
  reviewer: UserKey;
  skill: string | null;
  input: Record<string, unknown>;
  deps: string[];
  entity: 'US' | 'UK' | null;
  control: string;
}

export const CLOSE_TEMPLATE: TaskTemplate[] = [
  {
    code: 'T01',
    title: 'Import bank, card, payroll and AP files',
    description: 'Load month-end statements and feeds from the bank, card program, payroll provider, AP inbox and the legacy ERP. Imports are idempotent and every record keeps a link to its source file.',
    category: 'cash',
    workday: 1,
    owner: 'sam',
    reviewer: 'priya',
    skill: null,
    input: {},
    deps: [],
    entity: null,
    control: 'CTL-01 Complete and accurate source data',
  },
  {
    code: 'T02',
    title: 'Code corporate card transactions',
    description: 'Assign an account and department to every card transaction, catch purchases that should be capitalised or treated as prepaid, and post the card subledger.',
    category: 'ap',
    workday: 1,
    owner: 'sam',
    reviewer: 'priya',
    skill: 'transaction-coding',
    input: {},
    deps: ['T01'],
    entity: null,
    control: 'CTL-02 Expense classification review',
  },
  {
    code: 'T03',
    title: 'Reconcile US operating account (••4821)',
    description: 'Match the First Meridian statement to the cash ledger; explain every reconciling item.',
    category: 'cash',
    workday: 2,
    owner: 'sam',
    reviewer: 'priya',
    skill: 'bank-reconciliation',
    input: { bankAccount: 'US-OP' },
    deps: ['T01'],
    entity: 'US',
    control: 'CTL-03 Bank reconciliations',
  },
  {
    code: 'T04',
    title: 'Reconcile US payroll account (••7730)',
    description: 'Match payroll funding transfers and net pay to the payroll cash ledger.',
    category: 'cash',
    workday: 2,
    owner: 'sam',
    reviewer: 'priya',
    skill: 'bank-reconciliation',
    input: { bankAccount: 'US-PAY' },
    deps: ['T01'],
    entity: 'US',
    control: 'CTL-03 Bank reconciliations',
  },
  {
    code: 'T05',
    title: 'Reconcile UK operating account (Harbourline)',
    description: 'Match the camt.053 statement for the GBP account to the UK cash ledger.',
    category: 'cash',
    workday: 2,
    owner: 'priya',
    reviewer: 'casey',
    skill: 'bank-reconciliation',
    input: { bankAccount: 'UK-OP' },
    deps: ['T01'],
    entity: 'UK',
    control: 'CTL-03 Bank reconciliations',
  },
  {
    code: 'T06',
    title: 'Review journal entries for anomalies',
    description: 'Test the month’s entries for duplicates, round amounts, weekend or after-hours postings, self-approved entries, manual postings to control accounts and Benford deviations.',
    category: 'review',
    workday: 2,
    owner: 'priya',
    reviewer: 'casey',
    skill: 'je-review',
    input: {},
    deps: ['T01'],
    entity: null,
    control: 'CTL-04 Journal entry review',
  },
  {
    code: 'T07',
    title: 'Accrue unrecorded liabilities',
    description: 'Find goods and services received but not yet billed — open purchase orders, recurring vendors, bills that arrived after month end and unpaid payroll — and accrue them with automatic reversal.',
    category: 'accruals',
    workday: 3,
    owner: 'sam',
    reviewer: 'priya',
    skill: 'accrual-detection',
    input: {},
    deps: ['T01'],
    entity: null,
    control: 'CTL-05 Cut-off and completeness of liabilities',
  },
  {
    code: 'T08',
    title: 'Prepaid expenses and amortisation',
    description: 'Amortise prepaid schedules, catch up missed months, and move multi-month purchases that were expensed into prepaid with a schedule.',
    category: 'prepaids',
    workday: 3,
    owner: 'sam',
    reviewer: 'priya',
    skill: 'prepaid-amortization',
    input: {},
    deps: ['T02'],
    entity: 'US',
    control: 'CTL-06 Prepaid substantiation',
  },
  {
    code: 'T09',
    title: 'Fixed assets and depreciation',
    description: 'Register newly capitalised assets and record the month’s straight-line depreciation by department.',
    category: 'fixed_assets',
    workday: 3,
    owner: 'sam',
    reviewer: 'priya',
    skill: 'fixed-asset-depreciation',
    input: {},
    deps: ['T02'],
    entity: 'US',
    control: 'CTL-07 Fixed asset register',
  },
  {
    code: 'T10',
    title: 'Tie out AP subledger to the GL',
    description: 'Compare open vendor bills with the accounts payable control account and explain every difference.',
    category: 'ap',
    workday: 3,
    owner: 'dana',
    reviewer: 'priya',
    skill: 'subledger-tieout',
    input: { subledger: 'ap' },
    deps: ['T06', 'T07'],
    entity: null,
    control: 'CTL-08 Subledger to GL tie-out',
  },
  {
    code: 'T11',
    title: 'Tie out AR subledger to the GL',
    description: 'Compare open customer invoices with accounts receivable and explain every difference.',
    category: 'ar',
    workday: 3,
    owner: 'sam',
    reviewer: 'priya',
    skill: 'subledger-tieout',
    input: { subledger: 'ar' },
    deps: ['T03', 'T06'],
    entity: null,
    control: 'CTL-08 Subledger to GL tie-out',
  },
  {
    code: 'T12',
    title: 'Reconcile intercompany and propose eliminations',
    description: 'Agree balances and activity between Kitewell US and Kitewell UK, fix one-sided entries, and prepare the consolidation eliminations.',
    category: 'intercompany',
    workday: 3,
    owner: 'priya',
    reviewer: 'casey',
    skill: 'intercompany-reconciliation',
    input: {},
    deps: ['T03', 'T05'],
    entity: null,
    control: 'CTL-09 Intercompany agreement',
  },
  {
    code: 'T13',
    title: 'Revalue foreign-currency balances',
    description: 'Remeasure monetary balances held in a non-functional currency at the closing rate (ASC 830).',
    category: 'fx',
    workday: 3,
    owner: 'priya',
    reviewer: 'casey',
    skill: 'fx-revaluation',
    input: {},
    deps: ['T12'],
    entity: 'UK',
    control: 'CTL-10 FX remeasurement',
  },
  {
    code: 'T14',
    title: 'Explain material variances (flux)',
    description: 'Compare the month with the prior month and with budget, find the drivers of every material change and write explanations for review.',
    category: 'review',
    workday: 4,
    owner: 'miguel',
    reviewer: 'casey',
    skill: 'flux-analysis',
    input: { comparisons: ['prior_month', 'budget'] },
    deps: ['T04', 'T07', 'T08', 'T09', 'T10', 'T11', 'T13'],
    entity: null,
    control: 'CTL-11 Flux review',
  },
  {
    code: 'T15',
    title: 'Prepare the close package',
    description: 'Assemble the consolidated trial balance, balance sheet, income statement, reconciliation summary, variance commentary and exceptions for sign-off.',
    category: 'reporting',
    workday: 5,
    owner: 'casey',
    reviewer: 'jordan',
    skill: 'close-package',
    input: {},
    deps: ['T14', 'T02', 'T12'],
    entity: null,
    control: 'CTL-12 Financial statement review',
  },
];

export type RecType = 'bank' | 'subledger' | 'intercompany' | 'balance_substantiation';

export interface RecTemplate {
  key: string;
  title: string;
  entity: 'US' | 'UK';
  account: string;
  type: RecType;
  bank?: 'US-OP' | 'US-PAY' | 'UK-OP';
  subledger?: 'ap' | 'ar' | 'prepaid' | 'fixed_asset' | 'accumulated_depreciation';
  counterparty?: 'US' | 'UK';
  owner: UserKey;
  reviewer: UserKey;
  risk: 'low' | 'medium' | 'high';
  task: string;
  /** cents; differences within tolerance count as reconciled */
  tolerance: number;
}

export const REC_TEMPLATE: RecTemplate[] = [
  { key: 'bank:US-OP', title: 'US operating account ••4821', entity: 'US', account: '1000', type: 'bank', bank: 'US-OP', owner: 'sam', reviewer: 'priya', risk: 'high', task: 'T03', tolerance: 0 },
  { key: 'bank:US-PAY', title: 'US payroll account ••7730', entity: 'US', account: '1010', type: 'bank', bank: 'US-PAY', owner: 'sam', reviewer: 'priya', risk: 'medium', task: 'T04', tolerance: 0 },
  { key: 'bank:UK-OP', title: 'UK operating account (GBP)', entity: 'UK', account: '1050', type: 'bank', bank: 'UK-OP', owner: 'priya', reviewer: 'casey', risk: 'medium', task: 'T05', tolerance: 0 },
  { key: 'sub:ap:US', title: 'Accounts payable — US', entity: 'US', account: '2000', type: 'subledger', subledger: 'ap', owner: 'dana', reviewer: 'priya', risk: 'high', task: 'T10', tolerance: 0 },
  { key: 'sub:ap:UK', title: 'Accounts payable — UK', entity: 'UK', account: '2000', type: 'subledger', subledger: 'ap', owner: 'priya', reviewer: 'casey', risk: 'low', task: 'T10', tolerance: 0 },
  { key: 'sub:ar:US', title: 'Accounts receivable — US', entity: 'US', account: '1100', type: 'subledger', subledger: 'ar', owner: 'sam', reviewer: 'priya', risk: 'high', task: 'T11', tolerance: 0 },
  { key: 'sub:ar:UK', title: 'Accounts receivable — UK', entity: 'UK', account: '1100', type: 'subledger', subledger: 'ar', owner: 'priya', reviewer: 'casey', risk: 'low', task: 'T11', tolerance: 0 },
  { key: 'ic:US-UK', title: 'Intercompany — due from Kitewell UK', entity: 'US', account: '1300', type: 'intercompany', counterparty: 'UK', owner: 'priya', reviewer: 'casey', risk: 'medium', task: 'T12', tolerance: 100 },
  { key: 'bs:1210', title: 'Prepaid software', entity: 'US', account: '1210', type: 'balance_substantiation', subledger: 'prepaid', owner: 'sam', reviewer: 'priya', risk: 'low', task: 'T08', tolerance: 0 },
  { key: 'bs:1220', title: 'Prepaid insurance', entity: 'US', account: '1220', type: 'balance_substantiation', subledger: 'prepaid', owner: 'sam', reviewer: 'priya', risk: 'low', task: 'T08', tolerance: 0 },
  { key: 'bs:1500', title: 'Computer equipment (cost)', entity: 'US', account: '1500', type: 'balance_substantiation', subledger: 'fixed_asset', owner: 'sam', reviewer: 'priya', risk: 'low', task: 'T09', tolerance: 0 },
  { key: 'bs:1590', title: 'Accumulated depreciation', entity: 'US', account: '1590', type: 'balance_substantiation', subledger: 'accumulated_depreciation', owner: 'sam', reviewer: 'priya', risk: 'low', task: 'T09', tolerance: 0 },
];

/** Default plain-English policies per skill (editable in the Skills screen, versioned). */
export const DEFAULT_POLICY_TEXT: Record<string, string> = {
  'transaction-coding': [
    'When merchant contains "Northcrest Air", code to 6300 Travel',
    'When merchant contains "Skyway Inn", code to 6300 Travel',
    'When merchant contains "Gitwise", code to 6200 Software Subscriptions, department Engineering',
    'When mcc is 5812, code to 6310 Meals & Entertainment',
    'Never auto-post when memo contains "gift"',
    'Flag amount over $5,000',
    'Auto-post only when amount is under $2,500',
    'Require 85% confidence to auto-post',
  ].join('\n'),
  'bank-reconciliation': ['Auto-post only when amount is under $2,500', 'Require 85% confidence to auto-post'].join('\n'),
  'accrual-detection': ['Auto-post only when amount is under $5,000', 'Require 90% confidence to auto-post'].join('\n'),
  'prepaid-amortization': ['Auto-post only when amount is under $5,000', 'Require 90% confidence to auto-post'].join('\n'),
  'fixed-asset-depreciation': ['Auto-post only when amount is under $25,000', 'Require 95% confidence to auto-post'].join('\n'),
  'subledger-tieout': 'Auto-post only when amount is under $1,000',
  'intercompany-reconciliation': 'Auto-post only when amount is under $1,000',
  'fx-revaluation': ['Auto-post only when amount is under $2,500', 'Require 95% confidence to auto-post'].join('\n'),
};

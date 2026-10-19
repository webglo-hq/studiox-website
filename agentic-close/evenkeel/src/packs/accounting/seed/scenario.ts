/**
 * Kitewell Labs — a FICTIONAL B2B software company used for the Evenkeel demo.
 * Every name below (company, people, banks, vendors, customers, merchants) is invented.
 */
export const SCENARIO = {
  seed: 'evenkeel-kitewell-2026',
  tenant: { name: 'Kitewell Labs (fictional demo company)', slug: 'kitewell', timezone: 'America/Los_Angeles', reporting_currency: 'USD' },
  firstPeriod: '2025-09',
  openPeriod: '2026-09',
  lastPeriod: '2026-12',
  /** Business "now": WD+2 of the September 2026 close, 9:05am Pacific. */
  asOf: '2026-10-02T16:05:00.000Z',
  materiality: { overall: 30_000_000, performance: 22_500_000, clearlyTrivial: 1_500_000 },
  capitalizationThreshold: 250_000,
  prepaidThreshold: 500_000,
};

export const ENTITIES = [
  { code: 'US', name: 'Kitewell US', legal_name: 'Kitewell Labs, Inc.', functional_currency: 'USD', country: 'US', is_elimination: false },
  { code: 'UK', name: 'Kitewell UK', legal_name: 'Kitewell Labs Ltd', functional_currency: 'GBP', country: 'GB', is_elimination: false },
  { code: 'CONSOL', name: 'Consolidation', legal_name: 'Kitewell consolidation (eliminations)', functional_currency: 'USD', country: 'US', is_elimination: true },
] as const;

export const CURRENCIES = [
  { code: 'USD', name: 'US Dollar', minor_units: 2 },
  { code: 'GBP', name: 'Pound Sterling', minor_units: 2 },
  { code: 'EUR', name: 'Euro', minor_units: 2 },
];

/** GBP→USD month-end closing rates (fictional but plausible). */
export const GBPUSD_CLOSING: Record<string, number> = {
  '2025-08': 1.35,
  '2025-09': 1.344,
  '2025-10': 1.331,
  '2025-11': 1.325,
  '2025-12': 1.342,
  '2026-01': 1.356,
  '2026-02': 1.361,
  '2026-03': 1.348,
  '2026-04': 1.339,
  '2026-05': 1.352,
  '2026-06': 1.365,
  '2026-07': 1.358,
  '2026-08': 1.347,
  '2026-09': 1.3412,
  '2026-10': 1.3398,
  '2026-11': 1.3398,
  '2026-12': 1.3398,
};
export const GBPUSD_HISTORICAL = 1.25;

export const FS_LINES = [
  { code: 'BS-CASH', statement: 'BS', label: 'Cash and cash equivalents', section: 'Assets — current', sort: 10, xbrl: 'us-gaap:CashAndCashEquivalentsAtCarryingValue', sign: 'debit' },
  { code: 'BS-AR', statement: 'BS', label: 'Accounts receivable, net', section: 'Assets — current', sort: 20, xbrl: 'us-gaap:AccountsReceivableNetCurrent', sign: 'debit' },
  { code: 'BS-PREPAID', statement: 'BS', label: 'Prepaid expenses and other current assets', section: 'Assets — current', sort: 30, xbrl: 'us-gaap:PrepaidExpenseAndOtherAssetsCurrent', sign: 'debit' },
  { code: 'BS-DUEFROM', statement: 'BS', label: 'Due from affiliates', section: 'Assets — current', sort: 40, xbrl: 'us-gaap:DueFromAffiliateCurrent', sign: 'debit' },
  { code: 'BS-PPE', statement: 'BS', label: 'Property and equipment, net', section: 'Assets — non-current', sort: 50, xbrl: 'us-gaap:PropertyPlantAndEquipmentNet', sign: 'debit' },
  { code: 'BS-OTHERA', statement: 'BS', label: 'Other assets', section: 'Assets — non-current', sort: 60, xbrl: 'us-gaap:OtherAssetsNoncurrent', sign: 'debit' },
  { code: 'BS-AP', statement: 'BS', label: 'Accounts payable', section: 'Liabilities — current', sort: 110, xbrl: 'us-gaap:AccountsPayableCurrent', sign: 'credit' },
  { code: 'BS-ACCRUED', statement: 'BS', label: 'Accrued liabilities', section: 'Liabilities — current', sort: 120, xbrl: 'us-gaap:AccruedLiabilitiesCurrent', sign: 'credit' },
  { code: 'BS-CARD', statement: 'BS', label: 'Credit card payable', section: 'Liabilities — current', sort: 130, xbrl: 'ek-ext:CreditCardPayableCurrent', sign: 'credit' },
  { code: 'BS-DEFREV', statement: 'BS', label: 'Deferred revenue', section: 'Liabilities — current', sort: 140, xbrl: 'us-gaap:ContractWithCustomerLiabilityCurrent', sign: 'credit' },
  { code: 'BS-DUETO', statement: 'BS', label: 'Due to affiliates', section: 'Liabilities — current', sort: 150, xbrl: 'us-gaap:DueToAffiliateCurrent', sign: 'credit' },
  { code: 'BS-STOCK', statement: 'BS', label: 'Common stock and additional paid-in capital', section: 'Equity', sort: 210, xbrl: 'us-gaap:CommonStocksIncludingAdditionalPaidInCapital', sign: 'credit' },
  { code: 'BS-RE', statement: 'BS', label: 'Accumulated deficit', section: 'Equity', sort: 220, xbrl: 'us-gaap:RetainedEarningsAccumulatedDeficit', sign: 'credit' },
  { code: 'BS-AOCI', statement: 'BS', label: 'Accumulated other comprehensive income', section: 'Equity', sort: 230, xbrl: 'us-gaap:AccumulatedOtherComprehensiveIncomeLossNetOfTax', sign: 'credit' },
  { code: 'IS-REV', statement: 'IS', label: 'Subscription revenue', section: 'Revenue', sort: 310, xbrl: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', sign: 'credit' },
  { code: 'IS-SVC', statement: 'IS', label: 'Services revenue', section: 'Revenue', sort: 320, xbrl: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', sign: 'credit' },
  { code: 'IS-ICREV', statement: 'IS', label: 'Intercompany revenue', section: 'Revenue', sort: 330, xbrl: 'us-gaap:RevenueFromRelatedParties', sign: 'credit' },
  { code: 'IS-COGS', statement: 'IS', label: 'Cost of revenue — hosting', section: 'Cost of revenue', sort: 410, xbrl: 'us-gaap:CostOfRevenue', sign: 'debit' },
  { code: 'IS-PAYROLL', statement: 'IS', label: 'Payroll and benefits', section: 'Operating expenses', sort: 510, xbrl: 'us-gaap:LaborAndRelatedExpense', sign: 'debit' },
  { code: 'IS-SOFTWARE', statement: 'IS', label: 'Software and subscriptions', section: 'Operating expenses', sort: 520, xbrl: 'ek-ext:SoftwareSubscriptionsExpense', sign: 'debit' },
  { code: 'IS-MKT', statement: 'IS', label: 'Marketing and advertising', section: 'Operating expenses', sort: 530, xbrl: 'us-gaap:MarketingAndAdvertisingExpense', sign: 'debit' },
  { code: 'IS-TRAVEL', statement: 'IS', label: 'Travel, meals and entertainment', section: 'Operating expenses', sort: 540, xbrl: 'us-gaap:TravelAndEntertainmentExpense', sign: 'debit' },
  { code: 'IS-PROF', statement: 'IS', label: 'Professional fees', section: 'Operating expenses', sort: 550, xbrl: 'us-gaap:ProfessionalFees', sign: 'debit' },
  { code: 'IS-OCC', statement: 'IS', label: 'Rent, utilities and facilities', section: 'Operating expenses', sort: 560, xbrl: 'us-gaap:OccupancyNet', sign: 'debit' },
  { code: 'IS-DEPR', statement: 'IS', label: 'Depreciation', section: 'Operating expenses', sort: 570, xbrl: 'us-gaap:Depreciation', sign: 'debit' },
  { code: 'IS-OTHEROPEX', statement: 'IS', label: 'Other operating expenses', section: 'Operating expenses', sort: 580, xbrl: 'us-gaap:OtherCostAndExpenseOperating', sign: 'debit' },
  { code: 'IS-OTHER', statement: 'IS', label: 'Other income (expense), net', section: 'Other income (expense)', sort: 610, xbrl: 'us-gaap:NonoperatingIncomeExpense', sign: 'credit' },
  { code: 'IS-TAX', statement: 'IS', label: 'Income tax expense', section: 'Income tax', sort: 710, xbrl: 'us-gaap:IncomeTaxExpenseBenefit', sign: 'debit' },
] as const;

type Cls = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export interface AccountSeed {
  code: string;
  name: string;
  cls: Cls;
  type: string;
  normal?: 'debit' | 'credit';
  fs: string;
  dept?: boolean;
  control?: 'ap' | 'ar' | 'bank' | 'card' | 'fixed_asset' | 'prepaid' | 'payroll';
  ic?: boolean;
  monetary?: boolean;
  concept?: string;
  description?: string;
}

export const ACCOUNTS: AccountSeed[] = [
  { code: '1000', name: 'Cash — Operating (First Meridian)', cls: 'asset', type: 'ek:CashAccount', fs: 'BS-CASH', control: 'bank', monetary: true },
  { code: '1010', name: 'Cash — Payroll (First Meridian)', cls: 'asset', type: 'ek:CashAccount', fs: 'BS-CASH', control: 'bank', monetary: true },
  { code: '1050', name: 'Cash — UK Operating (Harbourline)', cls: 'asset', type: 'ek:CashAccount', fs: 'BS-CASH', control: 'bank', monetary: true },
  { code: '1100', name: 'Accounts Receivable', cls: 'asset', type: 'ek:ReceivableAccount', fs: 'BS-AR', control: 'ar', monetary: true },
  { code: '1150', name: 'Allowance for Doubtful Accounts', cls: 'asset', type: 'ek:ContraAccount', normal: 'credit', fs: 'BS-AR', monetary: true },
  { code: '1200', name: 'Prepaid Expenses — Other', cls: 'asset', type: 'ek:PrepaidAccount', fs: 'BS-PREPAID' },
  { code: '1210', name: 'Prepaid Software', cls: 'asset', type: 'ek:PrepaidAccount', fs: 'BS-PREPAID' },
  { code: '1220', name: 'Prepaid Insurance', cls: 'asset', type: 'ek:PrepaidAccount', fs: 'BS-PREPAID' },
  { code: '1250', name: 'Vendor Refunds Receivable', cls: 'asset', type: 'ek:ReceivableAccount', fs: 'BS-PREPAID', monetary: true },
  { code: '1300', name: 'Due from Kitewell UK', cls: 'asset', type: 'ek:IntercompanyAccount', fs: 'BS-DUEFROM', ic: true, monetary: true },
  { code: '1500', name: 'Computer Equipment', cls: 'asset', type: 'ek:FixedAssetAccount', fs: 'BS-PPE', control: 'fixed_asset' },
  { code: '1510', name: 'Furniture & Fixtures', cls: 'asset', type: 'ek:FixedAssetAccount', fs: 'BS-PPE', control: 'fixed_asset' },
  { code: '1590', name: 'Accumulated Depreciation', cls: 'asset', type: 'ek:AccumulatedDepreciationAccount', normal: 'credit', fs: 'BS-PPE' },
  { code: '1700', name: 'Security Deposits', cls: 'asset', type: 'ek:AssetAccount', fs: 'BS-OTHERA', monetary: true },
  { code: '1999', name: 'Suspense — Under Investigation', cls: 'asset', type: 'ek:AssetAccount', fs: 'BS-OTHERA', monetary: true, description: 'Temporary holding account for unexplained items pending investigation.' },
  { code: '2000', name: 'Accounts Payable', cls: 'liability', type: 'ek:PayableAccount', fs: 'BS-AP', control: 'ap', monetary: true },
  { code: '2100', name: 'Accrued Liabilities', cls: 'liability', type: 'ek:AccruedLiabilityAccount', fs: 'BS-ACCRUED', monetary: true },
  { code: '2110', name: 'Accrued Payroll', cls: 'liability', type: 'ek:PayrollLiabilityAccount', fs: 'BS-ACCRUED', monetary: true },
  { code: '2120', name: 'Payroll Taxes & Benefits Payable', cls: 'liability', type: 'ek:PayrollLiabilityAccount', fs: 'BS-ACCRUED', monetary: true },
  { code: '2200', name: 'Corporate Card Payable', cls: 'liability', type: 'ek:CardPayableAccount', fs: 'BS-CARD', control: 'card', monetary: true },
  { code: '2300', name: 'Deferred Revenue', cls: 'liability', type: 'ek:DeferredRevenueAccount', fs: 'BS-DEFREV' },
  { code: '2400', name: 'Due to Kitewell US', cls: 'liability', type: 'ek:IntercompanyAccount', fs: 'BS-DUETO', ic: true, monetary: true },
  { code: '3000', name: 'Common Stock', cls: 'equity', type: 'ek:EquityAccount', fs: 'BS-STOCK' },
  { code: '3100', name: 'Additional Paid-in Capital', cls: 'equity', type: 'ek:EquityAccount', fs: 'BS-STOCK' },
  { code: '3200', name: 'Accumulated Deficit', cls: 'equity', type: 'ek:RetainedEarningsAccount', fs: 'BS-RE' },
  { code: '3300', name: 'Cumulative Translation Adjustment', cls: 'equity', type: 'ek:CtaAccount', fs: 'BS-AOCI' },
  { code: '4000', name: 'Subscription Revenue', cls: 'revenue', type: 'ek:RevenueAccount', fs: 'IS-REV' },
  { code: '4100', name: 'Professional Services Revenue', cls: 'revenue', type: 'ek:RevenueAccount', fs: 'IS-SVC' },
  { code: '4900', name: 'Intercompany Management Fee Revenue', cls: 'revenue', type: 'ek:IntercompanyAccount', fs: 'IS-ICREV', ic: true },
  { code: '5000', name: 'Cloud Hosting', cls: 'expense', type: 'ek:CostOfRevenue', fs: 'IS-COGS', dept: true, concept: 'ek:HostingExpense' },
  { code: '6000', name: 'Salaries & Wages', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-PAYROLL', dept: true, concept: 'ek:PayrollExpense' },
  { code: '6010', name: 'Payroll Taxes', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-PAYROLL', dept: true },
  { code: '6020', name: 'Employee Benefits', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-PAYROLL', dept: true },
  { code: '6100', name: 'Rent & Facilities', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-OCC', dept: true, concept: 'ek:RentExpense' },
  { code: '6150', name: 'Utilities', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-OCC', dept: true, concept: 'ek:UtilitiesExpense' },
  { code: '6200', name: 'Software Subscriptions', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-SOFTWARE', dept: true, concept: 'ek:SoftwareExpense' },
  { code: '6300', name: 'Travel', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-TRAVEL', dept: true, concept: 'ek:TravelExpense' },
  { code: '6310', name: 'Meals & Entertainment', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-TRAVEL', dept: true, concept: 'ek:MealsExpense' },
  { code: '6400', name: 'Marketing & Advertising', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-MKT', dept: true, concept: 'ek:MarketingExpense' },
  { code: '6500', name: 'Professional Fees', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-PROF', dept: true, concept: 'ek:ProfessionalFeesExpense' },
  { code: '6600', name: 'Office Supplies', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-OTHEROPEX', dept: true, concept: 'ek:OfficeExpense' },
  { code: '6610', name: 'Small Computer Equipment', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-OTHEROPEX', dept: true, concept: 'ek:ComputerEquipment' },
  { code: '6650', name: 'Telecom & Internet', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-OTHEROPEX', dept: true, concept: 'ek:TelecomExpense' },
  { code: '6700', name: 'Insurance', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-OTHEROPEX', dept: true, concept: 'ek:InsuranceExpense' },
  { code: '6750', name: 'Training & Education', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-OTHEROPEX', dept: true, concept: 'ek:TrainingExpense' },
  { code: '6800', name: 'Depreciation Expense', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-DEPR', dept: true, concept: 'ek:DepreciationExpense' },
  { code: '6850', name: 'Shipping & Postage', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-OTHEROPEX', dept: true, concept: 'ek:ShippingExpense' },
  { code: '6900', name: 'Bank Fees', cls: 'expense', type: 'ek:OperatingExpense', fs: 'IS-OTHEROPEX', concept: 'ek:BankFeesExpense' },
  { code: '6950', name: 'Intercompany Management Fee Expense', cls: 'expense', type: 'ek:IntercompanyAccount', fs: 'IS-OTHEROPEX', ic: true },
  { code: '7000', name: 'FX Gain/Loss', cls: 'expense', type: 'ek:FxGainLossAccount', fs: 'IS-OTHER' },
  { code: '7100', name: 'Interest Income', cls: 'revenue', type: 'ek:RevenueAccount', fs: 'IS-OTHER' },
  { code: '8000', name: 'Income Tax Expense', cls: 'expense', type: 'ek:ExpenseAccount', fs: 'IS-TAX' },
];

export const DEPARTMENTS = [
  { code: 'ENG', name: 'Engineering' },
  { code: 'SALES', name: 'Sales' },
  { code: 'MKT', name: 'Marketing' },
  { code: 'GA', name: 'G&A' },
  { code: 'CS', name: 'Customer Success' },
];
export const LOCATIONS = [
  { code: 'SF', name: 'San Francisco' },
  { code: 'NYC', name: 'New York' },
  { code: 'LDN', name: 'London' },
];
export const CLASSES = [
  { code: 'PLATFORM', name: 'Platform' },
  { code: 'SERVICES', name: 'Services' },
];
export const PROJECTS = [{ code: 'ATLAS', name: 'Project Atlas (data platform)' }];

/** Demo users. Emails use the reserved .example TLD. */
export const USERS = [
  { key: 'sam', email: 'sam@kitewell.example', name: 'Sam Rivera', title: 'Staff Accountant', role: 'staff_accountant', dept: 'GA' },
  { key: 'dana', email: 'dana@kitewell.example', name: 'Dana Okafor', title: 'AP Specialist', role: 'ap_clerk', dept: 'GA' },
  { key: 'miguel', email: 'miguel@kitewell.example', name: 'Miguel Santos', title: 'FP&A Analyst', role: 'fpa_analyst', dept: 'GA' },
  { key: 'priya', email: 'priya@kitewell.example', name: 'Priya Natarajan', title: 'Senior Accountant', role: 'senior_accountant', dept: 'GA' },
  { key: 'casey', email: 'casey@kitewell.example', name: 'Casey Morgan', title: 'Controller', role: 'controller', dept: 'GA' },
  { key: 'jordan', email: 'jordan@kitewell.example', name: 'Jordan Blake', title: 'Chief Financial Officer', role: 'cfo', dept: 'GA' },
  { key: 'alex', email: 'alex@auditfirm.example', name: 'Alex Chen', title: 'External Auditor (read-only)', role: 'auditor', dept: null },
  { key: 'taylor', email: 'taylor@kitewell.example', name: 'Taylor Brooks', title: 'IT Administrator', role: 'admin', dept: 'GA' },
] as const;
export type UserKey = (typeof USERS)[number]['key'];

export interface VendorSeed {
  name: string;
  account: string;
  dept: string;
  terms: number;
  method: 'ach' | 'check' | 'wire';
  /** monthly amount in cents (0 = ad hoc) */
  monthly: number;
  /** billing in arrears (bill dated next month for this month's service) */
  arrears: boolean;
  entity: 'US' | 'UK';
  jitter: number;
  bankName?: string;
}

export const VENDORS: VendorSeed[] = [
  { name: 'Atlas Workspace Partners', account: '6100', dept: 'GA', terms: 0, method: 'wire', monthly: 6_800_000, arrears: false, entity: 'US', jitter: 0, bankName: 'ATLAS WORKSPACE' },
  { name: 'Nimbus Cloud Services', account: '5000', dept: 'ENG', terms: 15, method: 'ach', monthly: 13_800_000, arrears: true, entity: 'US', jitter: 0.04, bankName: 'NIMBUS CLOUD SVCS' },
  { name: 'Brightpath Legal LLP', account: '6500', dept: 'GA', terms: 30, method: 'ach', monthly: 1_840_000, arrears: true, entity: 'US', jitter: 0.06, bankName: 'BRIGHTPATH LEGAL' },
  { name: 'Corelink Telecom', account: '6650', dept: 'GA', terms: 20, method: 'ach', monthly: 421_250, arrears: true, entity: 'US', jitter: 0, bankName: 'CORELINK TEL' },
  { name: 'Helio Utilities', account: '6150', dept: 'GA', terms: 20, method: 'ach', monthly: 312_000, arrears: true, entity: 'US', jitter: 0.08, bankName: 'HELIO UTIL' },
  { name: 'Signal Ads Network', account: '6400', dept: 'MKT', terms: 30, method: 'ach', monthly: 4_500_000, arrears: true, entity: 'US', jitter: 0.07, bankName: 'SIGNAL ADS' },
  { name: 'Quillsoft Accounting Cloud', account: '6200', dept: 'GA', terms: 30, method: 'ach', monthly: 640_000, arrears: false, entity: 'US', jitter: 0, bankName: 'QUILLSOFT' },
  { name: 'Northgate Consulting Group', account: '6500', dept: 'ENG', terms: 30, method: 'ach', monthly: 0, arrears: true, entity: 'US', jitter: 0, bankName: 'NORTHGATE CONSULT' },
  { name: 'Sparrow Print & Signage', account: '6600', dept: 'MKT', terms: 30, method: 'check', monthly: 0, arrears: false, entity: 'US', jitter: 0, bankName: 'SPARROW PRINT' },
  { name: 'Lumen Mutual Insurance', account: '6700', dept: 'GA', terms: 30, method: 'ach', monthly: 0, arrears: false, entity: 'US', jitter: 0, bankName: 'LUMEN MUTUAL' },
  { name: 'Gridline Analytics', account: '6200', dept: 'ENG', terms: 30, method: 'ach', monthly: 0, arrears: false, entity: 'US', jitter: 0, bankName: 'GRIDLINE ANALYTICS' },
  { name: 'Cobalt CRM', account: '6200', dept: 'SALES', terms: 30, method: 'ach', monthly: 0, arrears: false, entity: 'US', jitter: 0, bankName: 'COBALT CRM' },
  { name: 'Ledgerlight Software', account: '6200', dept: 'GA', terms: 30, method: 'ach', monthly: 0, arrears: false, entity: 'US', jitter: 0, bankName: 'LEDGERLIGHT SW' },
  { name: 'Brightstage Events', account: '6400', dept: 'MKT', terms: 15, method: 'wire', monthly: 0, arrears: false, entity: 'US', jitter: 0, bankName: 'BRIGHTSTAGE EVENTS' },
  { name: 'Keystone Recruiting', account: '6500', dept: 'GA', terms: 30, method: 'ach', monthly: 0, arrears: true, entity: 'US', jitter: 0, bankName: 'KEYSTONE RECRUIT' },
  { name: 'Parcelwise Couriers', account: '6850', dept: 'GA', terms: 30, method: 'ach', monthly: 95_000, arrears: true, entity: 'US', jitter: 0.25, bankName: 'PARCELWISE' },
  { name: 'Thamesbridge Offices Ltd', account: '6100', dept: 'GA', terms: 0, method: 'ach', monthly: 1_450_000, arrears: false, entity: 'UK', jitter: 0, bankName: 'THAMESBRIDGE OFFICES' },
  { name: 'Ledger & Co Accountants LLP', account: '6500', dept: 'GA', terms: 30, method: 'ach', monthly: 320_000, arrears: true, entity: 'UK', jitter: 0.05, bankName: 'LEDGER AND CO' },
  { name: 'Kingsway Telecom', account: '6650', dept: 'GA', terms: 20, method: 'ach', monthly: 78_000, arrears: true, entity: 'UK', jitter: 0.03, bankName: 'KINGSWAY TELECOM' },
];

export interface CustomerSeed {
  name: string;
  mrr: number;
  annual: boolean;
  entity: 'US' | 'UK';
  anniversaryMonth: number;
}

const US_CUSTOMERS = [
  'Bluefin Logistics', 'Cedarline Health', 'Driftwood Media', 'Emberly Foods', 'Foxglove Retail', 'Granite Peak Energy', 'Halcyon Freight', 'Ironbark Systems',
  'Juniper Mobility', 'Kettle River Brewing', 'Lanternfish Games', 'Meridian Ortho', 'Nettlefield Pharmacy Group', 'Oakmont Realty', 'Pinecrest Schools', 'Quarry Labs',
  'Redwood Analytics', 'Saltmarsh Outfitters', 'Tidewater Credit Union', 'Upland Robotics', 'Vantage Dental', 'Willowbrook Senior Living', 'Yellowtail Travel', 'Zephyr Aerial',
  'Aspen Ridge Insurance', 'Blackwater Marine', 'Copperleaf Studios', 'Dovetail Construction', 'Evergreen Pediatrics', 'Fieldstone Farms', 'Glacier Bay Tours', 'Harborlight Exports',
  'Indigo Fintech', 'Jetstream Courier', 'Kodiak Outdoor', 'Lumina Optics', 'Mosaic Learning', 'Nightjar Security',
];

export const CUSTOMERS: CustomerSeed[] = [
  ...US_CUSTOMERS.map((name, i) => ({ name, mrr: 1_500_000 + ((i * 7919) % 45) * 100_000, annual: i % 5 === 2, entity: 'US' as const, anniversaryMonth: ((i * 5) % 12) + 1 })),
  ...['Albion Rail Ltd', 'Bramble & Finch', 'Canterbury Clinics', 'Dorset Mills', 'Exeter Analytics', 'Fenwick Legal', 'Glasshouse Studio', 'Hartley Insurance', 'Islington Foods', 'Jarrow Marine', 'Kestrel Pharma UK', 'Lowther Estates'].map((name, i) => ({
    name,
    mrr: 900_000 + ((i * 3571) % 14) * 100_000,
    annual: false,
    entity: 'UK' as const,
    anniversaryMonth: 1,
  })),
];

export interface MerchantSeed {
  name: string;
  mcc: string;
  min: number;
  max: number;
  freq: number;
  account: string;
  memo?: string;
  depts?: string[];
  entity?: 'US' | 'UK';
}

/** Card merchants (all fictional). Coding history is consistent per merchant. */
export const MERCHANTS: MerchantSeed[] = [
  { name: 'Northcrest Air', mcc: '4511', min: 28_000, max: 92_000, freq: 9, account: '6300', depts: ['SALES', 'CS', 'ENG'] },
  { name: 'Skyway Inn & Suites', mcc: '7011', min: 18_000, max: 54_000, freq: 8, account: '6300', depts: ['SALES', 'CS'] },
  { name: 'Metro Rideshare', mcc: '4121', min: 1_800, max: 7_400, freq: 16, account: '6300', depts: ['SALES', 'ENG', 'CS', 'MKT'] },
  { name: 'Harbor Grill', mcc: '5812', min: 6_000, max: 38_000, freq: 9, account: '6310', depts: ['SALES', 'GA'] },
  { name: 'Copperpot Cafe', mcc: '5814', min: 900, max: 4_200, freq: 12, account: '6310', depts: ['ENG', 'MKT', 'GA'] },
  { name: 'Quillsoft Accounting Cloud', mcc: '5734', min: 28_900, max: 28_900, freq: 1, account: '6200', depts: ['GA'], memo: 'Monthly seats' },
  { name: 'Figbox Design', mcc: '5734', min: 14_400, max: 19_200, freq: 1, account: '6200', depts: ['MKT'], memo: 'Design tool seats' },
  { name: 'Gitwise Code Hosting', mcc: '5817', min: 42_000, max: 46_800, freq: 1, account: '6200', depts: ['ENG'], memo: 'Team plan' },
  { name: 'Slatebox Docs', mcc: '5817', min: 9_600, max: 9_600, freq: 1, account: '6200', depts: ['GA'] },
  { name: 'Pulse Metrics', mcc: '7372', min: 21_000, max: 24_000, freq: 1, account: '6200', depts: ['ENG'] },
  { name: 'Signal Ads Network', mcc: '7311', min: 40_000, max: 180_000, freq: 3, account: '6400', depts: ['MKT'], memo: 'Paid social boost' },
  { name: 'Brightwave Webinars', mcc: '7392', min: 30_000, max: 75_000, freq: 1, account: '6400', depts: ['MKT'] },
  { name: 'Paper Lantern Office Supply', mcc: '5943', min: 2_500, max: 18_000, freq: 4, account: '6600', depts: ['GA'] },
  { name: 'Parcelwise Couriers', mcc: '4215', min: 1_400, max: 9_800, freq: 4, account: '6850', depts: ['GA', 'MKT'] },
  { name: 'Kestrel Computers', mcc: '5732', min: 4_900, max: 39_000, freq: 2, account: '6610', depts: ['ENG'], memo: 'Monitors / accessories' },
  { name: 'Learnloop Academy', mcc: '8299', min: 19_900, max: 79_900, freq: 1, account: '6750', depts: ['ENG', 'CS'] },
  { name: 'Thames Taxi', mcc: '4121', min: 1_200, max: 4_800, freq: 6, account: '6300', depts: ['SALES'], entity: 'UK' },
  { name: 'Borough Market Kitchen', mcc: '5812', min: 2_400, max: 14_000, freq: 5, account: '6310', depts: ['SALES', 'GA'], entity: 'UK' },
  { name: 'Railstar Trains', mcc: '4111', min: 3_400, max: 18_000, freq: 4, account: '6300', depts: ['SALES', 'CS'], entity: 'UK' },
  { name: 'Figbox Design', mcc: '5734', min: 4_800, max: 4_800, freq: 1, account: '6200', depts: ['MKT'], entity: 'UK' },
];

/** Headcount and average monthly gross per department (cents). */
export const PAYROLL = {
  US: { ENG: [45, 1_350_000], SALES: [18, 1_100_000], MKT: [9, 1_050_000], GA: [11, 1_000_000], CS: [12, 850_000] } as Record<string, [number, number]>,
  UK: { ENG: [6, 650_000], SALES: [5, 600_000], CS: [3, 480_000] } as Record<string, [number, number]>,
  employerTaxRate: { US: 0.075, UK: 0.138 },
  benefitsPerHead: { US: 90_000, UK: 30_000 },
  withholdingRate: { US: 0.27, UK: 0.3 },
};

export const CARDHOLDERS = [
  { name: 'Riley Park', dept: 'SALES', last4: '4417', entity: 'US' },
  { name: 'Morgan Hale', dept: 'SALES', last4: '5521', entity: 'US' },
  { name: 'Avery Quinn', dept: 'ENG', last4: '6630', entity: 'US' },
  { name: 'Jamie Lowell', dept: 'ENG', last4: '7742', entity: 'US' },
  { name: 'Drew Castillo', dept: 'MKT', last4: '8854', entity: 'US' },
  { name: 'Kai Bennett', dept: 'MKT', last4: '9965', entity: 'US' },
  { name: 'Robin Ash', dept: 'CS', last4: '1176', entity: 'US' },
  { name: 'Sasha Imani', dept: 'GA', last4: '2287', entity: 'US' },
  { name: 'Oliver Grant', dept: 'SALES', last4: '3398', entity: 'UK' },
  { name: 'Freya Collins', dept: 'CS', last4: '4409', entity: 'UK' },
] as const;

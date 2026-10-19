/**
 * Bramblewood Labs — a FICTIONAL company used for demos and tests. Any resemblance to real
 * organizations is coincidental. US parent (USD) + UK subsidiary (GBP) + elimination ledger.
 * Business: environmental-sensor hardware plus an analytics SaaS platform.
 */
import type { DimensionKey, MaterialitySettings } from '../model/types';

export const COMPANY = {
  tenantSlug: 'bramblewood',
  tenantName: 'Bramblewood Labs (fictional demo company)',
  emailDomain: 'bramblewood.example',
};

export const SCENARIO = {
  /** first month with activity (opening balances on the last day of the prior month) */
  historyStart: '2025-09',
  /** the month being closed in the demo */
  closeKey: '2026-09',
  /** scenario clock: WD+2 of the September close */
  businessDate: '2026-10-02',
  lastActivityDate: '2026-10-02',
};

export interface FsLineDef {
  code: string;
  statement: 'BS' | 'IS';
  section: string;
  label: string;
  xbrl: string;
  sort: number;
}

export const FS_LINES: FsLineDef[] = [
  { code: 'BS.CA.CASH', statement: 'BS', section: 'Current assets', label: 'Cash and cash equivalents', xbrl: 'us-gaap:CashAndCashEquivalentsAtCarryingValue', sort: 10 },
  { code: 'BS.CA.AR', statement: 'BS', section: 'Current assets', label: 'Accounts receivable, net', xbrl: 'us-gaap:AccountsReceivableNetCurrent', sort: 20 },
  { code: 'BS.CA.INV', statement: 'BS', section: 'Current assets', label: 'Inventory', xbrl: 'us-gaap:InventoryNet', sort: 30 },
  { code: 'BS.CA.PREPAID', statement: 'BS', section: 'Current assets', label: 'Prepaid expenses and other current assets', xbrl: 'us-gaap:PrepaidExpenseAndOtherAssetsCurrent', sort: 40 },
  { code: 'BS.CA.IC', statement: 'BS', section: 'Current assets', label: 'Due from group entities', xbrl: 'us-gaap:DueFromRelatedPartiesCurrent', sort: 50 },
  { code: 'BS.NCA.PPE', statement: 'BS', section: 'Non-current assets', label: 'Property and equipment, net', xbrl: 'us-gaap:PropertyPlantAndEquipmentNet', sort: 60 },
  { code: 'BS.NCA.ROU', statement: 'BS', section: 'Non-current assets', label: 'Operating lease right-of-use assets', xbrl: 'us-gaap:OperatingLeaseRightOfUseAsset', sort: 70 },
  { code: 'BS.CL.AP', statement: 'BS', section: 'Current liabilities', label: 'Accounts payable', xbrl: 'us-gaap:AccountsPayableCurrent', sort: 80 },
  { code: 'BS.CL.ACCRUED', statement: 'BS', section: 'Current liabilities', label: 'Accrued expenses and other current liabilities', xbrl: 'us-gaap:AccruedLiabilitiesCurrent', sort: 90 },
  { code: 'BS.CL.DEFREV', statement: 'BS', section: 'Current liabilities', label: 'Deferred revenue', xbrl: 'us-gaap:ContractWithCustomerLiabilityCurrent', sort: 100 },
  { code: 'BS.CL.IC', statement: 'BS', section: 'Current liabilities', label: 'Due to group entities', xbrl: 'us-gaap:DueToRelatedPartiesCurrent', sort: 110 },
  { code: 'BS.NCL.LEASE', statement: 'BS', section: 'Non-current liabilities', label: 'Operating lease liabilities', xbrl: 'us-gaap:OperatingLeaseLiabilityNoncurrent', sort: 120 },
  { code: 'BS.EQ.CAPITAL', statement: 'BS', section: 'Equity', label: 'Common stock and additional paid-in capital', xbrl: 'us-gaap:CommonStocksIncludingAdditionalPaidInCapital', sort: 130 },
  { code: 'BS.EQ.RE', statement: 'BS', section: 'Equity', label: 'Retained earnings (accumulated deficit)', xbrl: 'us-gaap:RetainedEarningsAccumulatedDeficit', sort: 140 },
  { code: 'BS.EQ.AOCI', statement: 'BS', section: 'Equity', label: 'Accumulated other comprehensive income', xbrl: 'us-gaap:AccumulatedOtherComprehensiveIncomeLossNetOfTax', sort: 150 },
  { code: 'IS.REV.SUB', statement: 'IS', section: 'Revenue', label: 'Subscription revenue', xbrl: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', sort: 200 },
  { code: 'IS.REV.HW', statement: 'IS', section: 'Revenue', label: 'Hardware revenue', xbrl: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', sort: 210 },
  { code: 'IS.REV.SVC', statement: 'IS', section: 'Revenue', label: 'Professional services revenue', xbrl: 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', sort: 220 },
  { code: 'IS.REV.IC', statement: 'IS', section: 'Revenue', label: 'Intercompany revenue', xbrl: 'us-gaap:RevenueFromRelatedParties', sort: 230 },
  { code: 'IS.COR', statement: 'IS', section: 'Cost of revenue', label: 'Cost of revenue', xbrl: 'us-gaap:CostOfRevenue', sort: 240 },
  { code: 'IS.OPEX.RD', statement: 'IS', section: 'Operating expenses', label: 'Research and development', xbrl: 'us-gaap:ResearchAndDevelopmentExpense', sort: 250 },
  { code: 'IS.OPEX.SM', statement: 'IS', section: 'Operating expenses', label: 'Sales and marketing', xbrl: 'us-gaap:SellingAndMarketingExpense', sort: 260 },
  { code: 'IS.OPEX.GA', statement: 'IS', section: 'Operating expenses', label: 'General and administrative', xbrl: 'us-gaap:GeneralAndAdministrativeExpense', sort: 270 },
  { code: 'IS.OTHER', statement: 'IS', section: 'Other', label: 'Other income (expense), net', xbrl: 'us-gaap:NonoperatingIncomeExpense', sort: 280 },
  { code: 'IS.TAX', statement: 'IS', section: 'Other', label: 'Provision for income taxes', xbrl: 'us-gaap:IncomeTaxExpenseBenefit', sort: 290 },
];

export interface AccountDef {
  code: string;
  name: string;
  cls: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  onto: string;
  contra?: boolean;
  parent?: string;
  postable?: boolean;
  control?: 'ap' | 'ar' | 'bank' | 'card' | 'fixed_assets' | 'prepaid' | 'payroll' | 'intercompany';
  fs: string;
  dims?: DimensionKey[];
  monetary?: boolean;
  ic?: boolean;
  cf?: 'cash' | 'operating' | 'investing' | 'financing';
  description?: string;
}

const D: DimensionKey[] = ['department'];

export const ACCOUNTS: AccountDef[] = [
  { code: '1000', name: 'Cash and cash equivalents', cls: 'asset', onto: 'tie:CashAndCashEquivalents', postable: false, fs: 'BS.CA.CASH', cf: 'cash' },
  { code: '1010', name: 'Cash – First Harbor operating ••4417', cls: 'asset', onto: 'tie:CashAndCashEquivalents', parent: '1000', control: 'bank', fs: 'BS.CA.CASH', monetary: true, cf: 'cash' },
  { code: '1030', name: 'Cash – Thameside operating ••2208', cls: 'asset', onto: 'tie:CashAndCashEquivalents', parent: '1000', control: 'bank', fs: 'BS.CA.CASH', monetary: true, cf: 'cash' },
  { code: '1100', name: 'Accounts receivable', cls: 'asset', onto: 'tie:AccountsReceivable', control: 'ar', fs: 'BS.CA.AR', monetary: true, cf: 'operating' },
  { code: '1150', name: 'Allowance for credit losses', cls: 'asset', onto: 'tie:AllowanceForCreditLosses', contra: true, fs: 'BS.CA.AR', cf: 'operating' },
  { code: '1200', name: 'Prepaid expenses', cls: 'asset', onto: 'tie:PrepaidExpenseAsset', postable: false, fs: 'BS.CA.PREPAID', cf: 'operating' },
  { code: '1210', name: 'Prepaid insurance', cls: 'asset', onto: 'tie:PrepaidExpenseAsset', parent: '1200', control: 'prepaid', fs: 'BS.CA.PREPAID', cf: 'operating' },
  { code: '1220', name: 'Prepaid software', cls: 'asset', onto: 'tie:PrepaidExpenseAsset', parent: '1200', control: 'prepaid', fs: 'BS.CA.PREPAID', cf: 'operating' },
  { code: '1250', name: 'Vendor refunds receivable', cls: 'asset', onto: 'tie:VendorReceivable', fs: 'BS.CA.PREPAID', monetary: true, cf: 'operating' },
  { code: '1300', name: 'Inventory – sensor kits', cls: 'asset', onto: 'tie:InventoryAsset', fs: 'BS.CA.INV', cf: 'operating' },
  { code: '1400', name: 'Due from group entities', cls: 'asset', onto: 'tie:IntercompanyReceivable', control: 'intercompany', fs: 'BS.CA.IC', monetary: true, ic: true, cf: 'operating' },
  { code: '1500', name: 'Property and equipment', cls: 'asset', onto: 'tie:PropertyPlantEquipment', postable: false, fs: 'BS.NCA.PPE', cf: 'investing' },
  { code: '1510', name: 'Computer equipment', cls: 'asset', onto: 'tie:PropertyPlantEquipment', parent: '1500', control: 'fixed_assets', fs: 'BS.NCA.PPE', cf: 'investing' },
  { code: '1520', name: 'Lab equipment', cls: 'asset', onto: 'tie:PropertyPlantEquipment', parent: '1500', control: 'fixed_assets', fs: 'BS.NCA.PPE', cf: 'investing' },
  { code: '1530', name: 'Furniture and fixtures', cls: 'asset', onto: 'tie:PropertyPlantEquipment', parent: '1500', control: 'fixed_assets', fs: 'BS.NCA.PPE', cf: 'investing' },
  { code: '1590', name: 'Accumulated depreciation', cls: 'asset', onto: 'tie:AccumulatedDepreciation', contra: true, parent: '1500', control: 'fixed_assets', fs: 'BS.NCA.PPE', cf: 'investing' },
  { code: '1610', name: 'Operating lease ROU asset', cls: 'asset', onto: 'tie:RightOfUseAsset', fs: 'BS.NCA.ROU', cf: 'operating' },
  { code: '1999', name: 'Suspense – unclassified', cls: 'asset', onto: 'tie:SuspenseAccount', fs: 'BS.CA.PREPAID', cf: 'operating', description: 'Must be zero at close.' },
  { code: '2000', name: 'Accounts payable', cls: 'liability', onto: 'tie:AccountsPayable', control: 'ap', fs: 'BS.CL.AP', monetary: true, cf: 'operating' },
  { code: '2100', name: 'Accrued liabilities', cls: 'liability', onto: 'tie:AccruedLiabilities', postable: false, fs: 'BS.CL.ACCRUED', cf: 'operating' },
  { code: '2110', name: 'Accrued expenses', cls: 'liability', onto: 'tie:AccruedLiabilities', parent: '2100', fs: 'BS.CL.ACCRUED', monetary: true, cf: 'operating' },
  { code: '2120', name: 'Accrued payroll', cls: 'liability', onto: 'tie:AccruedPayroll', parent: '2100', fs: 'BS.CL.ACCRUED', monetary: true, cf: 'operating' },
  { code: '2200', name: 'Corporate card payable', cls: 'liability', onto: 'tie:CreditCardPayable', control: 'card', fs: 'BS.CL.ACCRUED', monetary: true, cf: 'operating' },
  { code: '2300', name: 'Deferred revenue', cls: 'liability', onto: 'tie:DeferredRevenueLiability', fs: 'BS.CL.DEFREV', cf: 'operating' },
  { code: '2400', name: 'Due to group entities', cls: 'liability', onto: 'tie:IntercompanyPayable', control: 'intercompany', fs: 'BS.CL.IC', monetary: true, ic: true, cf: 'operating' },
  { code: '2410', name: 'Operating lease liability', cls: 'liability', onto: 'tie:LeaseLiability', fs: 'BS.NCL.LEASE', monetary: true, cf: 'operating' },
  { code: '2500', name: 'Payroll liabilities', cls: 'liability', onto: 'tie:PayrollLiabilities', fs: 'BS.CL.ACCRUED', monetary: true, cf: 'operating' },
  { code: '2600', name: 'VAT payable', cls: 'liability', onto: 'tie:TaxesPayable', fs: 'BS.CL.ACCRUED', monetary: true, cf: 'operating' },
  { code: '3000', name: 'Common stock', cls: 'equity', onto: 'tie:ContributedCapital', fs: 'BS.EQ.CAPITAL', cf: 'financing' },
  { code: '3100', name: 'Additional paid-in capital', cls: 'equity', onto: 'tie:ContributedCapital', fs: 'BS.EQ.CAPITAL', cf: 'financing' },
  { code: '3200', name: 'Retained earnings', cls: 'equity', onto: 'tie:RetainedEarnings', fs: 'BS.EQ.RE' },
  { code: '3300', name: 'Cumulative translation adjustment', cls: 'equity', onto: 'tie:CumulativeTranslationAdjustment', fs: 'BS.EQ.AOCI' },
  { code: '4000', name: 'Subscription revenue', cls: 'revenue', onto: 'tie:SubscriptionRevenue', fs: 'IS.REV.SUB' },
  { code: '4100', name: 'Hardware revenue', cls: 'revenue', onto: 'tie:ProductRevenue', fs: 'IS.REV.HW' },
  { code: '4200', name: 'Professional services revenue', cls: 'revenue', onto: 'tie:ServiceRevenue', fs: 'IS.REV.SVC' },
  { code: '4900', name: 'Intercompany R&D services revenue', cls: 'revenue', onto: 'tie:IntercompanyRevenue', fs: 'IS.REV.IC', ic: true },
  { code: '5000', name: 'Hosting – production', cls: 'expense', onto: 'tie:HostingCost', fs: 'IS.COR' },
  { code: '5100', name: 'Hardware cost of goods sold', cls: 'expense', onto: 'tie:HardwareCost', fs: 'IS.COR' },
  { code: '6000', name: 'Salaries and wages', cls: 'expense', onto: 'tie:CompensationExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6010', name: 'Payroll taxes', cls: 'expense', onto: 'tie:CompensationExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6020', name: 'Employee benefits', cls: 'expense', onto: 'tie:CompensationExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6100', name: 'Rent and occupancy', cls: 'expense', onto: 'tie:RentExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6150', name: 'Software subscriptions', cls: 'expense', onto: 'tie:SoftwareExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6300', name: 'Advertising', cls: 'expense', onto: 'tie:MarketingExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6310', name: 'Events and conferences', cls: 'expense', onto: 'tie:EventsExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6400', name: 'Travel', cls: 'expense', onto: 'tie:TravelExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6410', name: 'Meals and entertainment', cls: 'expense', onto: 'tie:MealsExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6500', name: 'Legal fees', cls: 'expense', onto: 'tie:LegalFees', fs: 'IS.OPEX.GA', dims: D },
  { code: '6510', name: 'Audit and tax fees', cls: 'expense', onto: 'tie:AuditTaxFees', fs: 'IS.OPEX.GA', dims: D },
  { code: '6600', name: 'Office supplies', cls: 'expense', onto: 'tie:OfficeExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6650', name: 'Telecom and internet', cls: 'expense', onto: 'tie:TelecomExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6700', name: 'Insurance', cls: 'expense', onto: 'tie:InsuranceExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6800', name: 'Depreciation', cls: 'expense', onto: 'tie:DepreciationExpense', fs: 'IS.OPEX.GA', dims: D },
  { code: '6900', name: 'Bank fees', cls: 'expense', onto: 'tie:BankFees', fs: 'IS.OPEX.GA', dims: D },
  { code: '6950', name: 'Intercompany R&D services', cls: 'expense', onto: 'tie:IntercompanyExpense', fs: 'IS.OPEX.GA', dims: D, ic: true },
  { code: '7000', name: 'Interest income', cls: 'revenue', onto: 'tie:InterestIncome', fs: 'IS.OTHER' },
  { code: '7100', name: 'Realized FX gain (loss)', cls: 'revenue', onto: 'tie:FxGain', fs: 'IS.OTHER' },
  { code: '7110', name: 'Unrealized FX gain (loss)', cls: 'revenue', onto: 'tie:FxGain', fs: 'IS.OTHER' },
  { code: '7120', name: 'Intercompany FX difference (consolidation)', cls: 'revenue', onto: 'tie:FxGain', fs: 'IS.OTHER', ic: true },
  { code: '8000', name: 'Income tax expense', cls: 'expense', onto: 'tie:IncomeTaxExpense', fs: 'IS.TAX' },
];

export const DIMENSIONS: { key: DimensionKey; name: string; values: [string, string][] }[] = [
  { key: 'department', name: 'Department', values: [['RND', 'Research & development'], ['SALES', 'Sales'], ['MKTG', 'Marketing'], ['GA', 'General & administrative'], ['OPS', 'Operations'], ['CS', 'Customer success']] },
  { key: 'location', name: 'Location', values: [['US-SF', 'San Francisco'], ['US-NYC', 'New York'], ['UK-LDN', 'London']] },
  { key: 'product_class', name: 'Product line', values: [['PLATFORM', 'Analytics platform'], ['HARDWARE', 'Sensor hardware'], ['SERVICES', 'Professional services']] },
  { key: 'project', name: 'Project', values: [['PRJ-PIPELINE', 'Data pipeline migration'], ['PRJ-GEN3', 'Gen-3 sensor'], ['PRJ-SOC2', 'SOC 2 readiness']] },
];

export interface EntityDef {
  code: string;
  name: string;
  kind: 'legal' | 'elimination';
  country: string;
  currency: 'USD' | 'GBP';
  calendar: 'US' | 'UK';
  parent?: string;
  location: string;
  materiality: MaterialitySettings;
}

export const ENTITIES: EntityDef[] = [
  {
    code: 'BWL-US', name: 'Bramblewood Labs, Inc.', kind: 'legal', country: 'US', currency: 'USD', calendar: 'US', location: 'US-SF',
    materiality: { basis: 'revenue', basisAmountMinor: 3_100_000_000, basisPct: 0.005, overallMinor: 15_000_000, performanceMinor: 9_000_000, clearlyTrivialMinor: 750_000, fluxAbsMinor: 2_500_000, fluxPct: 0.1, rationale: '0.5% of trailing-twelve-month revenue (~$31M), rounded down to $150,000; performance materiality at 60%; clearly trivial at 5% of overall.' },
  },
  {
    code: 'BWL-UK', name: 'Bramblewood Labs Ltd', kind: 'legal', country: 'GB', currency: 'GBP', calendar: 'UK', parent: 'BWL-US', location: 'UK-LDN',
    materiality: { basis: 'revenue', basisAmountMinor: 800_000_000, basisPct: 0.005, overallMinor: 4_000_000, performanceMinor: 2_400_000, clearlyTrivialMinor: 200_000, fluxAbsMinor: 1_000_000, fluxPct: 0.1, rationale: '0.5% of revenue including intercompany services (~£8M); PM 60%; clearly trivial 5%.' },
  },
  {
    code: 'BWL-ELIM', name: 'Bramblewood consolidation & eliminations', kind: 'elimination', country: 'US', currency: 'USD', calendar: 'US', parent: 'BWL-US', location: 'US-SF',
    materiality: { basis: 'revenue', basisAmountMinor: 3_100_000_000, basisPct: 0.005, overallMinor: 15_000_000, performanceMinor: 9_000_000, clearlyTrivialMinor: 750_000, fluxAbsMinor: 2_500_000, fluxPct: 0.1, rationale: 'Group materiality.' },
  },
];

export interface PersonDef {
  key: string;
  name: string;
  email: string;
  title: string;
  roles: string[];
  /** what this person does in the demo close, shown on their sign-in card */
  part: string;
}

export const PEOPLE: PersonDef[] = [
  { key: 'sam', name: 'Sam Rivera', email: 'sam@bramblewood.example', title: 'Staff Accountant', roles: ['staff_accountant'], part: 'Certifies reconciliations and explains variances.' },
  { key: 'priya', name: 'Priya Natarajan', email: 'priya@bramblewood.example', title: 'AP Specialist', roles: ['ap_specialist'], part: 'Owns vendor bills and the AP subledger.' },
  { key: 'jordan', name: 'Jordan Lee', email: 'jordan@bramblewood.example', title: 'Senior Accountant', roles: ['senior_accountant'], part: 'Start here: runs the close agents.' },
  { key: 'casey', name: 'Casey Morgan', email: 'casey@bramblewood.example', title: 'Controller', roles: ['controller'], part: 'Approves agent work and signs off the checklist.' },
  { key: 'riley', name: 'Riley Chen', email: 'riley@bramblewood.example', title: 'CFO', roles: ['cfo'], part: 'Approves the large items, signs the package, locks the month.' },
  { key: 'devon', name: 'Devon Park', email: 'devon@bramblewood.example', title: 'FP&A Analyst', roles: ['fpa_analyst'], part: 'Explains variances against budget.' },
  { key: 'alex', name: 'Alex Quinn', email: 'alex@brightline-audit.example', title: 'External Auditor, Brightline Audit Partners', roles: ['auditor'], part: 'Read-only: checks the audit trail.' },
  { key: 'avery', name: 'Avery Stone', email: 'avery@bramblewood.example', title: 'IT Administrator', roles: ['admin'], part: 'Invites people and manages access; approves nothing.' },
];

export interface VendorDef {
  code: string;
  name: string;
  entity: 'BWL-US' | 'BWL-UK';
  category: string;
  account: string;
  dept: string | null;
  terms: number;
  /** monthly base amount in minor units (functional currency) for recurring vendors */
  monthly?: number;
  /** bill timing: 'start' = billed on the 1st for the month; 'end' = billed for the month, GL-dated month end */
  timing?: 'start' | 'end';
  method?: 'ach' | 'wire' | 'check';
  cardMerchant?: boolean;
}

export const VENDORS: VendorDef[] = [
  { code: 'V-CUMULUS', name: 'Cumulus Hosting Co.', entity: 'BWL-US', category: 'Cloud hosting', account: '5000', dept: null, terms: 30, monthly: 3_350_000, timing: 'end', method: 'ach' },
  { code: 'V-ATLAS', name: 'Atlas & Pike LLP', entity: 'BWL-US', category: 'Legal', account: '6500', dept: 'GA', terms: 30, monthly: 1_360_000, timing: 'end', method: 'ach' },
  { code: 'V-HARBOR', name: 'Harborview Properties', entity: 'BWL-US', category: 'Rent', account: '6100', dept: 'GA', terms: 0, monthly: 1_840_000, timing: 'start', method: 'ach' },
  { code: 'V-REDWOOD', name: 'Redwood Fiber Telecom', entity: 'BWL-US', category: 'Telecom', account: '6650', dept: 'GA', terms: 20, monthly: 238_000, timing: 'start', method: 'ach' },
  { code: 'V-GRIDLOCK', name: 'Gridlock Security', entity: 'BWL-US', category: 'Software', account: '6150', dept: 'RND', terms: 30, monthly: 310_000, timing: 'start', method: 'ach' },
  { code: 'V-SUNDIAL', name: 'Sundial Analytics', entity: 'BWL-US', category: 'Data & software', account: '6150', dept: 'RND', terms: 30, monthly: 580_000, timing: 'start', method: 'ach' },
  { code: 'V-ORBITRON', name: 'Orbitron Ads', entity: 'BWL-US', category: 'Advertising', account: '6300', dept: 'MKTG', terms: 30, monthly: 2_600_000, timing: 'end', method: 'ach' },
  { code: 'V-BRIGHTLINE', name: 'Brightline Audit Partners', entity: 'BWL-US', category: 'Audit & tax', account: '6510', dept: 'GA', terms: 30, method: 'ach' },
  { code: 'V-TESSELLATE', name: 'Tessellate CRM', entity: 'BWL-US', category: 'Software (annual)', account: '6150', dept: 'SALES', terms: 30, method: 'ach' },
  { code: 'V-FIELDSTONE', name: 'Fieldstone Mutual Insurance', entity: 'BWL-US', category: 'Insurance (annual)', account: '6700', dept: 'GA', terms: 30, method: 'ach' },
  { code: 'V-QUANTA', name: 'Quanta Components', entity: 'BWL-US', category: 'Inventory components', account: '1300', dept: null, terms: 45, method: 'wire' },
  { code: 'V-QINSTR', name: 'Quanta Instruments', entity: 'BWL-US', category: 'Lab instruments', account: '1520', dept: 'RND', terms: 30, method: 'wire' },
  { code: 'V-CONFAB', name: 'ConfabCon Events', entity: 'BWL-US', category: 'Events', account: '6310', dept: 'MKTG', terms: 15, method: 'wire' },
  { code: 'V-ATRIUM', name: 'Atrium Event Spaces', entity: 'BWL-US', category: 'Events', account: '6310', dept: 'MKTG', terms: 15, method: 'ach' },
  { code: 'V-VERDANT', name: 'Verdant Office Supply', entity: 'BWL-US', category: 'Office supplies', account: '6600', dept: 'GA', terms: 15, method: 'check' },
  { code: 'V-PEBBLE', name: 'Pebble Payroll Services', entity: 'BWL-US', category: 'Payroll provider', account: '6000', dept: 'GA', terms: 0, method: 'ach' },
  { code: 'V-UK-THAMES', name: 'Thameside Offices Ltd', entity: 'BWL-UK', category: 'Rent', account: '6100', dept: 'GA', terms: 0, monthly: 950_000, timing: 'start', method: 'ach' },
  { code: 'V-UK-NIMBUS', name: 'Nimbus Cloud UK', entity: 'BWL-UK', category: 'Cloud hosting', account: '5000', dept: null, terms: 30, monthly: 880_000, timing: 'end', method: 'ach' },
  { code: 'V-UK-PEMBERTON', name: 'Pemberton & Hale Solicitors', entity: 'BWL-UK', category: 'Legal', account: '6500', dept: 'GA', terms: 30, monthly: 260_000, timing: 'end', method: 'ach' },
  { code: 'V-UK-KINGFISHER', name: 'Kingfisher Office Supplies', entity: 'BWL-UK', category: 'Office supplies', account: '6600', dept: 'GA', terms: 30, monthly: 52_000, timing: 'end', method: 'ach' },
];

export const CUSTOMERS_US = [
  'Aldergrove Utilities', 'Pinecone Water District', 'Riverside AgriCo', 'Saltmarsh Ports Authority', 'Tundra Freight Lines', 'Meadowlark Farms Cooperative',
  'Granite Peak Mining', 'Bluewater Fisheries', 'Cedar Valley Irrigation', 'Harbor Point Logistics', 'Sierra Watershed Council', 'Prairie Wind Energy',
  'Coastal Reclamation Co.', 'Northgate Rail', 'Ironwood Construction', 'Larkspur Vineyards', 'Silver Creek Hydro', 'Juniper Basin Ranch',
  'Oakhaven Municipal Water', 'Redstone Quarry', 'Willow Bend Utilities', 'Falcon Ridge Airport Authority', 'Maple Hollow Dairy', 'Sunstone Solar Farms',
  'Kestrel Bay Marina', 'Elk Grove Parks Department', 'Copper Canyon Mines', 'Brightwater Aquaculture', 'Fernwood Forestry', 'Stonebridge Utilities District',
  'Glacier Lake Authority', 'Mesa Verde Growers', 'Thistle Creek Water', 'Driftwood Harbor Co.', 'Bramble Ridge Orchards', 'Clearview Reservoirs',
];

export const CUSTOMERS_UK = [
  'Thamesmead Water Trust', 'Pennine Reservoirs Ltd', 'Cotswold Agritech', 'Solent Harbour Board', 'Fenland Drainage Board', 'Highland Hydro Co-op',
  'Mersey Estuary Trust', 'Dartmoor Moorland Rangers', 'Severn Valley Growers', 'Lakeland Utilities', 'Humber Ports Ltd', 'Chiltern Aquifer Partners',
];

export const CARDHOLDERS = [
  { entity: 'BWL-US', name: 'Sam Rivera', last4: '1182', dept: 'GA' },
  { entity: 'BWL-US', name: 'Marcus Bell', last4: '2290', dept: 'SALES' },
  { entity: 'BWL-US', name: 'Lena Ortiz', last4: '3317', dept: 'MKTG' },
  { entity: 'BWL-US', name: 'Tobias Grant', last4: '4471', dept: 'RND' },
  { entity: 'BWL-US', name: 'Hana Kim', last4: '5526', dept: 'OPS' },
  { entity: 'BWL-US', name: 'Priya Natarajan', last4: '6643', dept: 'GA' },
  { entity: 'BWL-UK', name: 'Oliver Wright', last4: '7754', dept: 'RND' },
  { entity: 'BWL-UK', name: 'Amara Okafor', last4: '8869', dept: 'SALES' },
] as const;

export interface MerchantDef {
  name: string;
  mcc: string;
  account: string;
  min: number;
  max: number;
  weight: number;
  entity: 'BWL-US' | 'BWL-UK';
}

export const MERCHANTS: MerchantDef[] = [
  { name: 'Skylark Air', mcc: '4511', account: '6400', min: 28_000, max: 98_000, weight: 6, entity: 'BWL-US' },
  { name: 'Harborline Hotels', mcc: '7011', account: '6400', min: 18_000, max: 72_000, weight: 6, entity: 'BWL-US' },
  { name: 'Metro Rideshare', mcc: '4121', account: '6400', min: 1_400, max: 7_800, weight: 10, entity: 'BWL-US' },
  { name: 'Northstar Rail', mcc: '4112', account: '6400', min: 4_500, max: 21_000, weight: 3, entity: 'BWL-US' },
  { name: 'Kettle & Crane Coffee', mcc: '5814', account: '6410', min: 900, max: 6_400, weight: 10, entity: 'BWL-US' },
  { name: 'Bistro Nine', mcc: '5812', account: '6410', min: 6_000, max: 48_000, weight: 6, entity: 'BWL-US' },
  { name: 'Verdant Office Supply', mcc: '5943', account: '6600', min: 2_200, max: 31_000, weight: 5, entity: 'BWL-US' },
  { name: 'Paperline Printing', mcc: '5111', account: '6600', min: 4_000, max: 26_000, weight: 2, entity: 'BWL-US' },
  { name: 'Pixelforge Design Tools', mcc: '5734', account: '6150', min: 1_900, max: 9_900, weight: 4, entity: 'BWL-US' },
  { name: 'Tessera Cloud Storage', mcc: '4816', account: '5000', min: 9_000, max: 45_000, weight: 3, entity: 'BWL-US' },
  { name: 'Orbitron Ads', mcc: '7311', account: '6300', min: 25_000, max: 180_000, weight: 3, entity: 'BWL-US' },
  { name: 'Atrium Event Spaces', mcc: '7399', account: '6310', min: 15_000, max: 95_000, weight: 2, entity: 'BWL-US' },
  { name: 'Rail Albion', mcc: '4112', account: '6400', min: 3_500, max: 18_000, weight: 5, entity: 'BWL-UK' },
  { name: 'Kings Cross Hotel', mcc: '7011', account: '6400', min: 12_000, max: 46_000, weight: 3, entity: 'BWL-UK' },
  { name: 'Teapot & Co', mcc: '5814', account: '6410', min: 800, max: 4_500, weight: 6, entity: 'BWL-UK' },
  { name: 'Office Lark', mcc: '5943', account: '6600', min: 1_500, max: 12_000, weight: 3, entity: 'BWL-UK' },
];

export interface TemplateTaskDef {
  key: string;
  title: string;
  description: string;
  category: string;
  wd: number;
  owner: string;
  reviewer: string | null;
  skill: string | null;
  scope: 'each_legal' | 'parent' | 'group';
  deps: string[];
  evidence?: boolean;
}

export const CLOSE_TEMPLATE: TemplateTaskDef[] = [
  { key: 'cutoff-reminder', title: 'Send cut-off reminder to budget owners', description: 'Remind department heads to submit receipts and approve open POs before month-end.', category: 'Preparation', wd: -2, owner: 'controller', reviewer: null, skill: null, scope: 'group', deps: [] },
  { key: 'po-review', title: 'Review open POs and receipts', description: 'Confirm goods received against purchase orders so received-not-invoiced items can be accrued.', category: 'Preparation', wd: -1, owner: 'ap_specialist', reviewer: null, skill: null, scope: 'parent', deps: [] },
  { key: 'import-feeds', title: 'Import bank and card statements', description: 'Load bank statements (BAI2 / camt.053) and the card feed through the connectors.', category: 'Data', wd: 1, owner: 'staff_accountant', reviewer: null, skill: null, scope: 'group', deps: [], evidence: true },
  { key: 'code-transactions', title: 'Code card transactions and bills', description: 'Classify every card charge and bill line to an account and department; fix misclassifications.', category: 'Transactions', wd: 1, owner: 'staff_accountant', reviewer: 'senior_accountant', skill: 'transaction-coding', scope: 'group', deps: ['import-feeds'] },
  { key: 'schedules', title: 'Roll forward prepaid and depreciation schedules', description: 'Post monthly amortization and depreciation; catch missed schedule lines.', category: 'Schedules', wd: 2, owner: 'staff_accountant', reviewer: 'senior_accountant', skill: 'schedule-rollforward', scope: 'group', deps: [] },
  { key: 'bank-rec', title: 'Reconcile bank accounts', description: 'Match bank lines to the ledger, classify timing differences and certify the reconciliation.', category: 'Reconciliation', wd: 2, owner: 'staff_accountant', reviewer: 'controller', skill: 'bank-reconciliation', scope: 'group', deps: ['import-feeds'], evidence: true },
  { key: 'subledger-tieout', title: 'Tie out AP and AR subledgers', description: 'Agree the AP and AR agings to their control accounts and investigate differences.', category: 'Reconciliation', wd: 2, owner: 'ap_specialist', reviewer: 'senior_accountant', skill: 'subledger-tieout', scope: 'group', deps: ['code-transactions'] },
  { key: 'accruals', title: 'Accrue unrecorded liabilities', description: 'Accrue goods received not invoiced, recurring vendors without a bill, post-period invoices and payroll.', category: 'Accruals', wd: 2, owner: 'staff_accountant', reviewer: 'controller', skill: 'accrual-detection', scope: 'group', deps: ['po-review', 'code-transactions'] },
  { key: 'fx-reval', title: 'Revalue foreign-currency balances', description: 'Remeasure foreign-currency monetary items at the closing rate before intercompany eliminations.', category: 'Consolidation', wd: 3, owner: 'senior_accountant', reviewer: 'controller', skill: 'fx-revaluation', scope: 'group', deps: ['import-feeds'] },
  { key: 'intercompany', title: 'Match intercompany and draft eliminations', description: 'Agree intercompany balances across entities, fix mismatches and draft elimination entries.', category: 'Consolidation', wd: 3, owner: 'senior_accountant', reviewer: 'controller', skill: 'intercompany-matching', scope: 'group', deps: ['accruals', 'fx-reval'] },
  { key: 'je-review', title: 'Review journal entries for risk', description: 'Scan every entry in the period for duplicates, round amounts, weekend postings, SoD breaks and Benford anomalies.', category: 'Review', wd: 3, owner: 'controller', reviewer: 'cfo', skill: 'je-review', scope: 'group', deps: ['code-transactions'] },
  { key: 'flux', title: 'Explain variances (flux)', description: 'Compare to last month and budget, quantify drivers and explain every significant variance.', category: 'Analysis', wd: 3, owner: 'fpa_analyst', reviewer: 'controller', skill: 'flux-analysis', scope: 'group', deps: ['accruals', 'schedules', 'bank-rec'] },
  { key: 'close-package', title: 'Generate the close package', description: 'Produce trial balances, statements, commentary and reconciliation status for sign-off.', category: 'Reporting', wd: 4, owner: 'controller', reviewer: 'cfo', skill: 'close-package', scope: 'group', deps: ['flux', 'je-review', 'intercompany', 'subledger-tieout'] },
  { key: 'lock', title: 'Lock the period', description: 'Hard-close September once the package is signed off.', category: 'Reporting', wd: 5, owner: 'controller', reviewer: null, skill: null, scope: 'group', deps: ['close-package'] },
];

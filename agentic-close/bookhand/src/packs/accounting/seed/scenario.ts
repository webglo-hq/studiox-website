/**
 * The demo scenario: Brambleway Software (a FICTIONAL company). A US parent (USD) and a UK subsidiary (GBP),
 * 13 months of history (Sep 2025 - Aug 2026, closed and locked) and an open month to close (Sep 2026)
 * with planted issues for the agents to find. Every name, number and person here is invented.
 */

export const SCENARIO = {
  seed: 'brambleway-2026-09',
  tenantName: 'Brambleway Software (fictional)',
  tenantSlug: 'brambleway',
  reportingCurrency: 'USD',
  firstPeriod: { year: 2025, month: 9 },
  openPeriod: { year: 2026, month: 9 },
  /** WD2 of the September close. */
  businessDate: '2026-10-02',
  emailDomain: 'brambleway.example',
} as const;

export const ENTITIES = [
  { code: 'BW-US', name: 'Brambleway US', legalName: 'Brambleway Software, Inc. (fictional)', currency: 'USD', country: 'US', parent: null, kind: 'operating' as const },
  { code: 'BW-UK', name: 'Brambleway UK', legalName: 'Brambleway Software Ltd. (fictional)', currency: 'GBP', country: 'GB', parent: 'BW-US', kind: 'operating' as const },
  { code: 'BW-ELIM', name: 'Eliminations', legalName: 'Consolidation eliminations (book-only)', currency: 'USD', country: 'US', parent: 'BW-US', kind: 'elimination' as const },
];

export const PEOPLE = [
  { key: 'maya', name: 'Maya Chen', title: 'Staff Accountant', role: 'staff_accountant', hue: 200 },
  { key: 'diego', name: 'Diego Alvarez', title: 'AP Clerk', role: 'ap_clerk', hue: 28 },
  { key: 'priya', name: 'Priya Natarajan', title: 'FP&A Analyst', role: 'fpa_analyst', hue: 280 },
  { key: 'daniel', name: 'Daniel Okafor', title: 'Senior Accountant', role: 'senior_accountant', hue: 150 },
  { key: 'hannah', name: 'Hannah Weiss', title: 'Controller', role: 'controller', hue: 340 },
  { key: 'marcus', name: 'Marcus Bell', title: 'CFO', role: 'cfo', hue: 45 },
  { key: 'sofia', name: 'Sofia Lindqvist', title: 'External Auditor, Kestrel & Lane LLP (fictional)', role: 'auditor', hue: 100 },
  { key: 'tom', name: 'Tom Ridley', title: 'IT Administrator', role: 'admin', hue: 230 },
] as const;

export type PersonKey = (typeof PEOPLE)[number]['key'];

export const DEPARTMENTS = [
  { code: 'ENG', name: 'Engineering' },
  { code: 'PRD', name: 'Product & Design' },
  { code: 'SALES', name: 'Sales' },
  { code: 'MKT', name: 'Marketing' },
  { code: 'CS', name: 'Customer Success' },
  { code: 'GA', name: 'General & Administrative' },
];

export const LOCATIONS = [
  { code: 'NYC', name: 'New York' },
  { code: 'LON', name: 'London' },
];

export const CLASSES = [
  { code: 'PLATFORM', name: 'Platform subscriptions' },
  { code: 'SERVICES', name: 'Professional services' },
];

export const PROJECTS = [{ code: 'ATLAS', name: 'Project Atlas (data platform)' }];

export interface AccountDef {
  number: string;
  name: string;
  subtype: string;
  cls: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normal: 'debit' | 'credit';
  fsLine: string;
  xbrl?: string;
  reconcilable?: boolean;
  control?: boolean;
  ic?: boolean;
  monetary?: boolean;
  dept?: boolean;
  header?: boolean;
  parent?: string;
}

const A = (number: string, name: string, subtype: string, cls: AccountDef['cls'], normal: AccountDef['normal'], fsLine: string, extra: Partial<AccountDef> = {}): AccountDef => ({
  number,
  name,
  subtype,
  cls,
  normal,
  fsLine,
  ...extra,
});

export const CHART_OF_ACCOUNTS: AccountDef[] = [
  A('1000', 'Cash - Operating (First Harbor Bank)', 'bh:Cash', 'asset', 'debit', 'BS.CA.CASH', { reconcilable: true, monetary: true }),
  A('1010', 'Cash - Payroll (First Harbor Bank)', 'bh:Cash', 'asset', 'debit', 'BS.CA.CASH', { reconcilable: true, monetary: true }),
  A('1020', 'Cash - Operating GBP (Thamesgate Bank)', 'bh:Cash', 'asset', 'debit', 'BS.CA.CASH', { reconcilable: true, monetary: true }),
  A('1100', 'Accounts receivable', 'bh:AccountsReceivable', 'asset', 'debit', 'BS.CA.AR', { reconcilable: true, control: true, monetary: true }),
  A('1150', 'Allowance for credit losses', 'bh:AllowanceForCreditLosses', 'asset', 'credit', 'BS.CA.AR', { monetary: true }),
  A('1200', 'Prepaid expenses - other', 'bh:PrepaidExpense', 'asset', 'debit', 'BS.CA.PREPAID', { reconcilable: true }),
  A('1210', 'Prepaid software', 'bh:PrepaidSoftware', 'asset', 'debit', 'BS.CA.PREPAID', { reconcilable: true }),
  A('1220', 'Prepaid insurance', 'bh:PrepaidInsurance', 'asset', 'debit', 'BS.CA.PREPAID', { reconcilable: true }),
  A('1250', 'Vendor refunds receivable', 'bh:OtherReceivable', 'asset', 'debit', 'BS.CA.OTHER', { reconcilable: true, monetary: true }),
  A('1300', 'Due from Brambleway UK', 'bh:IntercompanyReceivable', 'asset', 'debit', 'BS.CA.IC', { reconcilable: true, ic: true, monetary: true }),
  A('1500', 'Computer equipment', 'bh:ComputerEquipment', 'asset', 'debit', 'BS.NCA.PPE', { reconcilable: true }),
  A('1510', 'Furniture and fixtures', 'bh:FurnitureAndFixtures', 'asset', 'debit', 'BS.NCA.PPE', { reconcilable: true }),
  A('1520', 'Leasehold improvements', 'bh:LeaseholdImprovements', 'asset', 'debit', 'BS.NCA.PPE', { reconcilable: true }),
  A('1590', 'Accumulated depreciation', 'bh:AccumulatedDepreciation', 'asset', 'credit', 'BS.NCA.PPE', { reconcilable: true }),
  A('1700', 'Security deposits', 'bh:Deposits', 'asset', 'debit', 'BS.NCA.OTHER'),
  A('2000', 'Accounts payable', 'bh:AccountsPayable', 'liability', 'credit', 'BS.CL.AP', { reconcilable: true, control: true, monetary: true }),
  A('2100', 'Accrued liabilities', 'bh:AccruedLiabilities', 'liability', 'credit', 'BS.CL.ACCRUED', { reconcilable: true, monetary: true }),
  A('2110', 'Accrued payroll', 'bh:AccruedPayroll', 'liability', 'credit', 'BS.CL.ACCRUED', { monetary: true }),
  A('2150', 'Payroll liabilities', 'bh:PayrollLiabilities', 'liability', 'credit', 'BS.CL.ACCRUED', { reconcilable: true, monetary: true }),
  A('2200', 'Corporate card payable (Cardline)', 'bh:CreditCardPayable', 'liability', 'credit', 'BS.CL.CARDS', { reconcilable: true, monetary: true }),
  A('2300', 'Deferred revenue', 'bh:DeferredRevenue', 'liability', 'credit', 'BS.CL.DEFREV', { reconcilable: true }),
  A('2400', 'Due to Brambleway US', 'bh:IntercompanyPayable', 'liability', 'credit', 'BS.CL.IC', { reconcilable: true, ic: true, monetary: true }),
  A('3000', 'Common stock', 'bh:CommonStock', 'equity', 'credit', 'BS.EQ.CAPITAL'),
  A('3100', 'Additional paid-in capital', 'bh:AdditionalPaidInCapital', 'equity', 'credit', 'BS.EQ.CAPITAL'),
  A('3200', 'Retained earnings', 'bh:RetainedEarnings', 'equity', 'credit', 'BS.EQ.RE'),
  A('3300', 'Cumulative translation adjustment', 'bh:CumulativeTranslationAdjustment', 'equity', 'credit', 'BS.EQ.AOCI'),
  A('4000', 'Subscription revenue', 'bh:SubscriptionRevenue', 'revenue', 'credit', 'IS.REV.SUBSCRIPTION'),
  A('4100', 'Professional services revenue', 'bh:ServicesRevenue', 'revenue', 'credit', 'IS.REV.SERVICES'),
  A('4900', 'Intercompany management fee income', 'bh:IntercompanyRevenue', 'revenue', 'credit', 'IS.IC', { ic: true }),
  A('5000', 'Cloud hosting', 'bh:HostingCost', 'expense', 'debit', 'IS.COGS', { dept: true }),
  A('5100', 'Payment processing fees', 'bh:MerchantFees', 'expense', 'debit', 'IS.COGS'),
  A('6000', 'Salaries and wages', 'bh:SalariesAndWages', 'expense', 'debit', 'IS.OPEX.PAYROLL', { dept: true }),
  A('6010', 'Payroll taxes', 'bh:PayrollTaxExpense', 'expense', 'debit', 'IS.OPEX.PAYROLL', { dept: true }),
  A('6020', 'Employee benefits', 'bh:EmployeeBenefits', 'expense', 'debit', 'IS.OPEX.PAYROLL', { dept: true }),
  A('6100', 'Rent and facilities', 'bh:RentExpense', 'expense', 'debit', 'IS.OPEX.FACILITIES', { dept: true }),
  A('6110', 'Internet and telecom', 'bh:Utilities', 'expense', 'debit', 'IS.OPEX.FACILITIES', { dept: true }),
  A('6200', 'Travel', 'bh:TravelExpense', 'expense', 'debit', 'IS.OPEX.TE', { dept: true }),
  A('6210', 'Meals and entertainment', 'bh:MealsEntertainment', 'expense', 'debit', 'IS.OPEX.TE', { dept: true }),
  A('6300', 'Advertising', 'bh:AdvertisingExpense', 'expense', 'debit', 'IS.OPEX.MARKETING', { dept: true }),
  A('6310', 'Events and conferences', 'bh:EventsConferences', 'expense', 'debit', 'IS.OPEX.MARKETING', { dept: true }),
  A('6420', 'Software subscriptions', 'bh:SoftwareExpense', 'expense', 'debit', 'IS.OPEX.SOFTWARE', { dept: true }),
  A('6510', 'Legal fees', 'bh:LegalFees', 'expense', 'debit', 'IS.OPEX.PROF', { dept: true }),
  A('6520', 'Accounting and audit fees', 'bh:AuditFees', 'expense', 'debit', 'IS.OPEX.PROF', { dept: true }),
  A('6530', 'Consulting and contractors', 'bh:ConsultingFees', 'expense', 'debit', 'IS.OPEX.PROF', { dept: true }),
  A('6600', 'Office supplies', 'bh:OfficeSupplies', 'expense', 'debit', 'IS.OPEX.OTHER', { dept: true }),
  A('6610', 'Small equipment', 'bh:SmallEquipment', 'expense', 'debit', 'IS.OPEX.OTHER', { dept: true }),
  A('6700', 'Insurance', 'bh:InsuranceExpense', 'expense', 'debit', 'IS.OPEX.OTHER', { dept: true }),
  A('6710', 'Bank and wire fees', 'bh:BankFees', 'expense', 'debit', 'IS.OPEX.OTHER'),
  A('6800', 'Depreciation', 'bh:DepreciationExpense', 'expense', 'debit', 'IS.OPEX.DA', { dept: true }),
  A('6900', 'Recruiting', 'bh:RecruitingExpense', 'expense', 'debit', 'IS.OPEX.OTHER', { dept: true }),
  A('6910', 'Training and education', 'bh:TrainingExpense', 'expense', 'debit', 'IS.OPEX.OTHER', { dept: true }),
  A('6920', 'Postage and shipping', 'bh:ShippingExpense', 'expense', 'debit', 'IS.OPEX.OTHER', { dept: true }),
  A('6950', 'Intercompany management fee expense', 'bh:IntercompanyExpense', 'expense', 'debit', 'IS.IC', { ic: true }),
  A('7000', 'Interest income', 'bh:InterestIncome', 'revenue', 'credit', 'IS.OTHER'),
  A('7100', 'Foreign exchange (gain) loss', 'bh:ForeignExchangeGainLoss', 'expense', 'debit', 'IS.OTHER'),
];

export interface VendorDef {
  code: string;
  name: string;
  category: string;
  entity: 'BW-US' | 'BW-UK';
  account: string;
  dept: string;
  terms: number;
  /** Monthly recurring bill amount (minor units); 0 = not recurring. */
  monthly?: number;
  jitter?: number;
}

export const VENDORS: VendorDef[] = [
  { code: 'V-NIMBUS', name: 'Nimbus Cloud Services', category: 'cloud_hosting', entity: 'BW-US', account: '5000', dept: 'ENG', terms: 30, monthly: 3_050_000, jitter: 0.04 },
  { code: 'V-HUDSON', name: 'Hudson Yards Realty (fictional)', category: 'facilities', entity: 'BW-US', account: '6100', dept: 'GA', terms: 15, monthly: 3_800_000 },
  { code: 'V-QUAYSIDE', name: 'Quayside Telecom', category: 'telecom', entity: 'BW-US', account: '6110', dept: 'GA', terms: 30, monthly: 241_500, jitter: 0.02 },
  { code: 'V-SIGNAL', name: 'Signal & Sail Media', category: 'advertising', entity: 'BW-US', account: '6300', dept: 'MKT', terms: 30, monthly: 6_200_000, jitter: 0.12 },
  { code: 'V-COPPER', name: 'Copperline Legal LLP', category: 'legal', entity: 'BW-US', account: '6510', dept: 'GA', terms: 30 },
  { code: 'V-KESTREL', name: 'Kestrel & Lane LLP', category: 'accounting', entity: 'BW-US', account: '6520', dept: 'GA', terms: 30 },
  { code: 'V-FIELDNOTE', name: 'Fieldnote Research', category: 'consulting', entity: 'BW-US', account: '6530', dept: 'PRD', terms: 30 },
  { code: 'V-BRIGHTLINE', name: 'Brightline Facilities', category: 'facilities', entity: 'BW-US', account: '6100', dept: 'GA', terms: 30 },
  { code: 'V-PENROSE', name: 'Penrose Design Suite', category: 'saas', entity: 'BW-US', account: '6420', dept: 'PRD', terms: 30 },
  { code: 'V-IRONCLAD', name: 'Ironclad Mutual Insurance', category: 'insurance', entity: 'BW-US', account: '6700', dept: 'GA', terms: 30 },
  { code: 'V-SAASTR', name: 'SaaStr Annual (booth)', category: 'events', entity: 'BW-US', account: '6310', dept: 'MKT', terms: 15 },
  { code: 'V-PRINTWELL', name: 'Printwell Studio', category: 'events', entity: 'BW-US', account: '6310', dept: 'MKT', terms: 30 },
  { code: 'V-TALENT', name: 'Talentbridge Recruiting', category: 'recruiting', entity: 'BW-US', account: '6900', dept: 'GA', terms: 30 },
  { code: 'V-OAKCREST', name: 'Oakcrest Contractors', category: 'consulting', entity: 'BW-US', account: '6530', dept: 'ENG', terms: 30, monthly: 1_450_000, jitter: 0.1 },
  { code: 'V-WHARF', name: 'Wharfside Offices Ltd', category: 'facilities', entity: 'BW-UK', account: '6100', dept: 'GA', terms: 15, monthly: 1_400_000 },
  { code: 'V-TESSELLATE', name: 'Tessellate Studio Ltd', category: 'consulting', entity: 'BW-UK', account: '6530', dept: 'PRD', terms: 30, monthly: 338_750 },
  { code: 'V-ALBION', name: 'Albion Telecom plc', category: 'telecom', entity: 'BW-UK', account: '6110', dept: 'GA', terms: 30, monthly: 64_000, jitter: 0.03 },
];

export interface MerchantDef {
  name: string;
  mcc: string;
  account: string;
  median: number;
  spread: number;
  weight: number;
  memo?: string;
  depts?: string[];
}

/** Card merchants (descriptions are what a card feed would show). */
export const MERCHANTS: MerchantDef[] = [
  { name: 'FIGMA INC', mcc: '5734', account: '6420', median: 7_500, spread: 0.6, weight: 4, depts: ['PRD'] },
  { name: 'SLACK TECHNOLOGIES', mcc: '5734', account: '6420', median: 92_000, spread: 0.1, weight: 1, depts: ['GA'] },
  { name: 'NOTION LABS INC', mcc: '5817', account: '6420', median: 48_000, spread: 0.15, weight: 1, depts: ['GA'] },
  { name: 'GITHUB INC', mcc: '5734', account: '6420', median: 210_000, spread: 0.05, weight: 1, depts: ['ENG'] },
  { name: 'ATLASSIAN', mcc: '5734', account: '6420', median: 133_000, spread: 0.05, weight: 1, depts: ['ENG'] },
  { name: 'ZOOM.US', mcc: '5817', account: '6420', median: 39_900, spread: 0.05, weight: 1, depts: ['GA'] },
  { name: 'LINEAR APP', mcc: '5734', account: '6420', median: 32_000, spread: 0.05, weight: 1, depts: ['ENG'] },
  { name: 'LINKEDIN ADS', mcc: '7311', account: '6300', median: 380_000, spread: 0.4, weight: 2, depts: ['MKT'] },
  { name: 'GOOGLE *ADS', mcc: '7311', account: '6300', median: 450_000, spread: 0.35, weight: 2, depts: ['MKT'] },
  { name: 'DELTA AIR LINES', mcc: '4511', account: '6200', median: 54_000, spread: 0.45, weight: 5, depts: ['SALES', 'CS'] },
  { name: 'UNITED AIRLINES', mcc: '4511', account: '6200', median: 47_000, spread: 0.45, weight: 4, depts: ['SALES', 'ENG'] },
  { name: 'MARRIOTT HOTELS', mcc: '7011', account: '6200', median: 61_000, spread: 0.4, weight: 4, depts: ['SALES', 'CS'] },
  { name: 'HILTON HOTELS', mcc: '7011', account: '6200', median: 52_000, spread: 0.4, weight: 3, depts: ['SALES'] },
  { name: 'UBER *TRIP', mcc: '4121', account: '6200', median: 3_400, spread: 0.5, weight: 12 },
  { name: 'LYFT *RIDE', mcc: '4121', account: '6200', median: 2_900, spread: 0.5, weight: 6 },
  { name: 'BLUE BOTTLE COFFEE', mcc: '5814', account: '6210', median: 2_400, spread: 0.5, weight: 8 },
  { name: 'SWEETGREEN', mcc: '5812', account: '6210', median: 6_800, spread: 0.6, weight: 6 },
  { name: 'DOORDASH*TEAM LUNCH', mcc: '5812', account: '6210', median: 42_000, spread: 0.4, weight: 3 },
  { name: 'STAPLES', mcc: '5943', account: '6600', median: 9_800, spread: 0.6, weight: 3, depts: ['GA'] },
  { name: 'APPLE STORE #R102', mcc: '5732', account: '6610', median: 14_900, spread: 0.5, weight: 2, memo: 'USB-C adapters and keyboards' },
  { name: 'FEDEX OFFICE', mcc: '4215', account: '6920', median: 4_100, spread: 0.6, weight: 3, depts: ['GA'] },
  { name: 'UDEMY', mcc: '8299', account: '6910', median: 8_900, spread: 0.3, weight: 2 },
  { name: 'WEWORK DAY PASS', mcc: '6513', account: '6100', median: 4_500, spread: 0.2, weight: 2, depts: ['SALES'] },
  { name: 'STRIPE FEES', mcc: '6012', account: '5100', median: 190_000, spread: 0.1, weight: 1, depts: ['GA'] },
];

export const CARDS = [
  { entity: 'BW-US', holder: 'Ava Thompson', last4: '4417', dept: 'SALES' },
  { entity: 'BW-US', holder: 'Leo Martins', last4: '5521', dept: 'MKT' },
  { entity: 'BW-US', holder: 'Grace Kim', last4: '6630', dept: 'ENG' },
  { entity: 'BW-US', holder: 'Noah Patel', last4: '7742', dept: 'CS' },
  { entity: 'BW-US', holder: 'Iris Okonkwo', last4: '8853', dept: 'PRD' },
  { entity: 'BW-US', holder: 'Hannah Weiss', last4: '9964', dept: 'GA' },
  { entity: 'BW-UK', holder: 'Oliver Hart', last4: '3108', dept: 'SALES' },
  { entity: 'BW-UK', holder: 'Amelia Shaw', last4: '3219', dept: 'ENG' },
] as const;

export const BANK_ACCOUNTS = [
  { entity: 'BW-US', name: 'Operating', institution: 'First Harbor Bank (fictional)', number: '0000004417', last4: '4417', currency: 'USD', gl: '1000', format: 'bai2' as const },
  { entity: 'BW-US', name: 'Payroll', institution: 'First Harbor Bank (fictional)', number: '0000009921', last4: '9921', currency: 'USD', gl: '1010', format: 'ofx' as const },
  { entity: 'BW-UK', name: 'Operating GBP', institution: 'Thamesgate Bank (fictional)', number: 'GB29THMG60161331926819', last4: '6819', currency: 'GBP', gl: '1020', format: 'camt053' as const },
];

/** Payroll by department per pay run (US semi-monthly gross; UK monthly gross in pence). */
export const PAYROLL = {
  US: { headcount: 74, gross: { ENG: 21_800_000, PRD: 6_100_000, SALES: 9_400_000, MKT: 4_200_000, CS: 5_300_000, GA: 6_700_000 } as Record<string, number> },
  UK: { headcount: 16, gross: { ENG: 8_600_000, SALES: 3_900_000, CS: 2_400_000 } as Record<string, number> },
};

export const ADJECTIVES = [
  'Halcyon', 'Orchard', 'Bluefin', 'Copper Ridge', 'Saltmarsh', 'Lanternfly', 'Northgate', 'Silverleaf', 'Quarry', 'Driftwood',
  'Cobalt', 'Juniper', 'Meridian', 'Tidewater', 'Granite', 'Foxglove', 'Harbor', 'Summit', 'Willow', 'Ember', 'Kestrel', 'Larkspur',
  'Redwood', 'Sable', 'Thistle', 'Wren', 'Alder', 'Briar', 'Cedar', 'Dune',
];

export const NOUNS = [
  'Freight', 'Analytics', 'Logistics', 'Health', 'Robotics', 'Foods', 'Energy', 'Capital', 'Labs', 'Systems', 'Mobility', 'Retail',
  'Studios', 'Partners', 'Telematics', 'Biotech', 'Outfitters', 'Materials', 'Networks', 'Media',
];

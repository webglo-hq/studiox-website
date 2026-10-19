import type { OntologyClass } from '../../../framework/ontology/types';
import { c } from './classes-core';

/**
 * Spend concepts: the semantic layer used for bucketing. Each concept carries machine
 * annotations (keywords, ISO 18245 merchant category codes, treatment hints) that the
 * coding engine scores transactions against; tenant accounts are mapped to concepts.
 */
export interface SpendAnnotations {
  keywords: string[];
  mcc?: string[];
  /** default treatment when amount/service-period rules do not override */
  treatment?: 'expense' | 'capitalize_candidate' | 'prepaid_candidate';
  requiresDepartment?: boolean;
}

function spend(id: string, label: string, parent: string, ann: SpendAnnotations, text: { definition: string; plain: string; why: string; example: string; mappings?: OntologyClass['mappings'] }): OntologyClass {
  return c(id, label, [parent], 'spend', { ...text, annotations: { ...ann } });
}

export const SPEND_CLASSES: OntologyClass[] = [
  c('ek:OperatingExpense', 'Operating expense', ['ek:ExpenseAccount'], 'spend', {
    abstract: true,
    definition: 'Expense incurred in normal operations, presented within operating income (R&D, S&M, G&A).',
    plain: 'Day-to-day cost of running the business.',
    why: 'Operating expenses require a department for budget accountability.',
    example: 'Software, travel, rent.',
    sources: ['con6', 'xbrl-usgaap'],
    mappings: { usGaap: 'OperatingExpenses' },
  }),
  c('ek:CostOfRevenue', 'Cost of revenue', ['ek:ExpenseAccount'], 'spend', {
    definition: 'Costs directly attributable to delivering revenue (hosting, support).',
    plain: 'Cost of delivering the product to customers.',
    why: 'Drives gross margin.',
    example: '5000 Hosting (COGS).',
    mappings: { usGaap: 'CostOfRevenue' },
    sources: ['xbrl-usgaap'],
  }),
  spend('ek:SoftwareExpense', 'Software & subscriptions', 'ek:OperatingExpense',
    { keywords: ['software', 'saas', 'subscription', 'license', 'licence', 'seats', 'app', 'plan', 'workspace tool', 'quillsoft', 'ledgerlight'], mcc: ['5734', '5817', '5818', '7372'], treatment: 'prepaid_candidate', requiresDepartment: true },
    {
      definition: 'Fees for software licences and SaaS subscriptions consumed in the period; annual prepayments are deferred (ASC 340-10).',
      plain: 'Paying for apps and software tools.',
      why: 'Annual plans paid upfront should become prepaids, not one month’s expense.',
      example: 'Monthly design tool seats.',
      mappings: { usGaap: 'SoftwareSubscriptionsExpense (extension)' },
    }),
  spend('ek:HostingExpense', 'Cloud hosting', 'ek:CostOfRevenue',
    { keywords: ['cloud', 'hosting', 'compute', 'server', 'storage', 'cdn', 'infrastructure', 'database', 'nimbus', 'bandwidth'], mcc: ['4816', '7379'], requiresDepartment: true },
    {
      definition: 'Usage-based infrastructure cost to run the production service.',
      plain: 'Paying for servers in the cloud.',
      why: 'Scales with usage; a common flux driver.',
      example: 'Nimbus Cloud Services monthly invoice.',
    }),
  spend('ek:TravelExpense', 'Travel', 'ek:OperatingExpense',
    { keywords: ['airline', 'air', 'airways', 'flight', 'hotel', 'inn', 'lodging', 'rail', 'train', 'taxi', 'rideshare', 'ride', 'car rental', 'parking', 'travel', 'transit'], mcc: ['3000', '3001', '4111', '4121', '4131', '4511', '4722', '4789', '7011', '7512', '7523'], requiresDepartment: true },
    {
      definition: 'Business travel: transport, lodging and incidentals.',
      plain: 'Flights, hotels, taxis for work trips.',
      why: 'Policy-sensitive; often coded by the cardholder’s department.',
      example: 'Harborline Air ticket SFO–LHR.',
    }),
  spend('ek:MealsExpense', 'Meals & entertainment', 'ek:OperatingExpense',
    { keywords: ['restaurant', 'cafe', 'coffee', 'grill', 'kitchen', 'catering', 'lunch', 'dinner', 'bistro', 'bar', 'food', 'eatery', 'pizza', 'deli'], mcc: ['5811', '5812', '5813', '5814'], requiresDepartment: true },
    {
      definition: 'Business meals and entertainment; partially deductible for tax.',
      plain: 'Team lunches and client dinners.',
      why: 'Separate tracking supports tax deductibility limits.',
      example: 'Harbor Grill client dinner.',
    }),
  spend('ek:MarketingExpense', 'Marketing & advertising', 'ek:OperatingExpense',
    { keywords: ['ads', 'advertising', 'marketing', 'sponsorship', 'sponsor', 'campaign', 'events', 'event', 'conference', 'booth', 'media', 'promo', 'swag', 'signal ads', 'brightstage'], mcc: ['7311', '7333', '7319'], requiresDepartment: true },
    {
      definition: 'Demand generation: advertising, sponsorships, events and content.',
      plain: 'Spending to attract customers.',
      why: 'Lumpy (events, campaigns): frequent flux driver.',
      example: 'Summit 2026 sponsorship.',
      mappings: { usGaap: 'MarketingAndAdvertisingExpense' },
    }),
  spend('ek:ProfessionalFeesExpense', 'Professional fees', 'ek:OperatingExpense',
    { keywords: ['legal', 'law', 'attorney', 'llp', 'counsel', 'audit', 'accounting', 'consulting', 'consultants', 'advisory', 'tax'], mcc: ['8111', '8931', '8999', '7392'], requiresDepartment: true },
    {
      definition: 'Legal, audit, tax and consulting services.',
      plain: 'Paying lawyers, auditors and consultants.',
      why: 'Often billed in arrears — prime accrual candidates.',
      example: 'Brightpath Legal monthly retainer.',
      mappings: { usGaap: 'ProfessionalFees' },
    }),
  spend('ek:OfficeExpense', 'Office supplies', 'ek:OperatingExpense',
    { keywords: ['office', 'supplies', 'paper', 'print', 'printing', 'stationery', 'toner', 'signage', 'depot'], mcc: ['5111', '5943', '5044', '7338'], requiresDepartment: true },
    {
      definition: 'Consumable office items below the capitalisation threshold.',
      plain: 'Pens, paper, small office items.',
      why: 'Equipment above the threshold must not hide here.',
      example: 'Sparrow Print & Signage.',
    }),
  spend('ek:ComputerEquipment', 'Computer equipment', 'ek:OperatingExpense',
    { keywords: ['laptop', 'laptops', 'computer', 'computers', 'monitor', 'notebook', 'workstation', 'server rack', 'kestrel computers', 'hardware', 'electronics'], mcc: ['5732', '5045', '5734'], treatment: 'capitalize_candidate', requiresDepartment: true },
    {
      definition: 'Computing hardware; capitalised to fixed assets when unit cost exceeds the capitalisation threshold (ASC 360), otherwise expensed.',
      plain: 'Laptops and monitors.',
      why: 'Expensive units are assets, not expenses.',
      example: '3 laptops at $2,899 each → capitalise.',
      mappings: { asc: '360-10' },
    }),
  spend('ek:TelecomExpense', 'Telecom & internet', 'ek:OperatingExpense',
    { keywords: ['telecom', 'phone', 'internet', 'mobile', 'wireless', 'broadband', 'fiber', 'corelink'], mcc: ['4814', '4899'], requiresDepartment: true },
    {
      definition: 'Phone, internet and connectivity services.',
      plain: 'Phone and internet bills.',
      why: 'Recurring monthly — missing bills suggest an accrual.',
      example: 'Corelink Telecom.',
    }),
  spend('ek:RentExpense', 'Rent & facilities', 'ek:OperatingExpense',
    { keywords: ['rent', 'lease', 'workspace', 'cowork', 'facilities', 'property', 'landlord', 'atlas workspace'], mcc: ['6513'], requiresDepartment: true },
    {
      definition: 'Occupancy cost; leases > 12 months are recognised under ASC 842 as right-of-use assets and lease liabilities (simplified here to straight-line lease cost).',
      plain: 'Office rent.',
      why: 'Fixed and recurring; deviations are notable.',
      example: 'Atlas Workspace monthly rent.',
      mappings: { asc: '842-20' },
    }),
  spend('ek:InsuranceExpense', 'Insurance', 'ek:OperatingExpense',
    { keywords: ['insurance', 'premium', 'policy', 'underwriters', 'mutual', 'd&o', 'liability cover'], treatment: 'prepaid_candidate', requiresDepartment: true },
    {
      definition: 'Insurance premiums, usually paid annually in advance and amortised.',
      plain: 'Insurance policies.',
      why: 'Annual premiums belong in prepaids.',
      example: 'Lumen Mutual D&O policy.',
    }),
  spend('ek:UtilitiesExpense', 'Utilities', 'ek:OperatingExpense',
    { keywords: ['electric', 'utility', 'utilities', 'water', 'gas', 'power', 'energy', 'helio'], mcc: ['4900'], requiresDepartment: true },
    {
      definition: 'Electricity, water and similar utilities.',
      plain: 'Power and water bills.',
      why: 'Billed in arrears — accrue when late.',
      example: 'Helio Utilities.',
    }),
  spend('ek:ShippingExpense', 'Shipping & postage', 'ek:OperatingExpense',
    { keywords: ['shipping', 'courier', 'freight', 'postage', 'delivery', 'parcel'], mcc: ['4215', '9402'], requiresDepartment: true },
    {
      definition: 'Courier, freight and postage.',
      plain: 'Sending packages.',
      why: 'Small but frequent.',
      example: 'Parcelwise courier.',
    }),
  spend('ek:TrainingExpense', 'Training & education', 'ek:OperatingExpense',
    { keywords: ['course', 'training', 'certification', 'education', 'workshop', 'learning', 'academy'], mcc: ['8220', '8299'], requiresDepartment: true },
    {
      definition: 'Employee learning and certification.',
      plain: 'Courses and training for staff.',
      why: 'Often budgeted per department.',
      example: 'Analytics certification course.',
    }),
  spend('ek:PayrollExpense', 'Salaries & wages', 'ek:OperatingExpense',
    { keywords: ['payroll', 'salary', 'salaries', 'wages', 'bonus', 'commission'], requiresDepartment: true },
    {
      definition: 'Employee compensation, employer payroll taxes and benefits.',
      plain: 'What the company pays its people.',
      why: 'Largest cost; accrued for days worked but unpaid at month end.',
      example: 'Semi-monthly payroll.',
      mappings: { usGaap: 'LaborAndRelatedExpense' },
    }),
  spend('ek:BankFeesExpense', 'Bank fees', 'ek:OperatingExpense',
    { keywords: ['bank fee', 'service charge', 'wire fee', 'account analysis', 'maintenance fee', 'fee'], requiresDepartment: false },
    {
      definition: 'Charges levied by banks for account services.',
      plain: 'Fees the bank charges.',
      why: 'Often appear only on the statement — reconciliations create the entry.',
      example: 'Monthly service fee $145.00.',
    }),
  spend('ek:DepreciationExpense', 'Depreciation', 'ek:OperatingExpense',
    { keywords: ['depreciation'], requiresDepartment: true },
    {
      definition: 'Periodic allocation of fixed asset cost (ASC 360).',
      plain: 'The monthly cost of using equipment.',
      why: 'System-generated from the asset register.',
      example: 'September depreciation.',
      mappings: { usGaap: 'Depreciation' },
    }),
];

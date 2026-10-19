/**
 * Deterministic demo scenario (seeded PRNG): Bramblewood Labs, a FICTIONAL group.
 * 2025-08-31 opening balances → Sep 2025 … Aug 2026 closed history → September 2026 open with
 * planted issues → scenario clock Fri 2 Oct 2026 (WD+2).
 */
import { sha256Hex } from '../../../core/util/hash';
import { addDays, isWeekend, periodEnd, periodKeyOf, periodRange, periodStart, shiftPeriod } from '../../../core/util/time';
import { writeBai2 } from '../../../integrations/bai2';
import { writeCamt053 } from '../../../integrations/camt053';
import { toCsv } from '../../../integrations/csv';
import type { Db } from '../../../schema';
import { PERMISSIONS, ROLES } from '../controls/permissions';
import { DEFAULT_SOD_RULES } from '../controls/sod';
import { workdayDate } from '../close/workdays';
import { convert } from '../ledger/money';
import { SeedBuilder } from './builder';
import { ACCOUNTS, CARDHOLDERS, CLOSE_TEMPLATE, COMPANY, DIMENSIONS, ENTITIES, FS_LINES, PEOPLE, SCENARIO, VENDORS } from './company';
import {
  addCardTxn, buildCustomers, businessDayOnOrAfter, businessDayOnOrBefore, cardActivity, collectReceipts, eliminations, fxRevaluation, generateFx, intercompanyCharge,
  inventoryPurchase, issueInvoice, jeAutoReversing, manual, monthRevenue, payBills, payDatesUS, payrollAccrual, postBill, postDueReversals, releaseDeferredRevenue,
  requiresDept, runPayroll, settleCards, settleIntercompany, spotOn, weekdayInMonth, type HistoryState,
} from './history';
import { plantSeptember, PLANTED } from './planted';

export interface SeedOptions {
  seed?: number;
  demoPassword: string;
  hashPassword: (password: string) => Promise<string>;
  /** Install skills/policies (provided by the skills module to avoid a dependency cycle). */
  installSkills?: (b: SeedBuilder, ctx: { controllerId: string; now: string }) => void;
  onProgress?: (msg: string) => void;
}

export interface SeedSummary {
  tenantId: string;
  counts: Record<string, number>;
  planted: typeof PLANTED;
  users: { email: string; name: string; role: string }[];
}

export const DEMO_TENANT_ID = 'ten_bramblewood';

export async function seedScenario(db: Db, opts: SeedOptions): Promise<SeedSummary> {
  const b = new SeedBuilder(opts.seed ?? 20260930, DEMO_TENANT_ID);
  const now = `${SCENARIO.businessDate}T09:00:00.000Z`;
  opts.onProgress?.('building company');

  b.add('tenants', { id: DEMO_TENANT_ID, slug: COMPANY.tenantSlug, name: COMPANY.tenantName, is_demo: true, settings: { businessDate: SCENARIO.businessDate, activeCloseKey: SCENARIO.closeKey, agentMode: 'auto', mfaRequiredRoles: [], sessionIdleMinutes: 30, sessionAbsoluteHours: 12, displayName: 'Bramblewood Labs' }, created_at: '2025-08-01T12:00:00.000Z' });
  for (const [code, name] of [['USD', 'US dollar'], ['GBP', 'Pound sterling'], ['EUR', 'Euro']] as const) b.add('currencies', { id: code, name, minor_units: 2 });

  // ------------------------------------------------------------- RBAC
  // Row ids are drawn from the scenario's seeded RNG, so adding a role permission (or any row before
  // the history) shifts every generated amount after it: re-baseline the skill goldens if you do.
  for (const [key, [category, description]] of Object.entries(PERMISSIONS)) b.add('permissions', { id: key, category, description, sensitive: /approve|lock|admin|policy|autonomy|reverse/.test(key) });
  const roleIds = new Map<string, string>();
  for (const r of ROLES) {
    const row = b.add('roles', { key: r.key, name: r.name, description: r.description, approval_limit_minor: r.approvalLimitMinor, is_system: true });
    roleIds.set(r.key, row.id);
    for (const p of r.permissions) b.add('role_permissions', { role_id: row.id, permission_id: p });
  }
  for (const p of PEOPLE) {
    const u = b.add('users', { email: p.email, display_name: p.name, title: p.title, password_hash: await opts.hashPassword(opts.demoPassword), status: 'active', kind: 'human', mfa_enabled: false, failed_logins: 0, locked_until: null, last_login_at: null, preferences: {}, created_at: '2025-08-01T12:00:00.000Z' });
    b.userId.set(p.key, u.id);
    for (const role of p.roles) b.add('user_roles', { user_id: u.id, role_id: roleIds.get(role)!, scope_entity_id: null, granted_by: null, granted_at: '2025-08-01T12:00:00.000Z' });
  }
  for (const r of DEFAULT_SOD_RULES) b.add('sod_rules', { ...r, updated_by: b.user('avery'), updated_at: '2025-08-01T12:00:00.000Z' });

  // ------------------------------------------------------------- org & COA
  ENTITIES.forEach((e, i) => {
    const row = b.add('entities', { code: e.code, name: e.name, kind: e.kind, country: e.country, functional_currency: e.currency, reporting_currency: 'USD', parent_id: e.parent ? b.ent(e.parent) : null, ownership_pct: 100, holiday_calendar: e.calendar, materiality: e.materiality, sort_order: i });
    b.entityId.set(e.code, row.id);
    b.entityCurrency.set(e.code, e.currency);
  });
  const fsId = new Map<string, string>();
  for (const f of FS_LINES) fsId.set(f.code, b.add('fs_line_items', { code: f.code, statement: f.statement, section: f.section, label: f.label, xbrl_concept: f.xbrl, sort_order: f.sort }).id);
  for (const a of ACCOUNTS) {
    const normal = (a.cls === 'asset' || a.cls === 'expense') !== !!a.contra ? 'debit' : 'credit';
    const row = b.add('accounts', {
      code: a.code, name: a.name, account_class: a.cls, ontology_class: a.onto, normal_balance: normal, is_contra: !!a.contra, parent_id: a.parent ? b.acct(a.parent) : null, is_postable: a.postable !== false,
      control_subledger: a.control ?? null, fs_line_id: fsId.get(a.fs)!, xbrl_concept: FS_LINES.find((f) => f.code === a.fs)!.xbrl, required_dimensions: a.dims ?? [], is_monetary: !!a.monetary, is_intercompany: !!a.ic, cash_flow_category: a.cf ?? (a.cls === 'revenue' || a.cls === 'expense' ? 'operating' : null), status: 'active', description: a.description ?? '',
    });
    b.accountId.set(a.code, row.id);
  }
  for (const d of DIMENSIONS) {
    const dim = b.add('dimensions', { key: d.key, name: d.name });
    for (const [code, name] of d.values) b.add('dimension_values', { dimension_id: dim.id, code, name, status: 'active' });
  }
  // periods: 2025-08 (opening) … 2026-12
  for (const e of ENTITIES)
    for (const pk of periodRange('2025-08', '2026-12')) {
      // history is posted into open periods, then soft-closed and locked in order (AX-PD-03)
      const final = pk < SCENARIO.closeKey ? 'locked' : pk <= periodKeyOf(SCENARIO.businessDate) ? 'open' : 'future';
      const row = b.add('periods', { entity_id: b.ent(e.code), period_key: pk, fiscal_year: Number(pk.slice(0, 4)), fiscal_period: Number(pk.slice(5)), start_date: periodStart(pk), end_date: periodEnd(pk), status: final === 'future' ? 'future' : 'open', soft_closed_at: null, soft_closed_by: null, locked_at: null, locked_by: null, status_reason: null, reopen_count: 0 });
      b.periodId.set(`${e.code}:${pk}`, row.id);
      if (final === 'locked') {
        const cal = e.calendar;
        b.afterPost.push(async (tx) => {
          await tx.update('periods', row.id, { status: 'soft_closed', soft_closed_at: `${workdayDate(pk, 3, cal)}T18:00:00.000Z`, soft_closed_by: b.user('casey') });
          await tx.update('periods', row.id, { status: 'locked', locked_at: `${workdayDate(pk, pk >= '2026-05' ? 4 : 5, cal)}T19:30:00.000Z`, locked_by: b.user('casey') });
        });
      }
    }

  // ------------------------------------------------------------- state
  const st: HistoryState = {
    b, spot: new Map(), closing: new Map(), average: new Map(), bankAccount: {}, cardIds: [], vendorIds: new Map(), customers: [], icPayableGbp: 0, icPayableUsd: 0, icReceivableGbp: 0,
    checkNo: 10391, paymentNo: 0, invoiceNo: {}, poNo: 380, bankQueue: [], openBills: [], openInvoices: [], cardBalance: {}, invoiceById: new Map(), billById: new Map(), reversals: [], fixedAssets: [], prepaid: [], opening: { usdCash: 0, gbpCash: 0 }, sim: { september: false },
  };
  generateFx(st, '2025-08-01', SCENARIO.lastActivityDate);
  for (const v of VENDORS) st.vendorIds.set(v.code, b.add('vendors', { entity_id: b.ent(v.entity), code: v.code, name: v.name, category: v.category, default_account_id: b.acct(v.account), default_department: v.dept, payment_terms_days: v.terms, bank_last4: String(1000 + (v.code.length * 377) % 9000).slice(-4), is_intercompany: false, counterparty_entity_id: null, status: 'active' }).id);
  st.bankAccount['BWL-US'] = { id: b.add('bank_accounts', { entity_id: b.ent('BWL-US'), name: 'First Harbor operating', bank_name: 'First Harbor Bank (fictional)', account_last4: '4417', currency: 'USD', gl_account_id: b.acct('1010'), statement_format: 'bai2', status: 'active' }).id, gl: '1010', currency: 'USD' };
  st.bankAccount['BWL-UK'] = { id: b.add('bank_accounts', { entity_id: b.ent('BWL-UK'), name: 'Thameside operating', bank_name: 'Thameside Bank plc (fictional)', account_last4: '2208', currency: 'GBP', gl_account_id: b.acct('1030'), statement_format: 'camt053', status: 'active' }).id, gl: '1030', currency: 'GBP' };
  for (const c of CARDHOLDERS) st.cardIds.push({ id: b.add('cards', { entity_id: b.ent(c.entity), cardholder_name: c.name, last4: c.last4, department: c.dept, gl_account_id: b.acct('2200'), status: 'active' }).id, entity: c.entity, name: c.name, dept: c.dept, last4: c.last4 });
  buildCustomers(st);

  opts.onProgress?.('opening balances');
  openingBalances(st);

  // ------------------------------------------------------------- months
  const months = periodRange(SCENARIO.historyStart, SCENARIO.closeKey);
  for (const pk of months) {
    opts.onProgress?.(`activity ${pk}`);
    st.sim.september = pk === SCENARIO.closeKey;
    simulateMonth(st, pk);
    if (pk === '2025-12') yearEndClose(st, '2025-12');
  }
  // early October activity up to the scenario clock (bank clears, new bills, cards)
  octoberToDate(st);
  plantSeptember(st);

  opts.onProgress?.('bank statements and source documents');
  emitBank(st);
  budgets(st);
  closeManagement(st, now);
  connectors(st);
  opts.installSkills?.(b, { controllerId: b.user('casey'), now });
  for (const c of b.counterRows()) b.add('counters', c);
  opts.onProgress?.('writing to the database');
  const counts = await b.flush(db, opts.onProgress);
  return { tenantId: DEMO_TENANT_ID, counts, planted: PLANTED, users: PEOPLE.map((p) => ({ email: p.email, name: p.name, role: p.title })) };
}

// =============================================================================== opening
function openingBalances(st: HistoryState) {
  const { b } = st;
  const openDate = '2025-08-31';
  const rateOpen = st.spot.get(openDate)!;
  // ---- US
  const us: { account: string; debit?: number; credit?: number; department?: string; txn_currency?: string; txn_amount_minor?: number; fx_rate?: number; counterparty_entity_id?: string }[] = [];
  const usCash = 9_642_310_00;
  st.opening.usdCash = usCash;
  us.push({ account: '1010', debit: usCash });
  // pre-history open AR (August invoices) and deferred revenue from annual billings
  const usOpeningJe = b.id('je');
  let arUs = 0;
  let defRevUs = 0;
  let arUk = 0;
  let defRevUk = 0;
  const ukOpeningJe = b.id('je');
  for (const c of st.customers) {
    if (c.startKey > '2025-08') continue;
    if (c.billing === 'annual') {
      const k = ((8 - c.anniversary + 12) % 12) + 1;
      const remaining = (c.arr / 12) * (12 - k);
      if (c.entity === 'BWL-US') defRevUs += remaining;
      else defRevUk += remaining;
      if (c.anniversary === 8 || c.anniversary === 7) {
        const inv = issueInvoice(st, c, businessDayOnOrAfter(`2025-0${c.anniversary}-01`, 'US'), [{ description: `Annual platform subscription 2025-0${c.anniversary}`, amount: c.arr, revenueType: 'subscription', account: '2300', productClass: 'PLATFORM' }], { opening: true, openingJeId: c.entity === 'BWL-US' ? usOpeningJe : ukOpeningJe });
        if (c.entity === 'BWL-US') arUs += inv.total_minor as number;
        else arUk += inv.total_minor as number;
      }
    } else {
      const inv = issueInvoice(st, c, '2025-08-01', [{ description: 'Platform subscription – 2025-08', amount: c.arr / 12, revenueType: 'subscription', account: '4000', productClass: 'PLATFORM' }], { opening: true, openingJeId: c.entity === 'BWL-US' ? usOpeningJe : ukOpeningJe });
      if (c.entity === 'BWL-US') arUs += inv.total_minor as number;
      else arUk += inv.total_minor as number;
    }
  }
  us.push({ account: '1100', debit: arUs });
  us.push({ account: '1150', credit: 42_000_00 });
  us.push({ account: '1300', debit: 418_600_00 });
  us.push({ account: '1210', debit: 10_000_00 });
  // fixed assets with schedules
  const assets: [string, string, string, number, number, string, string][] = [
    ['FA-0001', 'Engineering workstations (12)', 'computer_equipment', 86_400_00, 36, '2024-03-01', 'RND'],
    ['FA-0002', 'Laptops – 2024 refresh (40)', 'computer_equipment', 112_000_00, 36, '2024-07-01', 'GA'],
    ['FA-0003', 'Calibration chamber', 'lab_equipment', 148_000_00, 60, '2023-11-01', 'RND'],
    ['FA-0004', 'Environmental test rig', 'lab_equipment', 96_500_00, 60, '2024-05-01', 'RND'],
    ['FA-0005', 'Office furniture – SF', 'furniture', 74_800_00, 84, '2023-06-01', 'GA'],
    ['FA-0006', 'Spectrum analyzer', 'lab_equipment', 38_900_00, 60, '2025-02-01', 'RND'],
    ['FA-0007', 'Laptops – 2025 refresh (25)', 'computer_equipment', 70_000_00, 36, '2025-06-01', 'GA'],
    ['FA-0008', 'Server racks and networking', 'computer_equipment', 58_250_00, 48, '2024-10-01', 'OPS'],
  ];
  const cost: Record<string, number> = { '1510': 0, '1520': 0, '1530': 0 };
  let accum = 0;
  for (const [tag, desc, cat, c, life, inService, dept] of assets) {
    const acct = cat === 'computer_equipment' ? '1510' : cat === 'lab_equipment' ? '1520' : '1530';
    const monthly = Math.round(c / life);
    const elapsed = periodRange(periodKeyOf(inService), '2025-08').length;
    const fa = b.add('fixed_assets', { entity_id: b.ent('BWL-US'), asset_tag: tag, description: desc, category: cat as 'lab_equipment', in_service_date: inService, cost_minor: c, salvage_minor: 0, useful_life_months: life, method: 'straight_line', asset_account_id: b.acct(acct), accum_depr_account_id: b.acct('1590'), expense_account_id: b.acct('6800'), department: dept, status: 'active', source_bill_id: null });
    cost[acct]! += c;
    accum += Math.min(c, monthly * elapsed);
    st.fixedAssets.push({ id: fa.id, entity: 'BWL-US', category: cat, monthly, dept, remaining: c - Math.min(c, monthly * elapsed), account: acct });
  }
  for (const [acct, v] of Object.entries(cost)) us.push({ account: acct, debit: v });
  us.push({ account: '1590', credit: accum });
  us.push({ account: '1610', debit: 1_184_000_00 });
  // pre-history open AP (August bills paid in September)
  const apOpen: [string, number][] = [['V-CUMULUS', 33_120_00], ['V-ATLAS', 12_940_00], ['V-ORBITRON', 24_600_00], ['V-GRIDLOCK', 3_100_00], ['V-SUNDIAL', 5_800_00]];
  let apUs = 0;
  for (const [code, amt] of apOpen) {
    const v = VENDORS.find((x) => x.code === code)!;
    postBill(st, v, '2025-08-29', amt, { opening: true, openingJeId: usOpeningJe, servicePeriod: ['2025-08-01', '2025-08-31'], payOn: v.terms ? addDays('2025-08-29', v.terms) : '2025-09-02' });
    apUs += amt;
  }
  us.push({ account: '2000', credit: apUs });
  us.push({ account: '2110', credit: 86_400_00 });
  us.push({ account: '2200', credit: 27_950_00 });
  st.cardBalance['BWL-US'] = 27_950_00;
  us.push({ account: '2300', credit: Math.round(defRevUs) });
  us.push({ account: '2410', credit: 1_241_000_00 });
  us.push({ account: '2500', credit: 0 });
  // intercompany payable: £360,000 owed to the UK for Jun–Aug 2025 services
  const icGbp = 360_000_00;
  const icUsd = convert(icGbp, rateOpen);
  st.icPayableGbp = icGbp;
  st.icPayableUsd = icUsd;
  us.push({ account: '2400', credit: icUsd, txn_currency: 'GBP', txn_amount_minor: -icGbp, fx_rate: rateOpen, counterparty_entity_id: b.ent('BWL-UK') });
  us.push({ account: '3000', credit: 1_000_00 });
  us.push({ account: '3100', credit: 42_380_000_00 });
  const usDr = us.reduce((s, l) => s + (l.debit ?? 0), 0);
  const usCr = us.reduce((s, l) => s + (l.credit ?? 0), 0);
  us.push(usDr > usCr ? { account: '3200', credit: usDr - usCr } : { account: '3200', debit: usCr - usDr });
  b.je({ entity: 'BWL-US', date: openDate, type: 'opening', memo: 'Opening balances migrated from legacy ERP at 31 Aug 2025', source: 'import', sourceRef: 'MIGRATION-2025-08-31', preparedBy: b.user('casey'), approvedBy: b.user('riley'), route: 'human', lines: us.map((l) => ({ ...l })) });
  // the builder assigned its own id; link opening invoices/bills to it
  relinkOpening(st, usOpeningJe, 'BWL-US');

  // ---- UK
  const ukCash = 2_086_450_00;
  st.opening.gbpCash = ukCash;
  const uk: { account: string; debit?: number; credit?: number; counterparty_entity_id?: string }[] = [];
  uk.push({ account: '1030', debit: ukCash });
  uk.push({ account: '1100', debit: arUk });
  uk.push({ account: '1400', debit: icGbp, counterparty_entity_id: b.ent('BWL-US') });
  st.icReceivableGbp = icGbp;
  uk.push({ account: '1510', debit: 64_000_00 });
  uk.push({ account: '1520', debit: 92_000_00 });
  uk.push({ account: '1590', credit: 41_300_00 });
  st.fixedAssets.push({ id: b.add('fixed_assets', { entity_id: b.ent('BWL-UK'), asset_tag: 'FA-UK-001', description: 'Engineering laptops – London (16)', category: 'computer_equipment', in_service_date: '2024-09-01', cost_minor: 64_000_00, salvage_minor: 0, useful_life_months: 36, method: 'straight_line', asset_account_id: b.acct('1510'), accum_depr_account_id: b.acct('1590'), expense_account_id: b.acct('6800'), department: 'RND', status: 'active', source_bill_id: null }).id, entity: 'BWL-UK', category: 'computer_equipment', monthly: Math.round(64_000_00 / 36), dept: 'RND', remaining: 64_000_00 - Math.round(64_000_00 / 36) * 12, account: '1510' });
  st.fixedAssets.push({ id: b.add('fixed_assets', { entity_id: b.ent('BWL-UK'), asset_tag: 'FA-UK-002', description: 'Sensor test bench – London', category: 'lab_equipment', in_service_date: '2025-01-01', cost_minor: 92_000_00, salvage_minor: 0, useful_life_months: 60, method: 'straight_line', asset_account_id: b.acct('1520'), accum_depr_account_id: b.acct('1590'), expense_account_id: b.acct('6800'), department: 'RND', status: 'active', source_bill_id: null }).id, entity: 'BWL-UK', category: 'lab_equipment', monthly: Math.round(92_000_00 / 60), dept: 'RND', remaining: 92_000_00 - Math.round(92_000_00 / 60) * 8, account: '1520' });
  uk.push({ account: '2000', credit: 0 });
  uk.push({ account: '2110', credit: 38_200_00 });
  uk.push({ account: '2300', credit: Math.round(defRevUk) });
  uk.push({ account: '2600', credit: 61_750_00 });
  uk.push({ account: '3000', credit: 100_000_00 });
  const ukDr = uk.reduce((s, l) => s + (l.debit ?? 0), 0);
  const ukCr = uk.reduce((s, l) => s + (l.credit ?? 0), 0);
  uk.push(ukDr > ukCr ? { account: '3200', credit: ukDr - ukCr } : { account: '3200', debit: ukCr - ukDr });
  b.je({ entity: 'BWL-UK', date: openDate, type: 'opening', memo: 'Opening balances migrated from legacy ERP at 31 Aug 2025', source: 'import', sourceRef: 'MIGRATION-2025-08-31', preparedBy: b.user('casey'), approvedBy: b.user('riley'), route: 'human', lines: uk });
  relinkOpening(st, ukOpeningJe, 'BWL-UK');

  // prepaid insurance 2025 policy (Jan–Dec 2025, $30,000; Sep–Dec remain)
  const policy2025 = b.add('prepaid_schedules', { entity_id: b.ent('BWL-US'), vendor_id: st.vendorIds.get('V-FIELDSTONE')!, description: 'Fieldstone Mutual – 2025 business package policy', start_period: '2025-01', months: 12, total_minor: 30_000_00, prepaid_account_id: b.acct('1210'), expense_account_id: b.acct('6700'), department: 'GA', source_bill_id: null, status: 'active' });
  const lines2025 = new Map<string, { id: string; amount: number }>();
  for (const pk of periodRange('2025-01', '2025-12')) {
    const l = b.add('prepaid_lines', { prepaid_schedule_id: policy2025.id, period_key: pk, amount_minor: 2_500_00, status: pk <= '2025-08' ? 'posted' : 'scheduled', journal_entry_id: null });
    lines2025.set(pk, { id: l.id, amount: 2_500_00 });
  }
  st.prepaid.push({ id: policy2025.id, entity: 'BWL-US', account: '1210', expense: '6700', dept: 'GA', lines: lines2025 });
  // depreciation schedules (history lines get created as posted in simulateMonth)
}

function relinkOpening(st: HistoryState, placeholder: string, entity: string) {
  const actual = st.b.postedJeIds[st.b.postedJeIds.length - 1]!;
  for (const inv of st.b.list('invoices')) if (inv.journal_entry_id === placeholder) (inv as Record<string, unknown>).journal_entry_id = actual;
  for (const bill of st.b.list('bills')) if (bill.journal_entry_id === placeholder) (bill as Record<string, unknown>).journal_entry_id = actual;
  void entity;
}

// =============================================================================== month
function simulateMonth(st: HistoryState, pk: string) {
  const { b } = st;
  const sept = st.sim.september;
  const start = periodStart(pk);
  const end = periodEnd(pk);
  postDueReversals(st, start);
  // ---------------- revenue & receipts
  monthRevenue(st, pk, 'BWL-US');
  monthRevenue(st, pk, 'BWL-UK');
  releaseDeferredRevenue(st, pk, 'BWL-US');
  releaseDeferredRevenue(st, pk, 'BWL-UK');
  collectReceipts(st, start, end, { skip: sept ? (i) => PLANTED.skipReceipt(i) : undefined });
  // ---------------- recurring vendors (US + UK)
  for (const v of VENDORS.filter((x) => x.monthly)) {
    const cal = v.entity === 'BWL-US' ? 'US' : 'UK';
    let amount = v.monthly!;
    if (v.code === 'V-CUMULUS') amount = Math.round(amount * (1 + 0.012 * monthsSinceStart(pk)) * (pk >= '2026-08' ? 1.14 : 1));
    else if (v.code !== 'V-HARBOR' && v.code !== 'V-UK-THAMES' && v.code !== 'V-REDWOOD' && v.code !== 'V-GRIDLOCK' && v.code !== 'V-SUNDIAL') amount = Math.round(amount * (1 + b.rng.normal(0, 0.08)) / 100) * 100;
    if (sept && PLANTED.skipVendorBill(v.code)) continue;
    if (v.timing === 'start') {
      const date = businessDayOnOrAfter(start, cal);
      postBill(st, v, date, amount, { servicePeriod: [start, end], payOn: v.terms === 0 ? date : undefined, project: null });
    } else {
      const glDate = end;
      const project = v.code === 'V-CUMULUS' && pk >= '2026-08' ? 'PRJ-PIPELINE' : null;
      postBill(st, v, glDate, amount, { servicePeriod: [start, end], glDate, project });
    }
  }
  // quarterly audit fee
  if (['2025-09', '2025-12', '2026-03', '2026-06', '2026-09'].includes(pk)) postBill(st, VENDORS.find((v) => v.code === 'V-BRIGHTLINE')!, end, 15_000_00, { description: `Quarterly review fee – Q${Math.ceil(Number(pk.slice(5)) / 3)} ${pk.slice(0, 4)}`, servicePeriod: [periodStart(shiftPeriod(pk, -2)), end] });
  // events (small, most months)
  if (b.rng.chance(0.7) && !(sept && PLANTED.skipSmallEvents)) postBill(st, VENDORS.find((v) => v.code === 'V-ATRIUM')!, businessDayOnOrBefore(addDays(start, b.rng.int(5, 22))), Math.round(b.rng.float(6_500_00, 12_500_00) / 100) * 100, { description: 'Customer workshop venue' });
  // annual insurance (Jan) and CRM (Mar) — prepaid
  if (pk === '2026-01') prepaidPurchase(st, 'V-FIELDSTONE', '2026-01-05', 36_000_00, '1210', '6700', 'GA', 'Fieldstone Mutual – 2026 business package policy', '2026-01', 12);
  if (pk === '2026-03') prepaidPurchase(st, 'V-TESSELLATE', '2026-03-02', 54_000_00, '1220', '6150', 'SALES', 'Tessellate CRM – annual enterprise licence', '2026-03', 12);
  // inventory purchase
  inventoryPurchase(st, pk);
  // office supplies by check
  postBill(st, VENDORS.find((v) => v.code === 'V-VERDANT')!, businessDayOnOrBefore(addDays(start, b.rng.int(3, 18))), Math.round(b.rng.float(800_00, 2_400_00)), { description: 'Office and kitchen supplies' });
  // ---------------- payroll
  const pays = payDatesUS(pk);
  for (const pd of pays) runPayroll(st, 'BWL-US', pd, addDays(pd, -20), addDays(pd, -7), 12 / 26);
  const ukPay = weekdayInMonth(pk, 25, 'UK');
  runPayroll(st, 'BWL-UK', ukPay, start, end, 1);
  // ---------------- cards
  cardActivity(st, 'BWL-US', pk, sept ? { uncodedFrom: PLANTED.uncodedCardsFrom } : {});
  cardActivity(st, 'BWL-UK', pk, sept ? { uncodedFrom: PLANTED.uncodedCardsFrom } : {});
  settleCards(st, 'BWL-US', weekdayInMonth(pk, 8));
  settleCards(st, 'BWL-UK', weekdayInMonth(pk, 8, 'UK'));
  // ---------------- AP payments
  payBills(st, start, end, { skip: sept ? (x) => PLANTED.skipPayment(x) : undefined });
  // ---------------- intercompany
  // services are recharged on the 25th; the payable then sits open over month-end and must be remeasured
  const icDate = businessDayOnOrBefore(addDays(start, 24), 'UK');
  const ukRevGbp = 120_000_00;
  const usExpBefore = st.icPayableUsd;
  if (sept) intercompanyCharge(st, icDate, ukRevGbp, { ukOnlyExtra: { gbp: PLANTED.icTooling.gbp, memo: PLANTED.icTooling.memo } });
  else intercompanyCharge(st, icDate, ukRevGbp);
  const usIcExpense = st.icPayableUsd - usExpBefore;
  if (['2025-11', '2026-02', '2026-05', '2026-08'].includes(pk)) settleIntercompany(st, businessDayOnOrBefore(addDays(end, -3), 'US'));
  // ---------------- month-end adjustments
  const holdDepreciation = sept && PLANTED.skipDepreciation;
  for (const fa of st.fixedAssets) {
    if (fa.remaining <= 0) continue;
    const amt = Math.min(fa.monthly, fa.remaining);
    fa.remaining -= amt;
    // September's lines stay "scheduled": the schedule-rollforward agent finds and posts them
    b.add('depreciation_lines', { fixed_asset_id: fa.id, period_key: pk, amount_minor: amt, status: holdDepreciation ? 'scheduled' : 'posted', journal_entry_id: null });
  }
  if (!holdDepreciation) depreciationEntries(st, pk);
  for (const pp of st.prepaid) {
    const line = pp.lines.get(pk);
    if (!line) continue;
    if (sept && PLANTED.skipPrepaid(pp.account)) continue;
    const jeId = b.je({ entity: pp.entity, date: end, type: 'recurring', memo: `Prepaid amortization – ${pk}`, source: 'system', sourceRef: `PPD-${pp.id}-${pk}`, preparedBy: 'system:schedules', approvedBy: 'system:schedules', route: 'system', lines: [{ account: pp.expense, debit: line.amount, department: pp.dept }, { account: pp.account, credit: line.amount }] });
    const row = b.list('prepaid_lines').find((x) => x.id === line.id)!;
    (row as Record<string, unknown>).status = 'posted';
    (row as Record<string, unknown>).journal_entry_id = jeId;
  }
  // ASC 842 operating lease: liability reduction and ROU amortization (straight-line cost sits in rent)
  b.je({ entity: 'BWL-US', date: end, type: 'recurring', memo: `Operating lease – ROU amortization ${pk}`, source: 'system', sourceRef: `LEASE-${pk}`, preparedBy: 'system:schedules', approvedBy: 'system:schedules', route: 'system', lines: [{ account: '2410', debit: 16_400_00 }, { account: '1610', credit: 15_650_00 }, { account: '6100', credit: 750_00, department: 'GA' }] });
  if (!sept) {
    const acc = payrollAccrual(st, 'BWL-US', pk);
    if (acc) jeAutoReversing(st, { entity: 'BWL-US', date: end, type: 'accrual', memo: `Accrue ${acc.days} unpaid payroll days (${acc.from} to ${end})`, source: 'manual', sourceRef: `PRACC-${pk}`, ...manual(st, 'sam', 'jordan'), autoReverseOn: periodStart(shiftPeriod(pk, 1)), lines: [...Object.entries(acc.byDept).map(([d, v]) => ({ account: '6000', debit: v, department: d })), { account: '2120', credit: acc.amount }] });
    fxRevaluation(st, pk);
    // bank-only items booked from the statement
    const fee = 45_00;
    const interest = Math.round(st.opening.usdCash * 0.00031);
    b.je({ entity: 'BWL-US', date: end, type: 'adjusting', memo: `Bank service charge – ${pk}`, source: 'manual', sourceRef: `BANKFEE-${pk}`, ...manual(st, 'sam', 'jordan'), lines: [{ account: '6900', debit: fee, department: 'GA' }, { account: '1010', credit: fee }] });
    b.je({ entity: 'BWL-US', date: end, type: 'adjusting', memo: `Interest earned – ${pk}`, source: 'manual', sourceRef: `INTEREST-${pk}`, ...manual(st, 'sam', 'jordan'), lines: [{ account: '1010', debit: interest }, { account: '7000', credit: interest }] });
    st.bankQueue.push({ entity: 'BWL-US', date: end, amount: -fee, description: 'ACCOUNT ANALYSIS SERVICE CHARGE', counterparty: null, reference: null, typeCode: '698' });
    st.bankQueue.push({ entity: 'BWL-US', date: end, amount: interest, description: 'INTEREST CREDIT', counterparty: null, reference: null, typeCode: '354' });
    eliminations(st, pk, ukRevGbp, usIcExpense);
  }
}

function monthsSinceStart(pk: string): number {
  return periodRange(SCENARIO.historyStart, pk).length - 1;
}

function prepaidPurchase(st: HistoryState, vendorCode: string, date: string, amount: number, prepaidAcct: string, expense: string, dept: string, description: string, startKey: string, months: number) {
  const { b } = st;
  const v = VENDORS.find((x) => x.code === vendorCode)!;
  const bill = postBill(st, v, date, amount, { account: prepaidAcct, dept: null, description });
  const sched = b.add('prepaid_schedules', { entity_id: b.ent(v.entity), vendor_id: st.vendorIds.get(vendorCode)!, description, start_period: startKey, months, total_minor: amount, prepaid_account_id: b.acct(prepaidAcct), expense_account_id: b.acct(expense), department: dept, source_bill_id: bill.id, status: 'active' });
  const lines = new Map<string, { id: string; amount: number }>();
  const per = Math.round(amount / months);
  periodRange(startKey, shiftPeriod(startKey, months - 1)).forEach((pk, i) => {
    const amt = i === months - 1 ? amount - per * (months - 1) : per;
    const l = b.add('prepaid_lines', { prepaid_schedule_id: sched.id, period_key: pk, amount_minor: amt, status: 'scheduled', journal_entry_id: null });
    lines.set(pk, { id: l.id, amount: amt });
  });
  st.prepaid.push({ id: sched.id, entity: v.entity, account: prepaidAcct, expense, dept, lines });
}

export function depreciationEntries(st: HistoryState, pk: string, opts: { only?: string[] } = {}) {
  const { b } = st;
  for (const entity of ['BWL-US', 'BWL-UK']) {
    const byCat = new Map<string, Map<string, number>>();
    const lines = b.list('depreciation_lines').filter((l) => l.period_key === pk);
    for (const l of lines) {
      const fa = st.fixedAssets.find((x) => x.id === l.fixed_asset_id)!;
      if (fa.entity !== entity) continue;
      if (opts.only && !opts.only.includes(fa.category)) continue;
      const m = byCat.get(fa.category) ?? new Map<string, number>();
      m.set(fa.dept, (m.get(fa.dept) ?? 0) + (l.amount_minor as number));
      byCat.set(fa.category, m);
    }
    for (const [cat, depts] of byCat) {
      const total = [...depts.values()].reduce((s, x) => s + x, 0);
      const jeId = b.je({ entity, date: periodEnd(pk), type: 'recurring', memo: `Depreciation – ${cat.replace(/_/g, ' ')} – ${pk}`, source: 'system', sourceRef: `DEP-${entity}-${cat}-${pk}`, preparedBy: 'system:schedules', approvedBy: 'system:schedules', route: 'system', lines: [...[...depts.entries()].map(([d, v]) => ({ account: '6800', debit: v, department: d })), { account: '1590', credit: total }] });
      for (const l of lines) {
        const fa = st.fixedAssets.find((x) => x.id === l.fixed_asset_id)!;
        if (fa.entity === entity && fa.category === cat) (l as Record<string, unknown>).journal_entry_id = jeId;
      }
    }
  }
}

function yearEndClose(st: HistoryState, pk: string) {
  const { b } = st;
  const plAccounts = new Set(ACCOUNTS.filter((a) => a.cls === 'revenue' || a.cls === 'expense').map((a) => b.acct(a.code)));
  const headers = new Map(b.list('journal_entries').map((h) => [h.id, h]));
  for (const e of ENTITIES) {
    const entId = b.ent(e.code);
    const bal = new Map<string, Map<string | null, number>>();
    for (const l of b.list('journal_lines')) {
      if (!plAccounts.has(l.account_id)) continue;
      const h = headers.get(l.journal_entry_id);
      // lines of closing entries created for earlier entities in this loop are not in the snapshot
      if (!h || h.entity_id !== entId || (h.posting_date as string) > periodEnd(pk)) continue;
      const byDept = bal.get(l.account_id) ?? new Map<string | null, number>();
      byDept.set(l.department ?? null, (byDept.get(l.department ?? null) ?? 0) + (l.debit_minor ?? 0) - (l.credit_minor ?? 0));
      bal.set(l.account_id, byDept);
    }
    const lines: { account: string; debit?: number; credit?: number; department?: string | null }[] = [];
    let net = 0;
    for (const [acctId, byDept] of bal)
      for (const [dept, v] of byDept) {
        if (v === 0) continue;
        const code = ACCOUNTS.find((a) => b.acct(a.code) === acctId)!.code;
        net += v;
        lines.push(v > 0 ? { account: code, credit: v, department: requiresDept(code) ? (dept ?? 'GA') : null } : { account: code, debit: -v, department: requiresDept(code) ? (dept ?? 'GA') : null });
      }
    if (!lines.length) continue;
    lines.push(net > 0 ? { account: '3200', debit: net } : { account: '3200', credit: -net });
    b.je({ entity: e.code, date: periodEnd(pk), type: 'adjusting', memo: `FY${pk.slice(0, 4)} year-end close: income statement to retained earnings`, source: 'system', sourceRef: `YEC-${pk.slice(0, 4)}`, preparedBy: 'system:year-end', approvedBy: b.user('casey'), route: 'system', lines });
  }
}

// =============================================================================== october
function octoberToDate(st: HistoryState) {
  const { b } = st;
  // Oct 1–2: the August-style rhythm continues in the new month
  postDueReversals(st, '2026-10-01');
  for (const v of VENDORS.filter((x) => x.timing === 'start' && x.entity === 'BWL-US')) postBill(st, v, '2026-10-01', v.monthly!, { servicePeriod: ['2026-10-01', '2026-10-31'], payOn: v.terms === 0 ? '2026-10-01' : undefined });
  collectReceipts(st, '2026-10-01', SCENARIO.lastActivityDate);
  payBills(st, '2026-10-01', SCENARIO.lastActivityDate);
  cardActivity(st, 'BWL-US', '2026-10', { count: 9 });
  void b;
}

// =============================================================================== bank
function emitBank(st: HistoryState) {
  const { b } = st;
  for (const entity of ['BWL-US', 'BWL-UK'] as const) {
    const ba = st.bankAccount[entity]!;
    let balance = entity === 'BWL-US' ? st.opening.usdCash : st.opening.gbpCash;
    const lines = st.bankQueue.filter((x) => x.entity === entity).sort((x, y) => x.date.localeCompare(y.date) || x.description.localeCompare(y.description));
    const months = periodRange(SCENARIO.historyStart, periodKeyOf(SCENARIO.lastActivityDate));
    let seq = 0;
    for (const pk of months) {
      const monthLines = lines.filter((l) => periodKeyOf(l.date) === pk);
      const opening = balance;
      const rows = monthLines.map((l) => {
        seq++;
        balance += l.amount;
        const ext = `${entity === 'BWL-US' ? 'FH' : 'TB'}${l.date.replace(/-/g, '')}${String(seq).padStart(5, '0')}`;
        return { l, ext };
      });
      const partial = pk === periodKeyOf(SCENARIO.lastActivityDate);
      const to = partial ? SCENARIO.lastActivityDate : periodEnd(pk);
      // source document (real BAI2 / camt.053 file) with provenance for every line
      const content =
        entity === 'BWL-US'
          ? writeBai2({ senderId: 'FHBANK', receiverId: 'BRAMBLEWOOD', fileDate: addDays(to, 1), accountNumber: '000123454417', currency: 'USD', openingMinor: opening, closingMinor: balance, transactions: rows.map(({ l, ext }) => ({ date: l.date, amountMinor: l.amount, typeCode: l.typeCode, bankRef: ext, customerRef: l.reference, text: l.description })) })
          : writeCamt053({ messageId: `TB-STMT-${pk}`, createdAt: `${addDays(to, 1)}T06:00:00Z`, iban: 'GB29THMS20150912342208', currency: 'GBP', from: periodStart(pk), to, openingMinor: opening, closingMinor: balance, entries: rows.map(({ l, ext }) => ({ ref: ext, bookingDate: l.date, amountMinor: l.amount, info: l.description, counterparty: l.counterparty, endToEnd: l.reference, subFamily: l.amount > 0 ? 'RCDT' : 'ICDT' })) });
      const filename = entity === 'BWL-US' ? `first-harbor-4417-${pk}.bai` : `thameside-2208-${pk}.xml`;
      const doc = b.add('source_documents', { connector_id: null, kind: 'bank_statement', filename, mime: entity === 'BWL-US' ? 'text/plain' : 'application/xml', content, content_hash: sha256Hex(content), size_bytes: new TextEncoder().encode(content).length, received_at: `${addDays(to, 1)}T06:05:00.000Z`, uploaded_by: 'connector:bank-feed' });
      const batch = b.add('import_batches', { connector_id: CONNECTOR_IDS[entity === 'BWL-US' ? 'first-harbor-bai2' : 'thameside-camt053']!(b), source_document_id: doc.id, status: 'completed', records_total: rows.length, records_created: rows.length, records_skipped: 0, records_failed: 0, errors: [], imported_by: 'connector:bank-feed', started_at: `${addDays(to, 1)}T06:05:00.000Z`, finished_at: `${addDays(to, 1)}T06:05:02.000Z` });
      rows.forEach(({ l, ext }, i) => {
        b.add('bank_transactions', { entity_id: b.ent(entity), bank_account_id: ba.id, txn_date: l.date, value_date: l.date, amount_minor: l.amount, currency: ba.currency, description: l.description, counterparty: l.counterparty, reference: l.reference, type_code: l.typeCode, status: pk < SCENARIO.closeKey ? 'matched' : 'unmatched', injection_suspected: false, import_batch_id: batch.id, source_document_id: doc.id, source_line: i + 1, external_id: ext });
      });
      b.add('bank_statements', { bank_account_id: ba.id, period_key: pk, statement_date: to, opening_balance_minor: opening, closing_balance_minor: balance, import_batch_id: batch.id, source_document_id: doc.id });
    }
  }
  // card feed source document for the open month (provenance for card lines)
  const cardRows = b.list('card_transactions').filter((c) => periodKeyOf(c.txn_date as string) === SCENARIO.closeKey);
  const csv = toCsv([['transaction_id', 'card_last4', 'transaction_date', 'post_date', 'merchant', 'mcc', 'amount', 'currency', 'memo'], ...cardRows.map((c) => [c.external_id as string, st.cardIds.find((x) => x.id === c.card_id)!.last4, c.txn_date as string, c.post_date as string, c.merchant_name as string, (c.mcc as string) ?? '', ((c.amount_minor as number) / 100).toFixed(2), c.currency as string, (c.memo as string | null) ?? ''])]);
  const doc = b.add('source_documents', { connector_id: null, kind: 'card_feed', filename: `keystone-card-feed-${SCENARIO.closeKey}.csv`, mime: 'text/csv', content: csv, content_hash: sha256Hex(csv), size_bytes: csv.length, received_at: '2026-10-01T06:10:00.000Z', uploaded_by: 'connector:card-feed' });
  const batch = b.add('import_batches', { connector_id: CONNECTOR_IDS['keystone-card-csv']!(b), source_document_id: doc.id, status: 'completed', records_total: cardRows.length, records_created: cardRows.length, records_skipped: 0, records_failed: 0, errors: [], imported_by: 'connector:card-feed', started_at: '2026-10-01T06:10:00.000Z', finished_at: '2026-10-01T06:10:01.000Z' });
  cardRows.forEach((c, i) => Object.assign(c, { source_document_id: doc.id, import_batch_id: batch.id, source_line: i + 2 }));
}

const connectorCache = new Map<string, string>();
const CONNECTOR_IDS: Record<string, (b: SeedBuilder) => string> = Object.fromEntries(
  ['first-harbor-bai2', 'thameside-camt053', 'keystone-card-csv', 'erp-gl-csv', 'ap-inbox-json', 'pebble-payroll-csv', 'generic-ofx', 'generic-bank-csv'].map((k) => [
    k,
    (b: SeedBuilder) => {
      const cached = connectorCache.get(`${b.tenantId}:${k}`);
      if (cached && b.list('connectors').some((c) => c.id === cached)) return cached;
      const def = CONNECTOR_DEFS[k]!;
      const row = b.add('connectors', { key: k, kind: def.kind, format: def.format, name: def.name, entity_id: def.entity ? b.ent(def.entity) : null, config: { adapter: def.adapter, ...(def.bankLast4 ? { bankLast4: def.bankLast4 } : {}) }, status: 'active', last_import_at: '2026-10-02T06:05:02.000Z' });
      connectorCache.set(`${b.tenantId}:${k}`, row.id);
      return row.id;
    },
  ]),
);

const CONNECTOR_DEFS: Record<string, { kind: 'bank_feed' | 'card_feed' | 'erp_gl' | 'ap' | 'payroll'; format: 'bai2' | 'camt053' | 'csv' | 'json' | 'ofx'; name: string; adapter: string; entity?: string; bankLast4?: string }> = {
  'first-harbor-bai2': { kind: 'bank_feed', format: 'bai2', name: 'First Harbor Bank – BAI2 daily feed', adapter: 'bank:bai2', entity: 'BWL-US', bankLast4: '4417' },
  'thameside-camt053': { kind: 'bank_feed', format: 'camt053', name: 'Thameside Bank – ISO 20022 camt.053', adapter: 'bank:camt053', entity: 'BWL-UK', bankLast4: '2208' },
  'keystone-card-csv': { kind: 'card_feed', format: 'csv', name: 'Keystone corporate card feed', adapter: 'card:csv', entity: 'BWL-US' },
  'erp-gl-csv': { kind: 'erp_gl', format: 'csv', name: 'Legacy ERP journal export', adapter: 'erp_gl:csv', entity: 'BWL-US' },
  'ap-inbox-json': { kind: 'ap', format: 'json', name: 'AP inbox (captured bills)', adapter: 'ap:json', entity: 'BWL-US' },
  'pebble-payroll-csv': { kind: 'payroll', format: 'csv', name: 'Pebble Payroll register', adapter: 'payroll:csv', entity: 'BWL-US' },
  'generic-ofx': { kind: 'bank_feed', format: 'ofx', name: 'Any bank – OFX upload', adapter: 'bank:ofx', entity: 'BWL-US', bankLast4: '4417' },
  'generic-bank-csv': { kind: 'bank_feed', format: 'csv', name: 'Any bank – CSV upload', adapter: 'bank:csv', entity: 'BWL-US', bankLast4: '4417' },
};

function connectors(st: HistoryState) {
  for (const k of Object.keys(CONNECTOR_DEFS)) CONNECTOR_IDS[k]!(st.b);
}

// =============================================================================== budgets
function budgets(st: HistoryState) {
  const { b } = st;
  const headers = new Map(b.list('journal_entries').map((h) => [h.id, h]));
  const plCodes = new Map(ACCOUNTS.filter((a) => a.cls === 'revenue' || a.cls === 'expense').map((a) => [b.acct(a.code), a]));
  for (const e of ENTITIES.filter((x) => x.kind === 'legal')) {
    const entId = b.ent(e.code);
    // run-rate by account+department over the 12 closed months (excluding year-end close and opening)
    const sums = new Map<string, number>();
    for (const l of b.list('journal_lines')) {
      const a = plCodes.get(l.account_id);
      if (!a) continue;
      const h = headers.get(l.journal_entry_id)!;
      if (h.entity_id !== entId || h.entry_type === 'opening' || (h.source_ref as string | null)?.startsWith('YEC-') || (h.posting_date as string) >= `${SCENARIO.closeKey}-01`) continue;
      const k = `${a.code}|${l.department ?? ''}`;
      const natural = a.cls === 'revenue' ? (l.credit_minor ?? 0) - (l.debit_minor ?? 0) : (l.debit_minor ?? 0) - (l.credit_minor ?? 0);
      sums.set(k, (sums.get(k) ?? 0) + natural);
    }
    for (const fy of [2025, 2026]) {
      const bud = b.add('budgets', { entity_id: entId, name: `FY${fy} Operating plan`, kind: 'budget', fiscal_year: fy, version: 1, status: 'approved', currency: e.currency, approved_by: b.user('riley') });
      const months = fy === 2025 ? periodRange('2025-09', '2025-12') : periodRange('2026-01', '2026-12');
      for (const [k, total] of sums) {
        const [code, dept] = k.split('|') as [string, string];
        let monthly = Math.round(total / 12 / 100) * 100;
        if (code === '6310') {
          // events are budgeted in Marketing only: one regional workshop a month in the US
          if (e.code !== 'BWL-US' || dept !== 'MKTG') continue;
          monthly = 12_000_00;
        }
        if (code === '5000' && e.code === 'BWL-US') monthly = 36_500_00;
        if (code === '4900' || code === '6950' || code === '7110' || code === '7100' || code === '7120') continue;
        if (Math.abs(monthly) < 1_000_00) continue;
        for (const pk of months) {
          const seasonal = code.startsWith('4') ? 1 + (Number(pk.slice(5)) - 6) * 0.004 : 1;
          b.add('budget_lines', { budget_id: bud.id, account_id: b.acct(code), department: dept || null, period_key: pk, amount_minor: Math.round((monthly * seasonal * (1 + b.rng.normal(0, 0.03))) / 100) * 100, driver_note: code === '6310' ? 'Events: one regional workshop per month' : null });
        }
      }
    }
  }
}

// =============================================================================== close
function closeManagement(st: HistoryState, now: string) {
  const { b } = st;
  const tpl = b.add('close_templates', { name: 'Monthly close – Bramblewood group', description: 'WD-2 to WD+5 checklist with agent skills bound to tasks.', is_active: true });
  const tplTaskIds = new Map<string, string>();
  CLOSE_TEMPLATE.forEach((t, i) => tplTaskIds.set(t.key, b.add('close_template_tasks', { template_id: tpl.id, key: t.key, title: t.title, description: t.description, category: t.category, workday_offset: t.wd, owner_role: t.owner, reviewer_role: t.reviewer, skill_key: t.skill, entity_scope: t.scope, depends_on: t.deps, evidence_required: !!t.evidence, sort_order: i }).id));
  // history: closed periods (closed WD+4/5)
  for (const pk of periodRange(SCENARIO.historyStart, shiftPeriod(SCENARIO.closeKey, -1))) {
    const closeDay = workdayDate(pk, pk >= '2026-05' ? 4 : 5);
    b.add('close_periods', { period_key: pk, template_id: tpl.id, status: 'closed', target_close_date: workdayDate(pk, 5), started_at: `${workdayDate(pk, -2)}T15:00:00.000Z`, closed_at: `${closeDay}T19:30:00.000Z`, closed_by: b.user('casey') });
  }
  const cp = b.add('close_periods', { period_key: SCENARIO.closeKey, template_id: tpl.id, status: 'in_progress', target_close_date: workdayDate(SCENARIO.closeKey, 5), started_at: `${workdayDate(SCENARIO.closeKey, -2)}T15:00:00.000Z`, closed_at: null, closed_by: null });
  const ownerOf: Record<string, string> = { staff_accountant: 'sam', ap_specialist: 'priya', senior_accountant: 'jordan', controller: 'casey', cfo: 'riley', fpa_analyst: 'devon' };
  const done: Record<string, { by: string; at: string }> = {
    'cutoff-reminder': { by: 'casey', at: '2026-09-28T16:00:00.000Z' },
    'po-review': { by: 'priya', at: '2026-09-30T21:00:00.000Z' },
    'import-feeds': { by: 'sam', at: '2026-10-01T14:30:00.000Z' },
  };
  const taskIds = new Map<string, string>();
  CLOSE_TEMPLATE.forEach((t, i) => {
    const d = done[t.key];
    const row = b.add('close_tasks', {
      close_period_id: cp.id, template_task_id: tplTaskIds.get(t.key)!, key: t.key, entity_id: null, title: t.title, description: t.description, category: t.category, workday_offset: t.wd, due_date: workdayDate(SCENARIO.closeKey, t.wd),
      owner_id: b.user(ownerOf[t.owner]!), reviewer_id: t.reviewer ? b.user(ownerOf[t.reviewer]!) : null, owner_role: t.owner, reviewer_role: t.reviewer, skill_key: t.skill,
      status: d ? 'done' : t.key === 'code-transactions' ? 'in_progress' : 'not_started', blocked_reason: null, agent_run_id: null, completed_by: d ? b.user(d.by) : null, completed_at: d?.at ?? null, reviewed_by: null, reviewed_at: null,
      notes: t.key === 'import-feeds' ? 'Bank (BAI2, camt.053) and card feeds imported automatically at 06:05.' : null, sort_order: i,
    });
    taskIds.set(t.key, row.id);
  });
  for (const t of CLOSE_TEMPLATE) for (const dep of t.deps) b.add('close_task_dependencies', { task_id: taskIds.get(t.key)!, depends_on_task_id: taskIds.get(dep)! });
  void now;
}

export { isWeekend, spotOn, addCardTxn, convert };

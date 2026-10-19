import type { SkillPackage } from '../../../framework/skills/manifest';
import { currentIdGenerator, setIdGenerator, setStoreClock, storeClock } from '../../../framework/store/defaults';
import { ManualClock } from '../../../framework/util/clock';
import { addDays, addMonths, periodEnd, periodRange, periodStart } from '../../../framework/util/dates';
import { deterministicIds } from '../../../framework/util/ids';
import { sha256Hex } from '../../../framework/util/sha256';
import { normalize } from '../../../framework/util/text';
import { BusinessCalendar, US_BANK_HOLIDAYS_2025_2027 } from '../../../framework/util/workdays';
import { importDocument } from '../connectors/importer';
import { writeBai2, writeCamt053, writeOfx } from '../connectors/bank-formats';
import { CLOSE_TEMPLATE, DEFAULT_POLICY_TEXT, REC_TEMPLATE } from '../close/template';
import { audit } from '../domain/audit';
import { makeContext, systemActor } from '../domain/context';
import { DEFAULT_SOD_RULES, loadActor, ROLE_DEFS } from '../domain/rbac';
import { closeOntology, type AccountInfo } from '../ontology';
import type { EkDb } from '../store';
import { buildPackageContent, contentHash } from '../services/package';
import { refreshRecsForPeriod } from '../services/recs';
import { registerSkills } from '../services/skills';
import { BANK_ACCOUNTS, generateScenario, type BankEvent, type BankKey, type EntityCode, type JeSpec, type SeedDataset } from './generate';
import { ACCOUNTS, CLASSES, CURRENCIES, DEPARTMENTS, ENTITIES, FS_LINES, GBPUSD_CLOSING, GBPUSD_HISTORICAL, LOCATIONS, PROJECTS, SCENARIO, USERS, type UserKey } from './scenario';

/**
 * Loads the fictional Kitewell Labs scenario into an empty database through the same store
 * port the application uses (so Postgres triggers / memory hooks validate every row):
 *   1. reference data, roles, users, SoD rules, chart of accounts, periods, connectors, skills
 *   2. twelve closed months of ledger history (inserted as drafts, then posted period by period)
 *   3. subledgers, bank statements with matched history, reviewed reconciliations, completed
 *      close calendars, locked periods and approved close packages
 *   4. the open month: the close calendar for September 2026 and the source files imported
 *      through the real connectors on WD+1/WD+2 (bank BAI2/OFX/camt.053, card CSV, payroll
 *      CSV, AP bills CSV and a legacy-ERP journal export) with the planted issues.
 */
export interface LoadScenarioOptions {
  skills: SkillPackage[];
  /** scrypt hashes per demo user (server). Omit in the static demo (persona sign-in). */
  passwordHashes?: Partial<Record<UserKey, string>>;
  progress?: (stage: string) => void;
  /** Generate close packages for history months (default true). */
  historyPackages?: boolean;
}

export interface ScenarioInfo {
  tenantId: string;
  openPeriod: string;
  asOf: string;
  users: Record<UserKey, string>;
  entities: Record<EntityCode, string>;
  counts: Record<string, number>;
}

type AnyRow = Record<string, unknown>;

function clean(row: AnyRow): AnyRow {
  const out: AnyRow = {};
  for (const [k, v] of Object.entries(row)) if (!k.startsWith('_') && v !== undefined) out[k] = v;
  return out;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const at = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;

export async function isSeeded(db: EkDb): Promise<boolean> {
  return (await db.count('tenant')) > 0;
}

export async function loadScenario(db: EkDb, opts: LoadScenarioOptions): Promise<ScenarioInfo> {
  const prevIds = currentIdGenerator();
  const prevClock = storeClock();
  const clock = new ManualClock('2025-09-01T15:00:00.000Z');
  setIdGenerator(deterministicIds(`${SCENARIO.seed}:loader`));
  setStoreClock(clock);
  try {
    return await load(db, opts, clock);
  } finally {
    setIdGenerator(prevIds);
    setStoreClock(prevClock);
  }
}

async function load(db: EkDb, opts: LoadScenarioOptions, clock: ManualClock): Promise<ScenarioInfo> {
  const progress = opts.progress ?? (() => undefined);
  progress('Generating the Kitewell Labs scenario');
  const data: SeedDataset = generateScenario();
  const T = data.ids.tenant;
  const ids = data.ids;
  const ins = <N extends Parameters<EkDb['insertMany']>[0]>(table: N, rows: AnyRow[]) => insertAll(db, table, rows);
  const counts: Record<string, number> = {};
  const cal = new BusinessCalendar(US_BANK_HOLIDAYS_2025_2027);
  const OPEN = SCENARIO.openPeriod;
  const history = periodRange(SCENARIO.firstPeriod, addMonths(OPEN, -1));
  const allPeriods = periodRange(SCENARIO.firstPeriod, SCENARIO.lastPeriod);
  const userId = (k: UserKey | null | undefined) => (k ? ids.users[k] : null);

  // ------------------------------------------------------------ reference data
  progress('Loading reference data');
  await db.insert('tenant', {
    id: T,
    name: SCENARIO.tenant.name,
    slug: SCENARIO.tenant.slug,
    timezone: SCENARIO.tenant.timezone,
    reporting_currency: SCENARIO.tenant.reporting_currency,
    settings: {
      materiality: SCENARIO.materiality,
      capitalizationThreshold: SCENARIO.capitalizationThreshold,
      prepaidThreshold: SCENARIO.prepaidThreshold,
      closeTargetWorkday: 5,
      autoContinue: true,
      fictional: true,
    },
    created_at: at('2025-08-20', '16:00'),
  });
  for (const c of CURRENCIES) if (!(await db.get('currency', c.code))) await db.insert('currency', c);
  const roleIds: Record<string, string> = {};
  for (const r of ROLE_DEFS) {
    let role = await db.findOne('role', { code: r.code });
    if (!role) {
      role = await db.insert('role', { code: r.code, name: r.name, description: r.description, rank: r.rank });
      await db.insertMany('role_permission', r.permissions.map((p) => ({ role_id: role!.id, permission: p })));
    }
    roleIds[r.code] = role.id;
  }
  for (const e of ENTITIES) {
    await db.insert('entity', { id: ids.entities[e.code], tenant_id: T, code: e.code, name: e.name, legal_name: e.legal_name, functional_currency: e.functional_currency, country: e.country, parent_entity_id: e.code === 'UK' ? ids.entities.US : null, is_elimination: e.is_elimination });
  }
  const dimTypes: Record<string, string> = {};
  for (const [code, name] of [['department', 'Department'], ['location', 'Location'], ['class', 'Class'], ['project', 'Project']] as const) {
    dimTypes[code] = (await db.insert('dimension_type', { tenant_id: T, code, name })).id;
  }
  await ins('dimension_value', DEPARTMENTS.map((d) => ({ id: ids.departments[d.code], tenant_id: T, dimension_type_id: dimTypes.department, code: d.code, name: d.name })));
  await ins('dimension_value', LOCATIONS.map((d) => ({ tenant_id: T, dimension_type_id: dimTypes.location, code: d.code, name: d.name })));
  await ins('dimension_value', CLASSES.map((d) => ({ tenant_id: T, dimension_type_id: dimTypes.class, code: d.code, name: d.name })));
  await ins('dimension_value', PROJECTS.map((d) => ({ tenant_id: T, dimension_type_id: dimTypes.project, code: d.code, name: d.name })));

  for (const u of USERS) {
    ids.users[u.key] = (
      await db.insert('app_user', {
        tenant_id: T,
        email: u.email,
        display_name: u.name,
        title: u.title,
        password_hash: opts.passwordHashes?.[u.key] ?? null,
        status: 'active',
        department_id: u.dept ? ids.departments[u.dept] : null,
        created_at: at('2025-08-20', '16:00'),
      })
    ).id;
  }
  for (const u of USERS) await db.insert('user_role', { tenant_id: T, user_id: ids.users[u.key], role_id: roleIds[u.role]!, entity_id: null, granted_by: ids.users.taylor });
  await ins('sod_rule', DEFAULT_SOD_RULES.map((r) => ({ tenant_id: T, code: r.code, name: r.name, description: r.description, kind: r.kind, permission_a: r.permission_a, permission_b: r.permission_b, severity: 'block', enabled: true })));

  // FX: GBP→USD closing, average and historical (equity) rates; EUR for completeness.
  const fx: AnyRow[] = [];
  for (const p of ['2025-08', ...allPeriods]) {
    const close = GBPUSD_CLOSING[p];
    if (close === undefined) continue;
    const prev = GBPUSD_CLOSING[addMonths(p, -1)] ?? close;
    fx.push({ tenant_id: T, from_ccy: 'GBP', to_ccy: 'USD', rate_date: periodEnd(p), rate_type: 'closing', rate: close, source: 'seed (fictional)' });
    fx.push({ tenant_id: T, from_ccy: 'GBP', to_ccy: 'USD', rate_date: periodEnd(p), rate_type: 'average', rate: Math.round(((prev + close) / 2) * 10_000) / 10_000, source: 'seed (fictional)' });
    fx.push({ tenant_id: T, from_ccy: 'EUR', to_ccy: 'USD', rate_date: periodEnd(p), rate_type: 'closing', rate: Math.round(close * 0.862 * 10_000) / 10_000, source: 'seed (fictional)' });
  }
  fx.push({ tenant_id: T, from_ccy: 'GBP', to_ccy: 'USD', rate_date: '2019-06-30', rate_type: 'historical', rate: GBPUSD_HISTORICAL, source: 'seed (fictional): capital contribution' });
  fx.push({ tenant_id: T, from_ccy: 'GBP', to_ccy: 'USD', rate_date: '2026-10-02', rate_type: 'spot', rate: 1.3405, source: 'seed (fictional)' });
  await ins('fx_rate', fx);

  const fsIds: Record<string, string> = {};
  for (const f of FS_LINES) fsIds[f.code] = (await db.insert('fs_line_item', { tenant_id: T, statement: f.statement, code: f.code, label: f.label, section: f.section, sort_order: f.sort, xbrl_element: f.xbrl, sign: f.sign })).id;
  await ins(
    'account',
    ACCOUNTS.map((a) => ({
      id: ids.accounts[a.code],
      tenant_id: T,
      code: a.code,
      name: a.name,
      account_class: a.cls,
      account_type: a.type,
      normal_balance: a.normal ?? (a.cls === 'asset' || a.cls === 'expense' ? 'debit' : 'credit'),
      fs_line_item_id: fsIds[a.fs],
      requires_department: !!a.dept,
      is_control_account: !!a.control,
      subledger: a.control ?? null,
      is_intercompany: !!a.ic,
      is_monetary: !!a.monetary,
      concept: a.concept ?? null,
      description: a.description ?? null,
    })),
  );
  const periodIds = new Map<string, string>(); // `${entityCode}:${period}` → id
  for (const e of ENTITIES) {
    for (const p of allPeriods) {
      const row = await db.insert('fiscal_period', { tenant_id: T, entity_id: ids.entities[e.code], period_key: p, fiscal_year: Number(p.slice(0, 4)), start_date: periodStart(p), end_date: periodEnd(p), status: 'open' });
      periodIds.set(`${e.code}:${p}`, row.id);
    }
  }
  await ins('holiday', US_BANK_HOLIDAYS_2025_2027.map((d) => ({ tenant_id: T, date: d, name: 'US bank holiday' })));
  for (const [key, b] of Object.entries(BANK_ACCOUNTS) as [BankKey, (typeof BANK_ACCOUNTS)[BankKey]][]) {
    await db.insert('bank_account', { id: ids.bankAccounts[key], tenant_id: T, entity_id: ids.entities[b.entity], name: b.name, institution: b.institution, account_mask: b.mask, currency: b.currency, gl_account_id: ids.accounts[b.gl]! });
  }
  const connectorIds: Record<string, string> = {};
  const connectors: { key: string; kind: string; name: string; entity?: EntityCode; bank?: BankKey; config?: AnyRow }[] = [
    { key: 'us-bai2', kind: 'bank_bai2', name: 'First Meridian — operating (BAI2 via SFTP)', entity: 'US', bank: 'US-OP' },
    { key: 'us-pay-ofx', kind: 'bank_ofx', name: 'First Meridian — payroll (OFX download)', entity: 'US', bank: 'US-PAY' },
    { key: 'uk-camt', kind: 'bank_camt053', name: 'Harbourline — GBP (ISO 20022 camt.053)', entity: 'UK', bank: 'UK-OP' },
    { key: 'us-cards', kind: 'card_csv', name: 'Corporate cards — US program', entity: 'US' },
    { key: 'uk-cards', kind: 'card_csv', name: 'Corporate cards — UK program', entity: 'UK' },
    { key: 'us-payroll', kind: 'payroll_csv', name: 'Paywell payroll register — US', entity: 'US' },
    { key: 'us-ap', kind: 'ap_bills_csv', name: 'AP inbox — vendor bills (US)', entity: 'US' },
    { key: 'erp', kind: 'erp_gl_json', name: 'Legacy ERP — manual journals export', config: { system: 'LegacyERP 9.4 (fictional)' } },
    { key: 'billing', kind: 'ar_invoices_csv', name: 'Billing system — invoices (US)', entity: 'US', config: { note: 'Invoices are synced nightly by the billing integration.' } },
  ];
  for (const c of connectors) {
    connectorIds[c.key] = (
      await db.insert('connector', {
        tenant_id: T,
        kind: c.kind as never,
        name: c.name,
        entity_id: c.entity ? ids.entities[c.entity] : null,
        bank_account_id: c.bank ? ids.bankAccounts[c.bank] : null,
        config: c.config ?? {},
        status: c.key === 'billing' ? 'paused' : 'active',
      })
    ).id;
  }
  const vendorRows = (data.rows.vendor ?? []).map((v) => ({ ...clean(v), created_by: ids.users.dana, updated_by: v.name === 'Sparrow Print & Signage' ? ids.users.dana : null }));
  await ins('vendor', vendorRows);
  await ins('customer', (data.rows.customer ?? []).map(clean));
  await ins('purchase_order', (data.rows.purchase_order ?? []).map((r) => ({ ...clean(r), created_by: ids.users.dana })));

  progress('Registering skills and policies');
  const sctx = makeContext(db, T, systemActor('Seed loader'), clock);
  await registerSkills(sctx, opts.skills, { createdBy: ids.users.casey, policyText: DEFAULT_POLICY_TEXT });

  // ---------------------------------------------------------------- ledger
  progress(`Posting ${data.journal.length} journal entries (12 closed months + September)`);
  validateJournal(data);
  const jeRows: AnyRow[] = [];
  const lineRows: AnyRow[] = [];
  for (const j of data.journal) {
    const ent = ENTITIES.find((e) => e.code === j.entity)!;
    jeRows.push({
      id: j.id,
      tenant_id: T,
      entity_id: ids.entities[j.entity],
      period_id: periodIds.get(`${j.entity}:${j.periodKey}`)!,
      period_key: j.periodKey,
      entry_number: j.number,
      entry_date: j.date,
      entry_type: j.type,
      status: 'draft',
      memo: j.memo,
      currency: ent.functional_currency,
      source: j.source,
      source_ref: j.sourceRef,
      reverses_entry_id: j.reversesId,
      auto_reverse_date: j.autoReverseDate,
      prepared_by: userId(j.preparedBy),
      approved_by: userId(j.approvedBy),
      approval_policy: j.policy,
      posted_at: j.postedAt,
      posted_by: userId(j.approvedBy),
      idempotency_key: `seed:${j.number}`,
      created_at: j.postedAt,
    });
    j.lines.forEach((l, i) =>
      lineRows.push({
        id: l.id,
        tenant_id: T,
        journal_entry_id: j.id,
        line_no: i + 1,
        account_id: ids.accounts[l.acct]!,
        debit: l.dr,
        credit: l.cr,
        memo: l.memo ?? null,
        department_id: l.dept ? ids.departments[l.dept]! : null,
        counterparty_entity_id: l.cp ? ids.entities[l.cp] : null,
        txn_currency: l.txnCcy ?? null,
        txn_amount: l.txnAmt ?? null,
        fx_rate: l.fx ?? null,
        source_type: l.src?.type ?? null,
        source_id: l.src?.id ?? null,
      }),
    );
  }
  await ins('journal_entry', jeRows);
  await ins('journal_line', lineRows);
  const byPeriod = new Map<string, JeSpec[]>();
  for (const j of data.journal) byPeriod.set(j.periodKey, [...(byPeriod.get(j.periodKey) ?? []), j]);
  for (const p of [...byPeriod.keys()].sort()) {
    const js = byPeriod.get(p)!;
    for (const group of [js.filter((j) => !j.reversesId), js.filter((j) => j.reversesId)]) {
      for (const c of chunks(group.map((j) => j.id), 400)) await db.updateWhere('journal_entry', { id: { in: c } }, { status: 'posted' });
    }
  }
  counts.journal_entries = jeRows.length;
  counts.journal_lines = lineRows.length;
  await ins('je_sequence', Object.entries(data.sequences).map(([k, n]) => {
    const [entity, period] = k.split(':');
    return { id: `${T}:je:${entity}:${period}`, tenant_id: T, next_value: n + 1 };
  }));

  // ------------------------------------------------------------ subledgers
  progress('Loading subledgers (AP, AR, cards, payroll, prepaids, fixed assets)');
  for (const table of ['bill', 'vendor_payment', 'invoice', 'customer_receipt', 'card_transaction', 'payroll_run', 'payroll_line', 'prepaid_schedule', 'prepaid_line', 'fixed_asset', 'depreciation_line'] as const) {
    const rows = (data.rows[table] ?? []).map(clean);
    if (table === 'vendor_payment') for (const r of rows) r.created_by = ids.users.dana;
    if (table === 'vendor_payment') for (const r of rows) if (r.status === 'issued' && (r.payment_date as string) < periodStart(OPEN)) r.status = 'cleared';
    await ins(table, rows);
    counts[table] = rows.length;
  }

  // ------------------------------------------------------------ bank history
  progress('Loading bank statements and matched history');
  const historyRecIds = await loadBankHistory(db, data, history, connectorIds, counts);

  // ------------------------------------------------------- budgets (FY2025/26)
  await loadBudgets(db, data, allPeriods);

  // ------------------------------------------------------- closed months
  progress('Recording twelve closed months (calendars, reconciliations, sign-offs)');
  const balances = runningBalances(data);
  for (const p of history) {
    await loadClosedMonth(db, data, p, cal, balances, historyRecIds, clock);
    for (const e of ENTITIES) {
      const pid = periodIds.get(`${e.code}:${p}`)!;
      const soft = at(cal.dateOf(p, 4), '23:30');
      const hard = at(cal.dateOf(p, 5), '23:00');
      await db.update('fiscal_period', pid, { status: 'soft_close', soft_closed_at: soft, soft_closed_by: ids.users.casey });
      await db.update('fiscal_period', pid, { status: 'hard_close', hard_closed_at: hard, hard_closed_by: ids.users.casey });
    }
  }
  if (opts.historyPackages !== false) {
    progress('Building close packages for the closed months');
    const pctx = makeContext(db, T, systemActor('Seed loader'), clock);
    for (const p of history) {
      clock.set(at(cal.dateOf(p, 5), '20:00'));
      const content = await buildPackageContent(pctx, p);
      const hash = contentHash(content);
      const pkg = await db.insert('close_package', {
        tenant_id: T,
        period_key: p,
        version: 1,
        status: 'final',
        content: content as unknown as Record<string, unknown>,
        content_hash: hash,
        generated_by: ids.users.casey,
        generated_at: at(cal.dateOf(p, 5), '20:00'),
        approved_by: ids.users.jordan,
        approved_at: at(cal.dateOf(p, 5), '22:30'),
      });
      await db.insert('signoff', { tenant_id: T, subject_type: 'close_package', subject_id: pkg.id, role: 'approver', user_id: ids.users.jordan, signed_at: at(cal.dateOf(p, 5), '22:30'), statement: `I approve the ${p} close package.`, content_hash: hash });
    }
  }

  // ------------------------------------------------------- the open month
  progress('Opening the September 2026 close');
  const cycle = await db.insert('close_cycle', { tenant_id: T, period_key: OPEN, status: 'in_progress', target_workday: 5, started_at: at('2026-10-01', '15:00'), created_at: at('2026-09-28', '16:00') });
  const taskIds = await insertTasks(db, T, cycle.id, OPEN, cal, ids, 'open');
  for (const r of REC_TEMPLATE) {
    await db.insert('reconciliation', {
      tenant_id: T,
      entity_id: ids.entities[r.entity],
      period_key: OPEN,
      account_id: ids.accounts[r.account]!,
      rec_type: r.type,
      bank_account_id: r.bank ? ids.bankAccounts[r.bank] : null,
      counterparty_entity_id: r.counterparty ? ids.entities[r.counterparty] : null,
      status: 'not_started',
      risk: r.risk,
      tolerance: r.tolerance,
      notes: r.title,
      created_at: at('2026-10-01', '15:00'),
      updated_at: at('2026-10-01', '15:00'),
    });
  }

  progress('Importing September files through the connectors');
  const fileTimes: Record<string, string> = {
    'first-meridian-operating-2026-09.bai2': at('2026-10-01', '15:05'),
    'first-meridian-payroll-2026-09.ofx': at('2026-10-01', '15:07'),
    'harbourline-gbp-2026-09.camt053.xml': at('2026-10-01', '15:09'),
    'card-feed-us-2026-09.csv': at('2026-10-01', '15:12'),
    'card-feed-uk-2026-09.csv': at('2026-10-01', '15:13'),
    'legacy-erp-manual-journals-2026-09.json': at('2026-10-01', '15:20'),
    'paywell-register-2026-09-18.csv': at('2026-10-01', '16:00'),
    'first-meridian-operating-2026-10-02-current-day.bai2': at('2026-10-02', '15:00'),
    'ap-bills-received-2026-10-01.csv': at('2026-10-02', '15:30'),
  };
  const files = [...data.files].sort((a, b) => (fileTimes[a.filename] ?? '').localeCompare(fileTimes[b.filename] ?? ''));
  for (const f of files) {
    clock.set(fileTimes[f.filename] ?? at('2026-10-01', '15:30'));
    const actor = await loadActor(db, T, ids.users[f.importedBy], { ip: null });
    const ictx = makeContext(db, T, actor, clock);
    const res = await importDocument(ictx, { connectorId: connectorIds[f.connector]!, filename: f.filename, content: f.content });
    counts[`import:${f.filename}`] = res.created;
  }
  clock.set(at('2026-10-01', '17:30'));
  await db.update('close_task', taskIds.T01!, { status: 'ready_for_review', prepared_by: ids.users.sam, prepared_at: at('2026-10-01', '17:30') });
  await db.insert('signoff', { tenant_id: T, subject_type: 'close_task', subject_id: taskIds.T01!, role: 'preparer', user_id: ids.users.sam, signed_at: at('2026-10-01', '17:30'), statement: 'All September source files imported; record counts agree to the source systems.', content_hash: null });
  clock.set(at('2026-10-02', '15:45'));
  await db.update('close_task', taskIds.T01!, { status: 'complete', reviewed_by: ids.users.priya, reviewed_at: at('2026-10-02', '15:45'), completed_at: at('2026-10-02', '15:45') });
  await db.insert('signoff', { tenant_id: T, subject_type: 'close_task', subject_id: taskIds.T01!, role: 'reviewer', user_id: ids.users.priya, signed_at: at('2026-10-02', '15:45'), statement: 'Reviewed import logs; no errors.', content_hash: null });

  clock.set(at('2026-10-02', '15:50'));
  const octx = makeContext(db, T, systemActor('Seed loader'), clock);
  await refreshRecsForPeriod(octx, OPEN);
  await audit(octx, { action: 'seed.loaded', subjectType: 'tenant', subjectId: T, data: { scenario: SCENARIO.seed, fictional: true, openPeriod: OPEN, history: `${history[0]}..${history[history.length - 1]}`, journalEntries: counts.journal_entries } });

  progress('Ready');
  return { tenantId: T, openPeriod: OPEN, asOf: SCENARIO.asOf, users: ids.users, entities: ids.entities, counts };
}

async function insertAll(db: EkDb, table: Parameters<EkDb['insertMany']>[0], rows: AnyRow[]): Promise<void> {
  for (const c of chunks(rows, 500)) await db.insertMany(table, c as never);
}

/** Validate every generated entry against the ontology before it touches the database. */
function validateJournal(data: SeedDataset): void {
  const ontology = closeOntology();
  const accounts = new Map<string, AccountInfo>(
    ACCOUNTS.map((a) => [
      data.ids.accounts[a.code]!,
      {
        id: data.ids.accounts[a.code]!,
        code: a.code,
        name: a.name,
        accountClass: a.cls,
        normalBalance: a.normal ?? (a.cls === 'asset' || a.cls === 'expense' ? 'debit' : 'credit'),
        isPostable: true,
        isActive: true,
        requiresDepartment: !!a.dept,
        isControlAccount: !!a.control,
        isIntercompany: !!a.ic,
        isMonetary: !!a.monetary,
        subledger: a.control ?? null,
        concept: a.concept ?? null,
      },
    ]),
  );
  const byId = new Map(data.journal.map((j) => [j.id, j]));
  const problems: string[] = [];
  for (const j of data.journal) {
    const ent = ENTITIES.find((e) => e.code === j.entity)!;
    const draft = {
      entityId: data.ids.entities[j.entity],
      entryDate: j.date,
      periodKey: j.periodKey,
      entryType: j.type,
      memo: j.memo,
      currency: ent.functional_currency,
      autoReverseDate: j.autoReverseDate,
      reversesEntryId: j.reversesId,
      lines: j.lines.map((l) => ({
        accountId: data.ids.accounts[l.acct]!,
        debit: l.dr,
        credit: l.cr,
        departmentId: l.dept ? data.ids.departments[l.dept]! : null,
        counterpartyEntityId: l.cp ? data.ids.entities[l.cp] : null,
        txnCurrency: l.txnCcy,
        txnAmount: l.txnAmt,
        fxRate: l.fx,
      })),
    };
    const orig = j.reversesId ? byId.get(j.reversesId) : undefined;
    const res = ontology.validate('ek:JournalEntry', draft, {
      accounts,
      entity: { id: data.ids.entities[j.entity], code: j.entity, functionalCurrency: ent.functional_currency, isElimination: ent.is_elimination },
      period: { key: j.periodKey, status: 'open', startDate: periodStart(j.periodKey), endDate: periodEnd(j.periodKey) },
      actorRoles: [],
      source: j.source,
      preparedBy: j.preparedBy,
      approvedBy: j.approvedBy,
      original: orig ? { entityId: data.ids.entities[orig.entity], entryDate: orig.date, status: 'posted', reversedByEntryId: null, lines: orig.lines.map((l) => ({ accountId: data.ids.accounts[l.acct]!, debit: l.dr, credit: l.cr })) } : undefined,
    } as never, { skip: ['AX-ACC-04'] });
    if (!res.ok) problems.push(`${j.number} ${j.memo}: ${res.violations.filter((v) => v.severity === 'error').map((v) => `${v.axiomId} ${v.message}`).join('; ')}`);
  }
  if (problems.length) throw new Error(`Seed journal violates the ontology:\n${problems.slice(0, 10).join('\n')}`);
}

/** Cumulative ledger balances per entity/account through each period (debit − credit). */
function runningBalances(data: SeedDataset): (entity: EntityCode, acct: string, through: string) => number {
  const net = new Map<string, number>();
  for (const j of data.journal) for (const l of j.lines) net.set(`${j.entity}|${l.acct}|${j.periodKey}`, (net.get(`${j.entity}|${l.acct}|${j.periodKey}`) ?? 0) + l.dr - l.cr);
  const periods = [...new Set(data.journal.map((j) => j.periodKey))].sort();
  return (entity, acct, through) => periods.filter((p) => p <= through).reduce((s, p) => s + (net.get(`${entity}|${acct}|${p}`) ?? 0), 0);
}

async function loadBankHistory(db: EkDb, data: SeedDataset, history: string[], connectorIds: Record<string, string>, counts: Record<string, number>): Promise<Map<string, string>> {
  const T = data.ids.tenant;
  const ids = data.ids;
  const recIds = new Map<string, string>(); // `${bank}:${period}` → reconciliation id
  const glLineOwner = new Map<string, BankEvent[]>();
  for (const e of data.bankEvents) for (const g of e.glLineIds) glLineOwner.set(g, [...(glLineOwner.get(g) ?? []), e]);
  const lineAmount = new Map<string, number>();
  for (const j of data.journal) for (const l of j.lines) lineAmount.set(l.id, l.dr - l.cr);
  let txCount = 0;
  let matchCount = 0;
  for (const bank of Object.keys(BANK_ACCOUNTS) as BankKey[]) {
    const meta = BANK_ACCOUNTS[bank];
    let balance = data.bankOpening[bank];
    for (const p of history) {
      const evs = data.bankEvents.filter((e) => e.bank === bank && e.date >= periodStart(p) && e.date <= periodEnd(p)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
      const opening = balance;
      const closing = opening + evs.reduce((s, e) => s + e.amount, 0);
      balance = closing;
      const content =
        bank === 'US-OP'
          ? writeBai2({ sender: 'FMBANKUS', receiver: 'KITEWELL', created: addDays(periodEnd(p), 1), accountNumber: '000004821', currency: 'USD', asOf: periodEnd(p), opening, closing, lines: evs.map((e, i) => ({ date: e.date, amount: e.amount, typeCode: e.type, bankRef: `FMB${e.date.replace(/-/g, '').slice(2)}${String(i + 1).padStart(4, '0')}`, customerRef: e.ref, text: e.text })) })
          : bank === 'US-PAY'
            ? writeOfx({ bankId: '121000358', accountId: '000007730', currency: 'USD', from: periodStart(p), to: periodEnd(p), closing, txns: evs.map((e, i) => ({ date: e.date, amount: e.amount, fitid: `FMB7730${e.date.replace(/-/g, '')}${i}`, name: e.text.slice(0, 32), memo: e.text, type: e.amount > 0 ? 'XFER' : 'DIRECTDEBIT' })) })
            : writeCamt053({ msgId: `HRBL-STMT-${p.replace('-', '')}`, created: addDays(periodEnd(p), 1), iban: meta.mask, currency: 'GBP', from: periodStart(p), to: periodEnd(p), opening, closing, entries: evs.map((e, i) => ({ date: e.date, amount: e.amount, ref: e.ref, svcrRef: `HRBL${e.date.replace(/-/g, '')}${String(i).padStart(3, '0')}`, party: e.text.replace(/ BACS$/, '').slice(0, 60), remittance: e.text, code: e.type })) });
      const filename = bank === 'US-OP' ? `first-meridian-operating-${p}.bai2` : bank === 'US-PAY' ? `first-meridian-payroll-${p}.ofx` : `harbourline-gbp-${p}.camt053.xml`;
      const connectorId = connectorIds[bank === 'US-OP' ? 'us-bai2' : bank === 'US-PAY' ? 'us-pay-ofx' : 'uk-camt']!;
      const received = at(addDays(periodEnd(p), 1), '15:05');
      const sha = sha256Hex(content);
      const doc = await db.insert('source_document', { tenant_id: T, connector_id: connectorId, filename, media_type: bank === 'UK-OP' ? 'application/xml' : bank === 'US-PAY' ? 'application/x-ofx' : 'text/plain', sha256: sha, size_bytes: new TextEncoder().encode(content).length, content, received_at: received, received_by: ids.users.sam, parse_status: 'parsed', record_count: evs.length });
      const batch = await db.insert('import_batch', { tenant_id: T, connector_id: connectorId, source_document_id: doc.id, status: 'completed', created_count: evs.length, duplicate_count: 0, error_count: 0, errors: [], idempotency_key: `${connectorId}:${sha}`, started_at: received, finished_at: received, started_by: ids.users.sam });
      const stmt = await db.insert('bank_statement', { tenant_id: T, bank_account_id: ids.bankAccounts[bank], period_key: p, statement_start: periodStart(p), statement_end: periodEnd(p), opening_balance: opening, closing_balance: closing, source_document_id: doc.id, import_batch_id: batch.id, created_at: received });
      const rec = REC_TEMPLATE.find((r) => r.bank === bank)!;
      const recRow = await db.insert('reconciliation', {
        tenant_id: T,
        entity_id: ids.entities[meta.entity],
        period_key: p,
        account_id: ids.accounts[meta.gl]!,
        rec_type: 'bank',
        bank_account_id: ids.bankAccounts[bank],
        status: 'not_started',
        gl_balance: closing,
        comparison_balance: closing,
        risk: rec.risk,
        tolerance: rec.tolerance,
        notes: rec.title,
        created_at: received,
        updated_at: received,
      });
      recIds.set(`${bank}:${p}`, recRow.id);
      const seen = new Map<string, number>();
      const txIds = new Map<string, string>();
      const txRows = evs.map((e) => {
        const base = `${ids.bankAccounts[bank]}|${e.date}|${e.amount}|${e.ref}|${normalize(e.text)}`;
        const occ = (seen.get(base) ?? 0) + 1;
        seen.set(base, occ);
        const id = deterministicUuid(`bank-tx:${e.id}`);
        txIds.set(e.id, id);
        return { id, tenant_id: T, bank_account_id: ids.bankAccounts[bank], statement_id: stmt.id, posted_date: e.date, value_date: e.date, amount: e.amount, description: e.text, reference: e.ref, counterparty: null, type_code: e.type, external_id: e.ref, status: 'matched', dedupe_hash: sha256Hex(`${base}|${occ}`), source_document_id: doc.id, import_batch_id: batch.id, source_line: null, created_at: received };
      });
      await insertAll(db, 'bank_transaction', txRows);
      txCount += txRows.length;
      // Group events that share ledger lines into one match (many→one / one→many).
      const done = new Set<string>();
      const matches: AnyRow[] = [];
      const items: AnyRow[] = [];
      for (const e of evs) {
        if (done.has(e.id) || !e.glLineIds.length) continue;
        const group = new Set<BankEvent>([e]);
        const lines = new Set<string>(e.glLineIds);
        let grew = true;
        while (grew) {
          grew = false;
          for (const l of [...lines]) for (const other of glLineOwner.get(l) ?? []) if (!group.has(other) && other.bank === bank) {
            group.add(other);
            for (const x of other.glLineIds) lines.add(x);
            grew = true;
          }
        }
        for (const g of group) done.add(g.id);
        const nb = group.size;
        const nl = lines.size;
        const matchId = deterministicUuid(`match:${e.id}`);
        matches.push({ id: matchId, tenant_id: T, reconciliation_id: recRow.id, match_type: nb === 1 && nl === 1 ? 'exact' : nb > 1 && nl === 1 ? 'many_to_one' : nb === 1 ? 'one_to_many' : 'many_to_many', confidence: 1, status: 'accepted', rationale: `Matched during the ${p} close.`, accepted_by: ids.users.sam, accepted_at: at(addDays(periodEnd(p), 2), '18:00'), created_by_type: 'system', created_at: at(addDays(periodEnd(p), 2), '18:00') });
        for (const g of group) items.push({ tenant_id: T, match_id: matchId, side: 'bank', record_type: 'bank_transaction', record_id: txIds.get(g.id)!, amount: g.amount, active: true });
        for (const l of lines) items.push({ tenant_id: T, match_id: matchId, side: 'ledger', record_type: 'journal_line', record_id: l, amount: lineAmount.get(l) ?? 0, active: true });
      }
      await insertAll(db, 'rec_match', matches);
      await insertAll(db, 'rec_match_item', items);
      matchCount += matches.length;
    }
  }
  counts.bank_transactions_history = txCount;
  counts.rec_matches_history = matchCount;
  return recIds;
}

function deterministicUuid(key: string): string {
  const h = sha256Hex(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function loadBudgets(db: EkDb, data: SeedDataset, periods: string[]): Promise<void> {
  const T = data.ids.tenant;
  const historyEnd = addMonths(SCENARIO.openPeriod, -1);
  // Average monthly activity per entity/account/department over the closed months.
  const sums = new Map<string, number>();
  const months = periodRange(SCENARIO.firstPeriod, historyEnd).length;
  for (const j of data.journal) {
    if (j.periodKey > historyEnd || j.entity === 'CONSOL') continue;
    for (const l of j.lines) {
      if (!/^[4-8]/.test(l.acct) || l.acct === '7000') continue;
      const k = `${j.entity}|${l.acct}|${l.dept ?? ''}`;
      sums.set(k, (sums.get(k) ?? 0) + l.dr - l.cr);
    }
  }
  for (const entity of ['US', 'UK'] as const) {
    for (const fy of [2025, 2026]) {
      const b = await db.insert('budget', { tenant_id: T, entity_id: data.ids.entities[entity], name: `FY${fy} operating budget`, fiscal_year: fy, kind: 'budget', version: 'v1 (board approved)', status: 'approved', approved_by: data.ids.users.jordan, created_at: `${fy - 1}-12-15T18:00:00.000Z` });
      const rows: AnyRow[] = [];
      for (const p of periods.filter((x) => x.startsWith(String(fy)))) {
        const idx = periods.indexOf(p);
        for (const [k, total] of sums) {
          const [e, acct, dept] = k.split('|');
          if (e !== entity) continue;
          const avg = total / months;
          const growth = acct!.startsWith('4') ? 1 + 0.009 * (idx - 6) : 1 + 0.004 * (idx - 6);
          const amount = Math.round((avg * growth) / 10_000) * 10_000; // nearest $100
          if (amount === 0) continue;
          rows.push({ tenant_id: T, budget_id: b.id, account_id: data.ids.accounts[acct!]!, department_id: dept ? data.ids.departments[dept]! : null, period_key: p, amount });
        }
      }
      await insertAll(db, 'budget_line', rows);
    }
  }
}

async function insertTasks(db: EkDb, T: string, cycleId: string, p: string, cal: BusinessCalendar, ids: SeedDataset['ids'], mode: 'closed' | 'open'): Promise<Record<string, string>> {
  const taskIds: Record<string, string> = {};
  for (const [i, t] of CLOSE_TEMPLATE.entries()) {
    const due = cal.dateOf(p, t.workday);
    const prepared = at(due, '22:00');
    const reviewed = at(cal.dateOf(p, t.workday + 1), '17:30');
    const row = await db.insert('close_task', {
      tenant_id: T,
      close_cycle_id: cycleId,
      entity_id: t.entity ? ids.entities[t.entity] : null,
      code: t.code,
      title: t.title,
      description: t.description,
      category: t.category,
      workday: t.workday,
      due_date: due,
      owner_id: ids.users[t.owner],
      reviewer_id: ids.users[t.reviewer],
      status: mode === 'closed' ? 'complete' : 'not_started',
      skill_id: t.skill,
      skill_input: t.input,
      control_ref: t.control,
      prepared_by: mode === 'closed' ? ids.users[t.owner] : null,
      prepared_at: mode === 'closed' ? prepared : null,
      reviewed_by: mode === 'closed' ? ids.users[t.reviewer] : null,
      reviewed_at: mode === 'closed' ? reviewed : null,
      completed_at: mode === 'closed' ? reviewed : null,
      sort_order: i,
      created_at: at(addDays(periodEnd(p), -3), '16:00'),
    });
    taskIds[t.code] = row.id;
  }
  for (const t of CLOSE_TEMPLATE) for (const d of t.deps) await db.insert('close_task_dependency', { tenant_id: T, task_id: taskIds[t.code]!, depends_on_task_id: taskIds[d]! });
  if (mode === 'closed') {
    const sign: AnyRow[] = [];
    for (const t of CLOSE_TEMPLATE) {
      const due = cal.dateOf(p, t.workday);
      sign.push({ tenant_id: T, subject_type: 'close_task', subject_id: taskIds[t.code]!, role: 'preparer', user_id: ids.users[t.owner], signed_at: at(due, '22:00'), statement: 'Prepared', content_hash: null });
      sign.push({ tenant_id: T, subject_type: 'close_task', subject_id: taskIds[t.code]!, role: 'reviewer', user_id: ids.users[t.reviewer], signed_at: at(cal.dateOf(p, t.workday + 1), '17:30'), statement: 'Reviewed', content_hash: null });
    }
    await insertAll(db, 'signoff', sign);
  }
  return taskIds;
}

async function loadClosedMonth(db: EkDb, data: SeedDataset, p: string, cal: BusinessCalendar, bal: (e: EntityCode, a: string, through: string) => number, bankRecIds: Map<string, string>, clock: ManualClock): Promise<void> {
  const T = data.ids.tenant;
  const ids = data.ids;
  clock.set(at(cal.dateOf(p, 1), '15:00'));
  const cycle = await db.insert('close_cycle', { tenant_id: T, period_key: p, status: 'closed', target_workday: 5, started_at: at(cal.dateOf(p, 1), '15:00'), closed_at: at(cal.dateOf(p, 5), '23:00'), created_at: at(addDays(periodEnd(p), -3), '16:00') });
  await insertTasks(db, T, cycle.id, p, cal, ids, 'closed');
  const sign: AnyRow[] = [];
  for (const r of REC_TEMPLATE) {
    const acct = ACCOUNTS.find((a) => a.code === r.account)!;
    const normal = acct.normal ?? (acct.cls === 'asset' || acct.cls === 'expense' ? 'debit' : 'credit');
    const net = bal(r.entity, r.account, p);
    const natural = normal === 'debit' ? net : -net;
    const task = CLOSE_TEMPLATE.find((t) => t.code === r.task)!;
    const prepared = at(cal.dateOf(p, task.workday), '21:00');
    const reviewed = at(cal.dateOf(p, task.workday + 1), '17:00');
    let recId = r.bank ? bankRecIds.get(`${r.bank}:${p}`) : undefined;
    const fields = { status: 'reviewed' as const, gl_balance: natural, comparison_balance: natural, reconciling_total: 0, unexplained: 0, prepared_by: ids.users[r.owner], prepared_at: prepared, reviewed_by: ids.users[r.reviewer], reviewed_at: reviewed, updated_at: reviewed };
    if (recId) {
      await db.update('reconciliation', recId, fields);
    } else {
      recId = (
        await db.insert('reconciliation', {
          tenant_id: T,
          entity_id: ids.entities[r.entity],
          period_key: p,
          account_id: ids.accounts[r.account]!,
          rec_type: r.type,
          bank_account_id: null,
          counterparty_entity_id: r.counterparty ? ids.entities[r.counterparty] : null,
          risk: r.risk,
          tolerance: r.tolerance,
          notes: r.title,
          created_at: prepared,
          ...fields,
        })
      ).id;
    }
    const hash = sha256Hex(`${recId}|${natural}|${natural}|0`);
    sign.push({ tenant_id: T, subject_type: 'reconciliation', subject_id: recId, role: 'preparer', user_id: ids.users[r.owner], signed_at: prepared, statement: 'I certify this reconciliation is complete and every reconciling item is supported.', content_hash: hash });
    sign.push({ tenant_id: T, subject_type: 'reconciliation', subject_id: recId, role: 'reviewer', user_id: ids.users[r.reviewer], signed_at: reviewed, statement: 'Reviewed and agreed.', content_hash: hash });
  }
  await insertAll(db, 'signoff', sign);
}

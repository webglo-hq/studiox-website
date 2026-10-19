import { z } from 'zod';
import { addDays, addMonths, periodEnd, periodStart } from '../../../framework/util/dates';
import { BusinessCalendar } from '../../../framework/util/workdays';
import { detectGrni, detectRecurringGaps, detectSubsequentBills, payrollAccrual, type AccrualCandidate, type BillFact, type PayrollFact, type PoFact } from '../domain/accrual-math';
import { buildHistory, codeTransaction, type CodingAccount, type CodingEnv, type CodingResult } from '../domain/coding-engine';
import { memo } from '../domain/context';
import type { CompiledRule } from '../domain/policy-rules';
import { accounts, dimensionValues, entities } from '../domain/refdata';
import { depreciationForPeriod, serviceMonths } from '../domain/schedule-math';
import { closeOntology } from '../ontology';
import { Id } from '../ontology/shapes';
import { calendar, settings } from '../services/common';
import type { AgentCtx } from './context';
import { defineTool, type AnyTool } from './tool-kit';

// ------------------------------------------------------------------ shared

export interface CloseContextOut {
  periodKey: string;
  entities: { id: string; code: string; name: string; currency: string; isElimination: boolean; periodStatus: string }[];
  reportingCurrency: string;
  materiality: { overall: number; performance: number; clearlyTrivial: number };
  capitalizationThreshold: number;
  prepaidThreshold: number;
  today: string;
  policy: { autonomy: string; autoPostBelow: number; minConfidence: number; thresholds: Record<string, number> };
  task: { code: string; title: string; owner: string | null } | null;
}

export const getCloseContext = defineTool({
  name: 'get_close_context',
  description: 'The period being closed, entities and their period status, materiality, capitalisation/prepaid thresholds and the policy in force for this skill.',
  input: z.object({}),
  outputClass: 'ek:FiscalPeriod',
  permission: null,
  handler: async (ctx: AgentCtx): Promise<CloseContextOut> => {
    const s = await settings(ctx.svc);
    const ents = [...(await entities(ctx.svc)).values()];
    const periods = await ctx.svc.db.find('fiscal_period', { tenant_id: ctx.svc.tenantId, period_key: ctx.periodKey });
    const task = ctx.run.taskId ? await ctx.svc.db.get('close_task', ctx.run.taskId) : null;
    const owner = task?.owner_id ? await ctx.svc.db.get('app_user', task.owner_id) : null;
    return {
      periodKey: ctx.periodKey,
      entities: ents.map((e) => ({ id: e.id, code: e.code, name: e.name, currency: e.functional_currency, isElimination: e.is_elimination, periodStatus: periods.find((p) => p.entity_id === e.id)?.status ?? 'open' })),
      reportingCurrency: s.reportingCurrency,
      materiality: s.materiality,
      capitalizationThreshold: s.capitalizationThreshold,
      prepaidThreshold: s.prepaidThreshold,
      today: ctx.svc.clock.today(s.timezone),
      policy: { autonomy: ctx.policy.autonomy, autoPostBelow: ctx.policy.autoPostBelow, minConfidence: ctx.policy.minConfidence, thresholds: ctx.policy.thresholds },
      task: task ? { code: task.code, title: task.title, owner: owner?.display_name ?? null } : null,
    };
  },
});

export const readSkillResource = defineTool({
  name: 'read_skill_resource',
  description: 'Read one of this skill’s reference documents (progressive disclosure). Paths are listed in the skill manifest.',
  input: z.object({ path: z.string().min(1).max(200) }),
  permission: null,
  handler: async (ctx: AgentCtx, input: { path: string }) => {
    const content = ctx.skill.resources[input.path];
    if (content === undefined) throw new Error(`No resource ${input.path}. Available: ${Object.keys(ctx.skill.resources).join(', ') || 'none'}`);
    return { path: input.path, content };
  },
});

export const getChartOfAccounts = defineTool({
  name: 'get_chart_of_accounts',
  description: 'Chart of accounts (code, name, class, ontology concept, department requirement) and the department list.',
  input: z.object({ classes: z.array(z.enum(['asset', 'liability', 'equity', 'revenue', 'expense'])).optional() }),
  outputClass: 'ek:Account',
  permission: 'report.view',
  handler: async (ctx: AgentCtx, input: { classes?: string[] }) => {
    const accs = [...(await accounts(ctx.svc)).values()].filter((a) => a.is_active && (!input.classes || input.classes.includes(a.account_class)));
    const depts = await dimensionValues(ctx.svc, 'department');
    return {
      accounts: accs.map((a) => ({ id: a.id, code: a.code, name: a.name, class: a.account_class, type: a.account_type, concept: a.concept, requiresDepartment: a.requires_department, isControl: a.is_control_account })),
      departments: depts.map((d) => ({ id: d.id, code: d.code, name: d.name })),
    };
  },
});

// ------------------------------------------------------------------ card coding

export interface CardTxnOut {
  id: string;
  entityId: string;
  entityCode: string;
  date: string;
  merchant: string;
  mcc: string | null;
  memo: string | null;
  amount: number;
  currency: string;
  cardholder: string;
  cardholderDepartmentId: string | null;
  receipt: boolean;
  status: string;
  currentAccount: { id: string; code: string; name: string } | null;
  codingSource: string | null;
}

export const listCardTransactions = defineTool({
  name: 'list_card_transactions',
  description: 'Card transactions dated in the period. status "unposted" (default) returns uncoded and cardholder-coded items not yet in the ledger.',
  input: z.object({ status: z.enum(['uncoded', 'coded', 'unposted', 'all']).default('unposted'), limit: z.number().int().min(1).max(500).default(500), offset: z.number().int().min(0).default(0) }),
  outputClass: 'ek:CardTransaction',
  permission: 'report.view',
  untrustedFields: ['items[].merchant', 'items[].memo'],
  handler: async (ctx: AgentCtx, input: { status: 'uncoded' | 'coded' | 'unposted' | 'all'; limit: number; offset: number }) => {
    const statuses = input.status === 'unposted' ? ['uncoded', 'coded'] : input.status === 'all' ? ['uncoded', 'coded', 'posted', 'excluded'] : [input.status];
    const rows = await ctx.svc.db.find('card_transaction', { tenant_id: ctx.svc.tenantId, txn_date: { gte: periodStart(ctx.periodKey), lte: periodEnd(ctx.periodKey) }, status: { in: statuses as never[] } }, { orderBy: [['txn_date', 'asc'], ['external_id', 'asc']] });
    const accs = await accounts(ctx.svc);
    const ents = await entities(ctx.svc);
    const page = rows.slice(input.offset, input.offset + input.limit);
    return {
      total: rows.length,
      items: page.map(
        (r): CardTxnOut => ({
          id: r.id,
          entityId: r.entity_id,
          entityCode: ents.get(r.entity_id)?.code ?? '',
          date: r.txn_date,
          merchant: r.merchant_name,
          mcc: r.mcc,
          memo: r.memo,
          amount: r.amount,
          currency: r.currency,
          cardholder: r.cardholder_name,
          cardholderDepartmentId: r.cardholder_department_id,
          receipt: r.receipt_attached,
          status: r.status,
          currentAccount: r.account_id ? { id: r.account_id, code: accs.get(r.account_id)?.code ?? '', name: accs.get(r.account_id)?.name ?? '' } : null,
          codingSource: r.coding_source,
        }),
      ),
    };
  },
});

async function codingEnv(ctx: AgentCtx): Promise<CodingEnv> {
  return memo(ctx.svc, `coding-env:${ctx.policy.version}`, async () => {
    const s = await settings(ctx.svc);
    const accs = [...(await accounts(ctx.svc)).values()].filter((a) => a.is_active);
    const depts = await dimensionValues(ctx.svc, 'department');
    const hist = await ctx.svc.db.find('card_transaction', { tenant_id: ctx.svc.tenantId, status: 'posted', txn_date: { lt: periodStart(ctx.periodKey) } });
    const code = (c: string) => accs.find((a) => a.code === c)?.id;
    const codingAccounts: CodingAccount[] = accs.map((a) => ({ id: a.id, code: a.code, name: a.name, concept: a.concept, accountType: a.account_type, accountClass: a.account_class, isPostable: a.is_postable, requiresDepartment: a.requires_department }));
    return {
      ontology: closeOntology(),
      accounts: codingAccounts,
      history: buildHistory(hist.map((h) => ({ merchant: h.merchant_name, accountId: h.account_id, departmentId: h.department_id }))),
      rules: ctx.policy.rules as CompiledRule[],
      capitalizationThreshold: s.capitalizationThreshold,
      prepaidThreshold: s.prepaidThreshold,
      prepaidAccounts: Object.fromEntries(
        Object.entries({ 'ek:SoftwareExpense': code('1210'), 'ek:InsuranceExpense': code('1220'), '*': code('1200') }).filter((e): e is [string, string] => !!e[1]),
      ),
      fixedAssetAccountId: code('1500') ?? null,
      departmentNames: new Map(depts.map((d) => [d.id, d.name])),
    };
  });
}

export interface CodingSuggestion extends CodingResult {
  accountCode: string;
  accountName: string;
  departmentName: string | null;
  cardholderAccountId: string | null;
  alternativesNamed: { accountId: string; code: string; name: string; score: number }[];
}

export const suggestCoding = defineTool({
  name: 'suggest_coding',
  description: 'Deterministic coding engine: for up to 25 card transactions returns the suggested account, department, treatment (expense / prepaid / capitalise), confidence, basis and alternatives.',
  input: z.object({ transactionIds: z.array(Id).min(1).max(25) }),
  inputClass: 'ek:CardTransaction',
  outputClass: 'ek:CodingDecision',
  permission: 'report.view',
  handler: async (ctx: AgentCtx, input: { transactionIds: string[] }) => {
    const env = await codingEnv(ctx);
    const rows = await ctx.svc.db.find('card_transaction', { id: { in: input.transactionIds } });
    const accs = await accounts(ctx.svc);
    const results: CodingSuggestion[] = [];
    for (const r of rows) {
      if (r.tenant_id !== ctx.svc.tenantId) continue;
      const res = codeTransaction({ id: r.id, merchant: r.merchant_name, mcc: r.mcc, memo: r.memo, amount: r.amount, cardholder: r.cardholder_name, cardholderDepartmentId: r.cardholder_department_id }, env);
      const a = accs.get(res.accountId)!;
      results.push({
        ...res,
        previousAccountId: r.account_id,
        accountCode: a.code,
        accountName: a.name,
        departmentName: res.departmentId ? (env.departmentNames.get(res.departmentId) ?? null) : null,
        cardholderAccountId: r.coding_source === 'cardholder' ? r.account_id : null,
        alternativesNamed: (res.alternatives ?? []).map((x) => ({ accountId: x.accountId, code: accs.get(x.accountId)?.code ?? '', name: accs.get(x.accountId)?.name ?? '', score: x.score })),
      });
    }
    return { results };
  },
});

export const getCodingPolicy = defineTool({
  name: 'get_coding_policy',
  description: 'The controller’s plain-English coding rules (compiled, with explanations) and the auto-post thresholds.',
  input: z.object({}),
  outputClass: 'ek:Policy',
  permission: null,
  handler: async (ctx: AgentCtx) => {
    const s = await settings(ctx.svc);
    return {
      rules: (ctx.policy.rules as CompiledRule[]).map((r) => ({ line: r.line, source: r.source, explanation: r.explanation, kind: r.kind })),
      autoPostBelow: ctx.policy.autoPostBelow,
      minConfidence: ctx.policy.minConfidence,
      capitalizationThreshold: s.capitalizationThreshold,
      prepaidThreshold: s.prepaidThreshold,
    };
  },
});

// ------------------------------------------------------------------ accruals

export interface AccrualCandidateOut extends AccrualCandidate {
  entityId: string;
  entityCode: string;
  currency: string;
  accountCode: string | null;
  accountName: string | null;
  byDepartment?: { departmentId: string; amount: number }[];
  payroll?: { wages: number; taxes: number; days: number };
}

async function billFacts(ctx: AgentCtx, entityId: string): Promise<BillFact[]> {
  const bills = await ctx.svc.db.find('bill', { tenant_id: ctx.svc.tenantId, entity_id: entityId, bill_date: { gte: periodStart(addMonths(ctx.periodKey, -6)) } });
  const vendors = new Map((await ctx.svc.db.find('vendor', { tenant_id: ctx.svc.tenantId })).map((v) => [v.id, v.name]));
  return bills.filter((b) => b.status !== 'void').map((b) => ({ id: b.id, vendorId: b.vendor_id, vendorName: vendors.get(b.vendor_id) ?? 'Vendor', billNumber: b.bill_number, billDate: b.bill_date, amount: b.amount, serviceStart: b.service_start, serviceEnd: b.service_end, accountId: b.account_id, departmentId: b.department_id, poId: b.po_id }));
}

async function alreadyAccrued(ctx: AgentCtx, entityId: string): Promise<Set<string>> {
  const jes = await ctx.svc.db.find('journal_entry', { tenant_id: ctx.svc.tenantId, entity_id: entityId, period_key: ctx.periodKey, entry_type: 'accrual', status: 'posted' });
  const out = new Set<string>();
  for (const j of jes) {
    const ref = (j.source_ref ?? {}) as Record<string, unknown>;
    if (typeof ref.vendor === 'string') out.add(ref.vendor);
    if (typeof ref.key === 'string') out.add(ref.key);
  }
  return out;
}

export const detectAccrualCandidates = defineTool({
  name: 'detect_accrual_candidates',
  description: 'Runs the accrual detectors for every operating entity: goods/services received not invoiced (POs), bills received after month end for this month’s service, recurring vendors with no bill yet, and unpaid payroll. Returns candidates with amount, account, department, confidence and evidence.',
  input: z.object({}),
  outputClass: 'ek:Accrual',
  permission: 'report.view',
  handler: async (ctx: AgentCtx) => {
    const accs = await accounts(ctx.svc);
    const cal: BusinessCalendar = await calendar(ctx.svc);
    const lookback = ctx.policy.thresholds.lookbackMonths ?? 4;
    const minHits = ctx.policy.thresholds.minHits ?? 3;
    const out: AccrualCandidateOut[] = [];
    for (const e of [...(await entities(ctx.svc)).values()].filter((x) => !x.is_elimination)) {
      const bills = await billFacts(ctx, e.id);
      const accrued = await alreadyAccrued(ctx, e.id);
      const vendors = new Map((await ctx.svc.db.find('vendor', { tenant_id: ctx.svc.tenantId })).map((v) => [v.id, v.name]));
      const pos: PoFact[] = (await ctx.svc.db.find('purchase_order', { tenant_id: ctx.svc.tenantId, entity_id: e.id })).map((p) => ({ id: p.id, poNumber: p.po_number, vendorId: p.vendor_id, vendorName: vendors.get(p.vendor_id) ?? 'Vendor', amount: p.amount, status: p.status, receivedDate: p.received_date, serviceStart: p.service_start, serviceEnd: p.service_end, accountId: p.account_id, departmentId: p.department_id, description: p.description }));
      const grni = detectGrni(pos, bills, ctx.periodKey);
      const subsequent = detectSubsequentBills(bills, ctx.periodKey, accrued);
      const subsequentVendors = new Set(subsequent.map((c) => c.vendorId));
      // Recurring detection groups bills by service month, so a bill received after month end
      // for this month's service already counts; vendors covered by an exact bill are skipped.
      const recurring = detectRecurringGaps(bills, ctx.periodKey, lookback, minHits).filter((c) => !subsequentVendors.has(c.vendorId ?? ''));
      for (const c of [...grni, ...subsequent, ...recurring]) {
        if (c.vendorId && accrued.has(c.vendorId)) continue;
        const a = c.accountId ? accs.get(c.accountId) : undefined;
        out.push({ ...c, entityId: e.id, entityCode: e.code, currency: e.functional_currency, accountCode: a?.code ?? null, accountName: a?.name ?? null });
      }
      // Payroll (entities that run semi-monthly payroll)
      const runs = await ctx.svc.db.find('payroll_run', { tenant_id: ctx.svc.tenantId, entity_id: e.id, period_end: { gte: periodStart(addMonths(ctx.periodKey, -2)) } });
      const facts: PayrollFact[] = [];
      for (const r of runs) {
        const lines = await ctx.svc.db.find('payroll_line', { payroll_run_id: r.id });
        facts.push({ id: r.id, periodStart: r.period_start, periodEnd: r.period_end, payDate: r.pay_date, grossWages: r.gross_wages, employerTaxes: r.employer_taxes, benefits: r.benefits, byDepartment: lines.map((l) => ({ departmentId: l.department_id, gross: l.gross_wages, taxes: l.employer_taxes })) });
      }
      const pay = payrollAccrual(facts, ctx.periodKey, cal);
      if (pay && !accrued.has(`payroll:${e.id}:${ctx.periodKey}`)) {
        const wagesAcct = [...accs.values()].find((a) => a.code === '6000');
        out.push({
          kind: 'payroll',
          key: `payroll:${e.id}:${ctx.periodKey}`,
          vendorId: null,
          label: `${e.name} — payroll earned ${addDays(pay.ref.periodEnd, 1)} to ${periodEnd(ctx.periodKey)}, unpaid`,
          amount: pay.amountWages + pay.amountTaxes,
          accountId: wagesAcct?.id ?? null,
          departmentId: null,
          confidence: 0.93,
          basis: pay.basis,
          refs: [{ type: 'payroll_run', id: pay.ref.id, label: `Payroll ${pay.ref.periodStart} – ${pay.ref.periodEnd}` }],
          entityId: e.id,
          entityCode: e.code,
          currency: e.functional_currency,
          accountCode: '6000',
          accountName: wagesAcct?.name ?? 'Salaries & Wages',
          byDepartment: pay.byDepartment,
          payroll: { wages: pay.amountWages, taxes: pay.amountTaxes, days: pay.days },
        });
      }
    }
    return { periodKey: ctx.periodKey, candidates: out };
  },
});

export const listPurchaseOrders = defineTool({
  name: 'list_purchase_orders',
  description: 'Purchase orders with status, receipt date, service period and amount.',
  input: z.object({ status: z.enum(['open', 'received', 'billed', 'closed', 'cancelled']).optional() }),
  outputClass: 'ek:PurchaseOrder',
  permission: 'report.view',
  untrustedFields: ['items[].description'],
  handler: async (ctx: AgentCtx, input: { status?: string }) => {
    const rows = await ctx.svc.db.find('purchase_order', { tenant_id: ctx.svc.tenantId, ...(input.status ? { status: input.status as never } : {}) });
    const vendors = new Map((await ctx.svc.db.find('vendor', { tenant_id: ctx.svc.tenantId })).map((v) => [v.id, v.name]));
    return { items: rows.map((p) => ({ id: p.id, poNumber: p.po_number, vendor: vendors.get(p.vendor_id) ?? '', amount: p.amount, currency: p.currency, status: p.status, orderDate: p.order_date, receivedDate: p.received_date, serviceStart: p.service_start, serviceEnd: p.service_end, description: p.description })) };
  },
});

export const listRecentBills = defineTool({
  name: 'list_recent_bills',
  description: 'Vendor bills dated from 60 days before period end up to today, including bills received after month end.',
  input: z.object({ vendorId: Id.optional() }),
  outputClass: 'ek:Bill',
  permission: 'report.view',
  untrustedFields: ['items[].memo'],
  handler: async (ctx: AgentCtx, input: { vendorId?: string }) => {
    const rows = await ctx.svc.db.find('bill', { tenant_id: ctx.svc.tenantId, bill_date: { gte: addDays(periodEnd(ctx.periodKey), -60) }, ...(input.vendorId ? { vendor_id: input.vendorId } : {}) }, { orderBy: [['bill_date', 'asc']] });
    const vendors = new Map((await ctx.svc.db.find('vendor', { tenant_id: ctx.svc.tenantId })).map((v) => [v.id, v.name]));
    return { items: rows.map((b) => ({ id: b.id, vendor: vendors.get(b.vendor_id) ?? '', billNumber: b.bill_number, billDate: b.bill_date, amount: b.amount, serviceStart: b.service_start, serviceEnd: b.service_end, status: b.status, memo: b.memo })) };
  },
});

export const getPayrollRuns = defineTool({
  name: 'get_payroll_runs',
  description: 'Recent payroll runs per entity (pay date, pay period, gross wages, employer taxes, benefits).',
  input: z.object({}),
  outputClass: 'ek:PayrollRun',
  permission: 'report.view',
  handler: async (ctx: AgentCtx) => {
    const rows = await ctx.svc.db.find('payroll_run', { tenant_id: ctx.svc.tenantId, pay_date: { gte: periodStart(addMonths(ctx.periodKey, -2)) } }, { orderBy: [['pay_date', 'asc']] });
    const ents = await entities(ctx.svc);
    return { items: rows.map((r) => ({ id: r.id, entity: ents.get(r.entity_id)?.code ?? '', payDate: r.pay_date, periodStart: r.period_start, periodEnd: r.period_end, gross: r.gross_wages, employerTaxes: r.employer_taxes, benefits: r.benefits })) };
  },
});

// ------------------------------------------------------------------ prepaids

export interface ScheduleOut {
  id: string;
  entityId: string;
  description: string;
  total: number;
  startPeriod: string;
  months: number;
  prepaidAccount: { id: string; code: string; name: string };
  expenseAccount: { id: string; code: string; name: string };
  departmentId: string | null;
  status: string;
  dueThisPeriod: { id: string; periodKey: string; amount: number; status: string }[];
  missed: { id: string; periodKey: string; amount: number }[];
  remainingAfterPeriod: number;
}

export const listPrepaidSchedules = defineTool({
  name: 'list_prepaid_schedules',
  description: 'Active prepaid schedules with the line due this period and any earlier lines that were never posted (missed amortisation).',
  input: z.object({}),
  outputClass: 'ek:PrepaidSchedule',
  permission: 'report.view',
  handler: async (ctx: AgentCtx) => {
    const accs = await accounts(ctx.svc);
    const ref = (id: string) => ({ id, code: accs.get(id)?.code ?? '', name: accs.get(id)?.name ?? '' });
    const rows = await ctx.svc.db.find('prepaid_schedule', { tenant_id: ctx.svc.tenantId, status: 'active' });
    const out: ScheduleOut[] = [];
    for (const s of rows) {
      const lines = await ctx.svc.db.find('prepaid_line', { schedule_id: s.id }, { orderBy: [['period_key', 'asc']] });
      out.push({
        id: s.id,
        entityId: s.entity_id,
        description: s.description,
        total: s.total,
        startPeriod: s.start_period,
        months: s.months,
        prepaidAccount: ref(s.prepaid_account_id),
        expenseAccount: ref(s.expense_account_id),
        departmentId: s.department_id,
        status: s.status,
        dueThisPeriod: lines.filter((l) => l.period_key === ctx.periodKey).map((l) => ({ id: l.id, periodKey: l.period_key, amount: l.amount, status: l.status })),
        missed: lines.filter((l) => l.period_key < ctx.periodKey && l.status === 'scheduled').map((l) => ({ id: l.id, periodKey: l.period_key, amount: l.amount })),
        remainingAfterPeriod: s.total - lines.filter((l) => l.period_key <= ctx.periodKey).reduce((x, l) => x + l.amount, 0),
      });
    }
    return { periodKey: ctx.periodKey, schedules: out };
  },
});

export interface PrepaidCandidateOut {
  subjectType: 'bill';
  id: string;
  label: string;
  vendorId: string;
  vendorName: string;
  entityId: string;
  amount: number;
  serviceStart: string | null;
  serviceEnd: string | null;
  months: number;
  expenseAccount: { id: string; code: string; name: string };
  suggestedPrepaidAccount: { id: string; code: string; name: string };
  departmentId: string | null;
  journalEntryId: string | null;
  memo: string;
}

export const findPrepaidCandidates = defineTool({
  name: 'find_prepaid_candidates',
  description: 'Bills dated this period that were expensed although they cover more than one month of future service at or above the prepaid threshold.',
  input: z.object({}),
  outputClass: 'ek:PrepaidSchedule',
  permission: 'report.view',
  untrustedFields: ['candidates[].memo', 'candidates[].label'],
  handler: async (ctx: AgentCtx) => {
    const s = await settings(ctx.svc);
    const accs = await accounts(ctx.svc);
    const bills = await ctx.svc.db.find('bill', { tenant_id: ctx.svc.tenantId, bill_date: { gte: periodStart(ctx.periodKey), lte: periodEnd(ctx.periodKey) } });
    const vendors = new Map((await ctx.svc.db.find('vendor', { tenant_id: ctx.svc.tenantId })).map((v) => [v.id, v.name]));
    const scheduled = new Set((await ctx.svc.db.find('prepaid_schedule', { tenant_id: ctx.svc.tenantId })).map((x) => String((x.source_ref as Record<string, unknown> | null)?.id ?? '')));
    const out: PrepaidCandidateOut[] = [];
    for (const b of bills) {
      const a = b.account_id ? accs.get(b.account_id) : undefined;
      if (!a || a.account_class !== 'expense' || scheduled.has(b.id)) continue;
      const months = serviceMonths({ subjectType: 'bill', id: b.id, label: b.bill_number, amount: b.amount, serviceStart: b.service_start, serviceEnd: b.service_end, memo: b.memo ?? '' });
      if (!months || months < 2 || b.amount < s.prepaidThreshold) continue;
      // A purchase whose service is entirely inside the month is not a prepaid.
      if (b.service_end && b.service_end <= periodEnd(ctx.periodKey)) continue;
      const pp = [...accs.values()].find((x) => x.code === (a.concept === 'ek:SoftwareExpense' ? '1210' : a.concept === 'ek:InsuranceExpense' ? '1220' : '1200'))!;
      out.push({
        subjectType: 'bill',
        id: b.id,
        label: `${vendors.get(b.vendor_id) ?? 'Vendor'} ${b.bill_number}`,
        vendorId: b.vendor_id,
        vendorName: vendors.get(b.vendor_id) ?? 'Vendor',
        entityId: b.entity_id,
        amount: b.amount,
        serviceStart: b.service_start,
        serviceEnd: b.service_end,
        months,
        expenseAccount: { id: a.id, code: a.code, name: a.name },
        suggestedPrepaidAccount: { id: pp.id, code: pp.code, name: pp.name },
        departmentId: b.department_id,
        journalEntryId: b.journal_entry_id,
        memo: b.memo ?? '',
      });
    }
    return { periodKey: ctx.periodKey, threshold: s.prepaidThreshold, candidates: out };
  },
});

// ------------------------------------------------------------------ fixed assets

export const listFixedAssets = defineTool({
  name: 'list_fixed_assets',
  description: 'The fixed-asset register: cost, in-service date, life, department, and this period’s scheduled depreciation.',
  input: z.object({}),
  outputClass: 'ek:FixedAsset',
  permission: 'report.view',
  handler: async (ctx: AgentCtx) => {
    const assets = await ctx.svc.db.find('fixed_asset', { tenant_id: ctx.svc.tenantId }, { orderBy: [['tag', 'asc']] });
    return {
      items: assets.map((a) => ({ id: a.id, tag: a.tag, name: a.name, assetClass: a.asset_class, cost: a.cost, inServiceDate: a.in_service_date, usefulLifeMonths: a.useful_life_months, departmentId: a.department_id, status: a.status, depreciationThisPeriod: depreciationForPeriod({ id: a.id, tag: a.tag, name: a.name, cost: a.cost, salvage: a.salvage, usefulLifeMonths: a.useful_life_months, inServiceDate: a.in_service_date, departmentId: a.department_id, status: a.status }, ctx.periodKey) })),
    };
  },
});

export interface DepreciationOut {
  periodKey: string;
  entityId: string | null;
  total: number;
  alreadyPosted: number;
  byDepartment: { departmentId: string | null; departmentCode: string | null; amount: number; lineIds: string[] }[];
  lines: { id: string; assetId: string; tag: string; name: string; amount: number; departmentId: string | null; status: string }[];
}

export const computeDepreciation = defineTool({
  name: 'compute_depreciation',
  description: 'This period’s straight-line depreciation for every registered asset (scheduled lines), grouped by department, and how much is already posted.',
  input: z.object({}),
  outputClass: 'ek:DepreciationSchedule',
  permission: 'report.view',
  handler: async (ctx: AgentCtx): Promise<DepreciationOut> => {
    const lines = await ctx.svc.db.find('depreciation_line', { tenant_id: ctx.svc.tenantId, period_key: ctx.periodKey });
    const assets = new Map((await ctx.svc.db.find('fixed_asset', { tenant_id: ctx.svc.tenantId })).map((a) => [a.id, a]));
    const depts = new Map((await dimensionValues(ctx.svc, 'department')).map((d) => [d.id, d.code]));
    const scheduled = lines.filter((l) => l.status === 'scheduled');
    const groups = new Map<string, { departmentId: string | null; amount: number; lineIds: string[] }>();
    for (const l of scheduled) {
      const a = assets.get(l.fixed_asset_id);
      const k = a?.department_id ?? '';
      const g = groups.get(k) ?? { departmentId: a?.department_id ?? null, amount: 0, lineIds: [] };
      g.amount += l.amount;
      g.lineIds.push(l.id);
      groups.set(k, g);
    }
    const anyAsset = [...assets.values()][0];
    return {
      periodKey: ctx.periodKey,
      entityId: anyAsset?.entity_id ?? null,
      total: scheduled.reduce((s, l) => s + l.amount, 0),
      alreadyPosted: lines.filter((l) => l.status === 'posted').reduce((s, l) => s + l.amount, 0),
      byDepartment: [...groups.values()].map((g) => ({ ...g, departmentCode: g.departmentId ? (depts.get(g.departmentId) ?? null) : null })).sort((a, b) => (a.departmentCode ?? '').localeCompare(b.departmentCode ?? '')),
      lines: lines.map((l) => {
        const a = assets.get(l.fixed_asset_id);
        return { id: l.id, assetId: l.fixed_asset_id, tag: a?.tag ?? '', name: a?.name ?? '', amount: l.amount, departmentId: a?.department_id ?? null, status: l.status };
      }),
    };
  },
});

export interface CapCandidateOut {
  journalLineId: string;
  entryId: string;
  entryNumber: string;
  entityId: string;
  date: string;
  amount: number;
  accountId: string;
  accountCode: string;
  memo: string;
  departmentId: string | null;
  sourceRef: { type: string; id: string } | null;
  quantity: number;
}

export const findCapitalizationCandidates = defineTool({
  name: 'find_capitalization_candidates',
  description: 'Amounts posted this period to fixed-asset cost accounts that have no asset in the register yet.',
  input: z.object({}),
  outputClass: 'ek:FixedAsset',
  permission: 'report.view',
  untrustedFields: ['items[].memo'],
  handler: async (ctx: AgentCtx) => {
    const accs = await accounts(ctx.svc);
    const faAccounts = [...accs.values()].filter((a) => a.account_type === 'ek:FixedAssetAccount');
    const entries = await ctx.svc.db.find('journal_entry', { tenant_id: ctx.svc.tenantId, period_key: ctx.periodKey, status: 'posted' });
    const byId = new Map(entries.map((e) => [e.id, e]));
    const lines = entries.length ? await ctx.svc.db.find('journal_line', { journal_entry_id: { in: entries.map((e) => e.id) }, account_id: { in: faAccounts.map((a) => a.id) } }) : [];
    const registered = new Set((await ctx.svc.db.find('fixed_asset', { tenant_id: ctx.svc.tenantId })).map((a) => String((a.source_ref as Record<string, unknown> | null)?.journalLineId ?? '')));
    const items: CapCandidateOut[] = [];
    for (const l of lines) {
      if (l.debit <= 0 || registered.has(l.id)) continue;
      const e = byId.get(l.journal_entry_id)!;
      let memoText = l.memo ?? e.memo;
      let qty = 1;
      if (l.source_type === 'card_transaction' && l.source_id) {
        const c = await ctx.svc.db.get('card_transaction', l.source_id);
        if (c) {
          memoText = `${c.merchant_name} — ${c.memo ?? ''}`;
          const m = /\b(\d{1,3})\s*(?:x|units?|laptops?)\b/i.exec(c.memo ?? '');
          qty = m ? Number(m[1]) : 1;
        }
      }
      items.push({ journalLineId: l.id, entryId: e.id, entryNumber: e.entry_number, entityId: e.entity_id, date: e.entry_date, amount: l.debit, accountId: l.account_id, accountCode: accs.get(l.account_id)?.code ?? '', memo: memoText, departmentId: l.department_id, sourceRef: l.source_type && l.source_id ? { type: l.source_type, id: l.source_id } : null, quantity: qty });
    }
    return { periodKey: ctx.periodKey, items };
  },
});

export const SPEND_TOOLS: AnyTool[] = [
  getCloseContext,
  readSkillResource,
  getChartOfAccounts,
  listCardTransactions,
  suggestCoding,
  getCodingPolicy,
  detectAccrualCandidates,
  listPurchaseOrders,
  listRecentBills,
  getPayrollRuns,
  listPrepaidSchedules,
  findPrepaidCandidates,
  listFixedAssets,
  computeDepreciation,
  findCapitalizationCandidates,
];
